# QR Code Scan via PDA Hardware Scanner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PDA hardware-scanner QR input to the existing camera scan activity and parse supplier-specific QR payloads using a per-supplier regex template and optional qty encoding.

**Architecture:** The native `RectangleCameraActivity` intercepts keyboard-wedge scanner input and returns the raw QR string with an empty image path. The web layer detects a QR-only capture, loads supplier QR templates from the DB, runs them against the raw string, and feeds the parsed fields into the existing scan-matching flow.

**Tech Stack:** Nuxt 3, Vue 3, TypeScript, PGlite/Drizzle, Java (Android), ML Kit/CameraX/OpenCV already present.

---

## File structure

| File | Responsibility |
|------|----------------|
| `db/schema.ts` | Add `qrcodeTemplate` and `qrcodeQtyEncoding` columns to `suppliers`. |
| `db/seed.ts` | Seed KOA supplier with its QR template and qty encoding. |
| `db/suppliers.ts` | New helper: load all suppliers that have a QR template. |
| `services/types.ts` | Add `qrcodeTemplate` and `qrcodeQtyEncoding` to the shared `Supplier` type. |
| `utils/parseOcrScan.ts` | New QR parser + KOA qty decoder; keep existing OCR/barcode parsers. |
| `tests/parseOcrScan.test.ts` | Unit tests for KOA QR decoding and fallback behavior. |
| `composables/useLabelScan.ts` | Detect QR-only capture and route to the QR parser. |
| `android/app/src/main/res/layout/activity_rectangle_camera.xml` | Add hidden scanner input view. |
| `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java` | Hardware scanner input handling + early finish with QR payload. |

---

## Task 1: Extend supplier schema and types

**Files:**
- Modify: `db/schema.ts`
- Modify: `db/init.ts`
- Modify: `services/types.ts`
- Modify: `db/seed.ts`

- [ ] **Step 1: Add columns to Drizzle suppliers table**

In `db/schema.ts`, update the `suppliers` table:

```typescript
export const suppliers = pgTable("suppliers", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  qrcodeTemplate: text("qrcode_template"),
  qrcodeQtyEncoding: text("qrcode_qty_encoding"),
});
```

- [ ] **Step 2: Update raw SQL bootstrap in `db/init.ts`**

In `db/init.ts`, update the `suppliers` table DDL to include the new columns:

```sql
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  qrcode_template TEXT,
  qrcode_qty_encoding TEXT
);
```

- [ ] **Step 3: Add fields to shared Supplier type**

In `services/types.ts`, update the `Supplier` interface:

```typescript
export interface Supplier {
  id: string;
  code: string;
  name: string;
  qrcodeTemplate: string | null;
  qrcodeQtyEncoding: string | null;
}

export interface SupplierQrcodeTemplate {
  code: string;
  qrcodeTemplate: string;
  qrcodeQtyEncoding: string | null;
}
```

- [ ] **Step 4: Seed KOA template**

In `db/seed.ts`, change the KOA supplier record from:

```typescript
{ id: uuid(), code: "KOA", name: "KOA" },
```

to:

```typescript
{
  id: uuid(),
  code: "KOA",
  name: "KOA",
  qrcodeTemplate: "^:(?<itemId>[^:]+)::(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<ignore2>[^:]+):(?<fullName>.+)$",
  qrcodeQtyEncoding: "koa_zeros",
},
```

- [ ] **Step 5: Commit**

```bash
git add db/schema.ts db/init.ts services/types.ts db/seed.ts
git commit -m "feat(qr): add supplier qrcode_template and qrcode_qty_encoding"
```

---

## Task 2: Add supplier QR template loader

**Files:**
- Create: `db/suppliers.ts`

- [ ] **Step 1: Create `db/suppliers.ts`**

```typescript
import { useDb } from "~/composables/useDb";
import { suppliers } from "./schema";
import { isNotNull } from "drizzle-orm";
import type { SupplierQrcodeTemplate } from "~/services/types";

export async function getSuppliersWithQrTemplates(): Promise<SupplierQrcodeTemplate[]> {
  const db = useDb();
  const rows = await db
    .select({
      code: suppliers.code,
      qrcodeTemplate: suppliers.qrcodeTemplate,
      qrcodeQtyEncoding: suppliers.qrcodeQtyEncoding,
    })
    .from(suppliers)
    .where(isNotNull(suppliers.qrcodeTemplate));

  return rows.map((r) => ({
    code: r.code,
    qrcodeTemplate: r.qrcodeTemplate!,
    qrcodeQtyEncoding: r.qrcodeQtyEncoding ?? null,
  }));
}
```

