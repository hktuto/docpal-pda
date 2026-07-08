# QR Code Scan via PDA Hardware Scanner

## Goal

Let warehouse operators scan supplier QR codes on labels using the PDA's hardware scanner (keyboard wedge) while the camera-based rectangle-detection scan activity is open. When a QR code is scanned, the app returns the raw QR payload, parses it with a supplier-specific template, and uses the parsed fields to match and apply the scan.

## Context

- The app already has a native Android `RectangleCameraActivity` that runs OpenCV rectangle detection over a live preview.
- After the user taps a rectangle or presses the shutter, ML Kit OCR + barcode scanning run on the captured image.
- The target Android device is a PDA with a hardware barcode/QR scanner. The scanner behaves like a keyboard: it sends keystrokes to the focused view and ends the input with an Enter key.
- Different suppliers encode different fields in their QR codes. KOA uses a positional `:`-separated format with a custom quantity encoding.

## User flow

1. Operator opens a scan screen (receiving, picking, put-away, etc.).
2. The camera preview opens with rectangle detection running.
3. Operator points the PDA hardware scanner at the QR code and presses the scan trigger.
4. The scanner sends the QR payload as keystrokes, ending with Enter.
5. The activity immediately returns the QR payload to the web layer.
6. The web layer parses the payload using the matched supplier's template, finds the target item, and applies the scan (or shows review if ambiguous).

If the operator never uses the hardware scanner, the existing camera rectangle/OCR flow continues to work unchanged.

## Native Android changes

### `RectangleCameraActivity`

Add a hidden, focusable input view that receives keyboard-wedge input from the PDA scanner.

Behavior:
- The view requests focus in `onCreate`.
- Keystrokes are accumulated in a buffer.
- On `KEYCODE_ENTER`, the buffer is treated as a QR code scan result.
- The activity immediately finishes with:
  ```json
  {
    "imagePath": "",
    "text": "<raw qr payload>",
    "barcodes": "[{\"value\":\"<raw qr payload>\",\"format\":\"QR_CODE\"}]"
  }
  ```
- If a capture is already in progress (OCR running, picker open), ignore scanner input.
- The camera preview and rectangle analyzer keep running normally.

No ML Kit QR detection is added to the live preview; the hardware scanner is the QR input method.

## Database changes

Add two columns to the `suppliers` table:

```sql
qrcode_template text,
qrcode_qty_encoding text
```

Drizzle schema:

```typescript
export const suppliers = pgTable("suppliers", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  qrcodeTemplate: text("qrcode_template"),
  qrcodeQtyEncoding: text("qrcode_qty_encoding"),
});
```

Update the shared `Supplier` type in `services/types.ts` to include the new fields, and add a shared `SupplierQrcodeTemplate` DTO used by the parser and DB loader:

```typescript
export interface SupplierQrcodeTemplate {
  code: string;
  qrcodeTemplate: string;
  qrcodeQtyEncoding: string | null;
}
```

Seed KOA with:

```typescript
{
  code: "KOA",
  name: "KOA",
  qrcodeTemplate: "^:(?<itemId>[^:]+)::(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<ignore2>[^:]+):(?<fullName>.+)$",
  qrcodeQtyEncoding: "koa_zeros",
}
```

## QR payload parsing

### KOA format

Confirmed KOA QR payload structure:

```
:[itemId]::[qty]:[unknown]:[traceCode]:[unknown]:[fullName]
```

Quantity encoding (`koa_zeros`):
- The last digit of the qty field indicates the number of trailing zeros.
- Remove the last digit, treat the remaining prefix as the significant digits, then append that many zeros.
- Examples:
  - `53` → `5` + `000` = `5000`
  - `253` → `25` + `000` = `25000`
  - `14` → `1` + `0000` = `10000`

### General parsing algorithm

Add a new function `parseQrCapture(qrValue, options)` where `options` can include a known supplier template.

1. Normalize the QR value (trim whitespace).
2. If a supplier context is known (e.g., the receiving/picking order has a supplier), try that supplier's `qrcodeTemplate` first.
3. If no match, iterate over every supplier's `qrcodeTemplate` and use the first regex that matches and extracts an `itemId`.
4. Extract named groups: `itemId`, `qty`, `lotCode`, `dateCode`, `coo`, `cow`, `fullName`.
5. If the supplier has `qrcodeQtyEncoding === 'koa_zeros'`, decode the qty field.
6. Return a `ParsedFields` object compatible with the existing `OcrInput` shape.

If the QR value cannot be parsed by any template, fall back to the existing `parseAndIdentify()` logic so the raw string can still be matched by part-number heuristics.

## Web-layer integration

### `useLabelScan.ts`

In `processCapture()`:
- Detect a QR-only capture: `imagePath` is empty and there is exactly one barcode with format `QR_CODE`.
- If detected, call the new QR parser with the available supplier context.
- Use the parsed result in the existing matcher flow.

The existing `parseAndIdentify()` path remains the default for camera OCR/barcode captures.

### `parseOcrScan.ts`

Add:
- `parseQrCapture(value: string, supplierContext?: SupplierContext): OcrParseResult`
- `decodeKoaQty(encoded: string): number`
- Named-regex extraction helper.

Keep the existing OCR/barcode extraction functions unchanged.

## Error handling and edge cases

- **Hardware scanner fires during an active capture/picker:** ignore the input.
- **QR payload matches no supplier template:** fall back to generic part-number matching.
- **Item matched, but qty/lot fields missing:** show the review modal with available fields; let the operator fill in the rest.
- **Multiple supplier templates match:** use the first match and show review so the operator can confirm.
- **Browser simulation:** the existing browser prompt fallback can still accept a JSON payload with `text` and `barcodes`; the QR parser runs on it the same way.

## Testing

Add unit tests in `tests/parseOcrScan.test.ts` for:

- KOA QR decoding with `koa_zeros` qty expansion.
- Named regex extraction for item ID, qty, lot code, and full name.
- Fallback to generic matching when no supplier template matches.

Manual verification on Android:

1. Open a receiving scan.
2. Scan a KOA QR code with the PDA hardware scanner.
3. Confirm the item is matched and qty/lot code are parsed correctly.
4. Confirm the existing camera rectangle/OCR flow still works.

## Files touched

- `db/schema.ts`
- `db/seed.ts`
- `services/types.ts`
- `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java`
- `composables/useLabelScan.ts`
- `utils/parseOcrScan.ts`
- `tests/parseOcrScan.test.ts`

## Out of scope

- Camera-based QR decoding (replaced by hardware scanner).
- Barcode-only auto-scan via hardware scanner in this change (the hardware scanner will send whatever it reads; 1D barcodes will arrive as raw text too, but the first version treats the input as a QR payload and lets the parser decide).
- UI changes beyond showing parsed QR data in the existing review modal.
