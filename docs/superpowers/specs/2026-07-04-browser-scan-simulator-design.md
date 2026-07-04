# Browser Scan Simulator Design

Date: 2026-07-04

## Goal

Add a browser-only scan simulator so developers can exercise the full scan → parse → match → review flow without an Android device or Google Play Services. In a browser, the scan button will open a `prompt()` where the developer pastes a JSON string containing OCR text and barcodes; this is converted to the same `LabelScanCapture` shape the native layer uses, so the rest of the web app runs unchanged.

## Background

- The native scan flow uses ML Kit Text Recognition and Barcode Scanning inside an Android activity. It returns `{ imagePath, text, barcodes }` to the web layer.
- The current web fallback (`composables/useRectangleDetection.ts`) throws `SCAN_NOT_AVAILABLE_MESSAGE` when `RectangleDetection.scanLabel()` is called in a browser.
- `useLabelScan.ts` catches that error and returns `{ status: 'manual' }`, which opens `LabelScanReviewModal` with empty fields.
- This makes end-to-end browser testing tedious: every field must be typed manually, and the OCR/barcode parsing path is never exercised.

## Scope

### In scope

1. Add a browser fallback path in `composables/useLabelScan.ts` that uses `window.prompt()` to accept a JSON string.
2. Parse the JSON into a `LabelScanCapture`.
3. Continue through the normal parse → match → review pipeline.
4. Update docs.

### Out of scope

- Real OCR or barcode detection in the browser.
- Custom simulator modal or component.
- Image upload.
- Preset/canned test labels (can be added later).
- Changes to native Android code.

## API

### Prompt JSON schema

The text entered into `prompt()` must be a JSON object with two fields:

```json
{
  "text": "PART NO: ABC123\nDATE CODE: 2026-07-04",
  "barcodes": [
    { "value": "ABC123", "format": "CODE_128" }
  ]
}
```

- `text` — raw OCR text. Use `\n` for line breaks.
- `barcodes` — array of objects, each with `value` and `format` strings.

The helper converts this to the existing `LabelScanCapture` shape:

```ts
interface LabelScanCapture {
  imagePath: string;
  text: string;
  barcodes: string; // JSON-stringified array
}
```

### `parseBrowserScanPromptJson(raw: string): LabelScanCapture | null`

A small helper (inline in `useLabelScan.ts` or in `utils/parseBrowserScanPromptJson.ts`) that:

1. Parses the raw string with `JSON.parse`.
2. Validates that `text` is a string and `barcodes` is an array of `{ value: string, format: string }`.
3. Returns `{ imagePath: '', text, barcodes: JSON.stringify(barcodes) }` or `null` if invalid.

## Data flow

```
User taps Scan in browser
        │
        ▼
useLabelScan.scan(context)
        │
        ▼
RectangleDetection.scanLabel() throws SCAN_NOT_AVAILABLE_MESSAGE
        │
        ▼
window.prompt('Paste scan JSON...')
        │
        ├──▶ Cancel ──▶ { status: 'cancelled' }
        │
        └──▶ JSON submitted
                 │
                 ▼
        parseBrowserScanPromptJson(raw)
                 │
                 ├──▶ Invalid ──▶ { status: 'error', message: 'Invalid scan JSON' }
                 │
                 └──▶ Valid LabelScanCapture
                          │
                          ▼
                    parseAndIdentify(...)
                          │
                          ▼
                    runScanMatcher(...)
                          │
                          ▼
              auto-apply or LabelScanReviewModal
```

## UI design

The simulator uses the browser's native `prompt()` dialog.

- **Message:** short instruction, e.g. `Paste scan JSON (text + barcodes):`.
- **Default value:** a sample JSON string showing the expected format, so a developer can edit it.
- **Cancel:** scan returns `{ status: 'cancelled' }`.
- **OK with invalid JSON:** scan returns `{ status: 'error', message: 'Invalid scan JSON' }`.
- **OK with valid JSON:** continues through the normal pipeline.

## Integration in `useLabelScan.ts`

The current web-fallback branch:

```ts
if (isBrowserUnavailableError(e)) {
  return { status: 'manual' };
}
```

will be replaced with code that:

1. Calls `window.prompt()`.
2. Returns `{ status: 'cancelled' }` if the user cancels.
3. Parses the submitted string; returns `{ status: 'error', message: 'Invalid scan JSON' }` if parsing fails.
4. On valid input, continues through the normal parse → match path with the synthetic capture.

To avoid duplication, the capture-processing logic (`parseBarcodes`, `parseAndIdentify`, `ocrResultToInput`, `runScanMatcher`) should be extracted into a helper such as `processCapture(capture, context)` so both the native success path and the simulated path use the same pipeline.

## Edge cases

- **Native (Capacitor) environment:** `RectangleDetection.scanLabel()` succeeds; the prompt path is never hit.
- **Browser cancel:** behaves the same as cancelling the camera on Android.
- **Invalid JSON or wrong shape:** scan returns an error status.
- **Empty text:** `parseAndIdentify` returns empty candidates; the review modal opens with empty fields (same as today's manual mode).
- **Missing or empty barcodes:** treated as an empty array.

## Testing strategy

1. **Unit test**
   - Test `parseBrowserScanPromptJson` with valid input, invalid JSON, missing `text`, missing `barcodes`, and malformed barcode items.

2. **Type check**
   - Run `pnpm nuxt prepare` after modifying `useLabelScan.ts`.

3. **Manual browser check**
   - Run `pnpm dev`.
   - Log in and navigate to a flow with a Scan button.
   - Tap Scan.
   - Verify the browser prompt opens with sample JSON.
   - Paste or edit the JSON and confirm.
   - Verify `LabelScanReviewModal` opens with parsed fields and candidate chips.

## Files

### Create

- None (the helper can live inline or in `utils/parseBrowserScanPromptJson.ts` if preferred).

### Modify

- `composables/useLabelScan.ts` — replace `manual` fallback with prompt + JSON parser; extract capture processing helper.
- `docs/app-docs/flows/picking/label-scan.md` — mention browser prompt simulator for testing.
- `docs/app-docs/ai/code-map.md` — mention the changed fallback behavior if relevant.

## Open questions

None at design time.