- [ ] **Step 2: Commit**

```bash
git add db/suppliers.ts
git commit -m "feat(qr): add getSuppliersWithQrTemplates loader"
```

---

## Task 3: Implement QR parser and KOA qty decoder

**Files:**
- Modify: `utils/parseOcrScan.ts`
- Modify: `tests/parseOcrScan.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/parseOcrScan.test.ts`:

```typescript
import { decodeKoaQty, parseQrCapture } from "~/utils/parseOcrScan";

describe("decodeKoaQty", () => {
  it("expands qty using last digit as zero count", () => {
    expect(decodeKoaQty("53")).toBe(5000);
    expect(decodeKoaQty("253")).toBe(25000);
    expect(decodeKoaQty("14")).toBe(10000);
  });

  it("returns undefined for invalid input", () => {
    expect(decodeKoaQty("")).toBeUndefined();
    expect(decodeKoaQty("abc")).toBeUndefined();
  });
});

describe("parseQrCapture", () => {
  const koaTemplate = {
    code: "KOA",
    qrcodeTemplate: "^:(?<itemId>[^:]+)::(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<ignore2>[^:]+):(?<fullName>.+)$",
    qrcodeQtyEncoding: "koa_zeros" as const,
  };

  it("parses KOA QR payload and expands qty", () => {
    const result = parseQrCapture(
      ":RK73H2ATTD2403F::253:M:63048349:S613:KOA*RK73H2ATTD 2403F",
      [koaTemplate],
      ["RK73H2ATTD2403F"]
    );

    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe("RK73H2ATTD2403F");
    expect(result.parsed.qty).toBe(25000);
    expect(result.parsed.lotCode).toBe("63048349");
  });

  it("returns no match when QR value does not fit any template", () => {
    const result = parseQrCapture("SOME-RANDOM-STRING", [koaTemplate], ["RK73H2ATTD2403F"]);
    expect(result.matched).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test tests/parseOcrScan.test.ts
```

Expected: tests fail because `decodeKoaQty` and `parseQrCapture` are not exported.

- [ ] **Step 3: Implement decoder and parser in `utils/parseOcrScan.ts`**

Import the shared type at the top of `utils/parseOcrScan.ts`:

```typescript
import type { SupplierQrcodeTemplate } from "~/services/types";
```

Add to `utils/parseOcrScan.ts`:

```typescript
export function decodeKoaQty(encoded: string): number | undefined {
  if (!/^\d+$/.test(encoded)) return undefined;
  if (encoded.length < 2) return undefined;
  const zeroCount = Number(encoded.slice(-1));
  const prefix = encoded.slice(0, -1);
  if (!Number.isFinite(zeroCount) || zeroCount < 0) return undefined;
  return Number(prefix) * Math.pow(10, zeroCount);
}

function extractNamedGroups(regex: RegExp, value: string): Record<string, string> | null {
  const match = regex.exec(value);
  if (!match || !match.groups) return null;
  return match.groups;
}

export function parseQrCapture(
  qrValue: string,
  supplierTemplates: SupplierQrcodeTemplate[],
  targets: string | string[] = []
): OcrParseResult {
  const targetArray = Array.isArray(targets) ? targets : [targets];
  const normalizedQr = qrValue.trim();

  for (const supplier of supplierTemplates) {
    try {
      const regex = new RegExp(supplier.qrcodeTemplate, "u");
      const groups = extractNamedGroups(regex, normalizedQr);
      if (!groups || !groups.itemId) continue;

      const normalizedItemId = collapseSpaces(groups.itemId.toUpperCase());
      const itemMatch = targetArray.length === 0 ||
        targetArray.some((t) => collapseSpaces(t.toUpperCase()) === normalizedItemId);

      if (!itemMatch) continue;

      let qty: number | undefined;
      if (groups.qty) {
        if (supplier.qrcodeQtyEncoding === "koa_zeros") {
          qty = decodeKoaQty(groups.qty);
        } else {
          const n = Number(groups.qty);
          if (Number.isInteger(n) && n > 0) qty = n;
        }
      }

      return {
        matched: true,
        parsed: {
          itemId: normalizedItemId,
          qty,
          lotCode: groups.lotCode ?? undefined,
          dateCode: groups.dateCode ?? undefined,
          coo: groups.coo ?? undefined,
          cow: groups.cow ?? undefined,
        },
        options: {
          itemIds: [normalizedItemId],
          qtys: qty !== undefined ? [qty] : [],
          lotCodes: groups.lotCode ? [groups.lotCode] : [],
          dateCodes: groups.dateCode ? [groups.dateCode] : [],
          coos: groups.coo ? [groups.coo] : [],
          cows: groups.cow ? [groups.cow] : [],
        },
        raw: { text: qrValue, barcodes: [] },
      };
    } catch {
      // Ignore invalid regex templates.
    }
  }

  return {
    matched: false,
    parsed: { itemId: null },
    options: { itemIds: [], qtys: [], lotCodes: [], dateCodes: [], coos: [], cows: [] },
    raw: { text: qrValue, barcodes: [] },
  };
}
```

Note: `collapseSpaces` is already defined in the same file.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test tests/parseOcrScan.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add utils/parseOcrScan.ts tests/parseOcrScan.test.ts
git commit -m "feat(qr): add KOA QR parser and qty decoder"
```

---

## Task 4: Route QR-only captures through the parser

**Files:**
- Modify: `composables/useLabelScan.ts`

- [ ] **Step 1: Modify `processCapture` to detect and parse QR-only captures**

In `composables/useLabelScan.ts`, import the new helpers and supplier loader:

```typescript
import { parseQrCapture } from "~/utils/parseOcrScan";
import { getSuppliersWithQrTemplates } from "~/db/suppliers";
```

Add a helper to detect QR-only hardware scans. The native layer serializes ML Kit's QR code format as the integer string `"4"`:

```typescript
const QR_CODE_FORMAT = "4";

function isQrOnlyCapture(capture: LabelScanCapture): boolean {
  if (capture.imagePath) return false;
  const barcodes = parseBarcodes(capture.barcodes);
  return barcodes.length === 1 && barcodes[0].format === QR_CODE_FORMAT;
}
```

Update `processCapture`:

```typescript
async function processCapture(
  capture: LabelScanCapture,
  context: ScanTaskContext
): Promise<LabelScanResult> {
  let parsedResult: OcrParseResult;

  if (isQrOnlyCapture(capture)) {
    const barcodes = parseBarcodes(capture.barcodes);
    const qrValue = barcodes[0]?.value ?? capture.text;
    const suppliers = await getSuppliersWithQrTemplates();
    parsedResult = parseQrCapture(qrValue, suppliers, context.targets ?? []);

    if (!parsedResult.matched) {
      parsedResult = parseAndIdentify(
        { text: qrValue, barcodes: [] },
        context.targets ?? []
      );
    }
  } else {
    const barcodes = parseBarcodes(capture.barcodes);
    parsedResult = parseAndIdentify(
      { text: capture.text, barcodes },
      context.targets ?? []
    );
  }

  const parsed = ocrResultToInput(parsedResult.parsed);
  const matchResult = await runScanMatcher(context, parsed, matchers);

  if (matchResult.type === "error") {
    return { status: "error", message: matchResult.message };
  }

  if (matchResult.type === "single" && !context.confirmSingleMatch) {
    await matchResult.apply();
    return { status: "applied" };
  }

  return {
    status: "review",
    capture,
    parsed,
    options: parsedResult.options,
    matchResult,
  };
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
pnpm nuxt prepare
pnpm nuxt typecheck
```

Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add composables/useLabelScan.ts
git commit -m "feat(qr): route QR-only captures through supplier template parser"
```

---

## Task 5: Native Android hardware scanner input

**Files:**
- Modify: `android/app/src/main/res/layout/activity_rectangle_camera.xml`
- Modify: `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java`

- [ ] **Step 1: Add hidden scanner input view to layout**

In `android/app/src/main/res/layout/activity_rectangle_camera.xml`, add inside the root `FrameLayout` (before the button `LinearLayout` is fine):

```xml
    <EditText
        android:id="@+id/scannerInput"
        android:layout_width="1dp"
        android:layout_height="1dp"
        android:layout_gravity="top|start"
        android:background="@android:color/transparent"
        android:cursorVisible="false"
        android:focusable="true"
        android:focusableInTouchMode="true"
        android:inputType="text"
        android:textColor="@android:color/transparent"
        android:visibility="invisible" />
```

- [ ] **Step 2: Implement scanner input handling in `RectangleCameraActivity`**

Add imports at the top:

```java
import android.view.KeyEvent;
import android.widget.EditText;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
```

Add fields:

```java
private EditText scannerInput;
private final StringBuilder scannerBuffer = new StringBuilder();
```

In `onCreate`, after `setContentView`:

```java
scannerInput = findViewById(R.id.scannerInput);
scannerInput.requestFocus();
```

Add a method to finish with QR result:

```java
private void finishWithQrResult(String qrValue) {
  Intent resultIntent = new Intent();
  resultIntent.putExtra("imagePath", "");
  resultIntent.putExtra("text", qrValue);

  JSONArray barcodes = new JSONArray();
  JSONObject barcode = new JSONObject();
  try {
    barcode.put("value", qrValue);
    barcode.put("format", "4");
  } catch (JSONException e) {
    // Ignore serialization errors for individual fields.
  }
  barcodes.put(barcode);
  resultIntent.putExtra("barcodes", barcodes.toString());

  setResult(Activity.RESULT_OK, resultIntent);
  finish();
}
```

Override `dispatchKeyEvent`:

```java
@Override
public boolean dispatchKeyEvent(KeyEvent event) {
  if (event.getAction() == KeyEvent.ACTION_DOWN) {
    int keyCode = event.getKeyCode();

    if (keyCode == KeyEvent.KEYCODE_ENTER) {
      if (captureMode != CaptureMode.NONE || scannerBuffer.length() == 0) {
        return super.dispatchKeyEvent(event);
      }
      String qrValue = scannerBuffer.toString();
      scannerBuffer.setLength(0);
      finishWithQrResult(qrValue);
      return true;
    }

    int unicode = event.getUnicodeChar();
    if (unicode >= 32 && unicode < 127) {
      if (captureMode == CaptureMode.NONE) {
        scannerBuffer.append((char) unicode);
      }
      return true;
    }
  }
  return super.dispatchKeyEvent(event);
}
```

- [ ] **Step 3: Build the Android project**

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:assembleDebug
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/res/layout/activity_rectangle_camera.xml android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java
git commit -m "feat(qr): add hardware scanner input to RectangleCameraActivity"
```

---

## Task 6: Verification

**Files:** all touched files.

- [ ] **Step 1: Run unit tests**

```bash
pnpm test tests/parseOcrScan.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run Nuxt prepare**

```bash
pnpm nuxt prepare
```

Expected: types generate without errors.

- [ ] **Step 3: Run Android unit tests**

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:testDebugUnitTest
```

Expected: tests pass.

- [ ] **Step 4: Manual browser check**

1. `pnpm dev`
2. Log in as `operator` / `DocPal2026!`.
3. Navigate to a receiving order with KOA items.
4. Use the browser scan simulator and paste a QR JSON like:
   ```json
   {"text": ":RK73H2ATTD2403F::253:M:63048349:S613:KOA*RK73H2ATTD 2403F", "barcodes": [{"value": ":RK73H2ATTD2403F::253:M:63048349:S613:KOA*RK73H2ATTD 2403F", "format": "4"}]}
   ```
5. Confirm the review modal shows item ID `RK73H2ATTD2403F`, qty `25000`, lot code `63048349`.

- [ ] **Step 5: Commit any final fixes**

```bash
git commit -am "fix(qr): verification fixes" || true
```

---

## Spec coverage check

| Spec requirement | Task |
|------------------|------|
| Hardware scanner input in native activity | Task 5 |
| Empty `imagePath` for QR scans | Task 5 (`finishWithQrResult`) |
| Supplier `qrcode_template` column | Task 1 |
| Supplier `qrcode_qty_encoding` column | Task 1 |
| KOA seed template and `koa_zeros` | Task 1 |
| Parse QR with supplier templates | Task 3 |
| KOA qty decoder | Task 3 |
| Route QR-only capture in `useLabelScan` | Task 4 |
| Browser simulation still works | Task 4, Task 6 |
| Unit tests | Task 3 |

## Placeholder scan

No placeholders found. All steps include exact file paths, code, and commands.

## Type consistency check

- `SupplierQrcodeTemplate` interface is defined in `services/types.ts` and used by `db/suppliers.ts` and `utils/parseOcrScan.ts`.
- `decodeKoaQty` returns `number | undefined`; parser only pushes qty into options when defined.
- `LabelScanCapture` shape is unchanged; QR path sets `imagePath: ""`.
