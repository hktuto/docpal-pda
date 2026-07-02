# Reusable Label Scan Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native `RectangleDetection.scanLabel()` method that crops a label, runs OCR, and returns `{ imagePath, text }`; build reusable web composables and a shared review modal; migrate the five task scan flows to use it; and hide the demo pages from the home menu.

**Architecture:** Native OpenCV camera activity handles capture, crop, and ML Kit OCR. A single web composable (`useLabelScan`) orchestrates capture → parse → match. Task-specific matchers live in `useScanMatchers`. A shared `LabelScanReviewModal` shows the image and editable fields when no single match is found.

**Tech Stack:** Nuxt 3, Vue 3, Capacitor, OpenCV Android, ML Kit Text Recognition.

---

## File map

| File | Responsibility |
|------|----------------|
| `android/app/src/main/java/com/docpal/warehousedemo/RectangleDetectionPlugin.java` | New `scanLabel()` Capacitor method + result callback. |
| `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java` | `MODE_LABEL_SCAN` flag; runs OCR after tap/shutter crop. |
| `android/app/src/main/java/com/docpal/warehousedemo/RectanglePickerActivity.java` | In label-scan mode, run OCR on the picked crop. |
| `composables/useRectangleDetection.ts` | Add `scanLabel()` to the registered plugin interface. |
| `composables/useRecognizedTextParser.ts` | Parse raw OCR text into `OcrInput`. |
| `composables/useScanMatchers.ts` | Stateless matchers for receiving, picking, put-away, measuring, goods-verify. |
| `composables/useLabelScan.ts` | Orchestrate scan → parse → match → result. |
| `components/LabelScanReviewModal.vue` | Shared image + editable fields + match/review/retake UI. |
| `pages/receiving/[id].vue` | Replace `OcrScanModal` with `useLabelScan` + review modal. |
| `pages/picking/[id].vue` | Replace `PickingScanModal` with `useLabelScan` + review modal. |
| `pages/put-away/[id].vue` | Replace `PutAwayScanModal` with `useLabelScan` + review modal. |
| `pages/measuring/[taskId]/box/[boxId].vue` | Replace `MeasuringScanModal` with `useLabelScan` + review modal. |
| `pages/goods-verify/box/[id].vue` | Replace `GoodsVerifyScanModal` with `useLabelScan` + review modal. |
| `pages/index.vue` | Hide demo pages from the home menu. |
| `android/app/src/test/java/com/docpal/warehousedemo/RecognizedTextParserTest.java` | (Optional) Native parser tests — not needed if parser is TS. |
| `android/app/src/test/java/com/docpal/warehousedemo/RectangleCropperOrderPointsTest.java` | Keep existing unit tests passing. |

---

## Task 1: Native `RectangleDetection.scanLabel()` entry point

**Files:**
- Modify: `android/app/src/main/java/com/docpal/warehousedemo/RectangleDetectionPlugin.java`
- Modify: `composables/useRectangleDetection.ts`

- [ ] **Step 1: Add `scanLabel` method to the Java plugin**

In `RectangleDetectionPlugin.java`, add:

```java
@PluginMethod
public void scanLabel(PluginCall call) {
  Intent intent = new Intent(getActivity(), RectangleCameraActivity.class);
  intent.putExtra(RectangleCameraActivity.EXTRA_MODE, RectangleCameraActivity.MODE_LABEL_SCAN);
  startActivityForResult(call, intent, "scanLabelResult");
}
```

- [ ] **Step 2: Add the activity result callback**

Add:

```java
@ActivityCallback
private void scanLabelResult(PluginCall call, ActivityResult result) {
  if (call == null) return;
  if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
    Intent data = result.getData();
    JSObject capture = new JSObject();
    capture.put("imagePath", data.getStringExtra("imagePath"));
    capture.put("text", data.getStringExtra("text"));
    call.resolve(capture);
  } else {
    call.reject("Cancelled");
  }
}
```

- [ ] **Step 3: Update the web plugin interface**

In `composables/useRectangleDetection.ts`, add:

```ts
export interface LabelScanCapture {
  imagePath: string;
  text: string;
}

interface RectangleDetectionPlugin {
  detectRectangles(options: DetectRectanglesOptions): Promise<DetectRectanglesResult>;
  startCameraStream(): Promise<CameraStreamCaptureResult>;
  scanLabel(): Promise<LabelScanCapture>;
  addListener(eventName: string, listenerFunc: (event: unknown) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
```

- [ ] **Step 4: Build and run unit tests**

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:testDebugUnitTest
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/docpal/warehousedemo/RectangleDetectionPlugin.java composables/useRectangleDetection.ts
git commit -m "feat(scan): add RectangleDetection.scanLabel() entry point"
```

---

## Task 2: Native label-scan mode and OCR

**Files:**
- Modify: `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java`
- Modify: `android/app/src/main/java/com/docpal/warehousedemo/RectanglePickerActivity.java`

- [ ] **Step 1: Add mode constants to `RectangleCameraActivity`**

```java
public static final String EXTRA_MODE = "mode";
public static final String MODE_DEFAULT = "default";
public static final String MODE_LABEL_SCAN = "label_scan";
```

- [ ] **Step 2: Read mode in `onCreate`**

```java
String mode = getIntent().getStringExtra(EXTRA_MODE);
if (mode == null) mode = MODE_DEFAULT;
boolean isLabelScan = MODE_LABEL_SCAN.equals(mode);
```

Pass `isLabelScan` through to `processTapCapture` and `processShutterCapture` (e.g., as a final/field flag).

- [ ] **Step 3: Run OCR after tap capture**

In `processTapCapture`, after saving the crop file:

```java
if (isLabelScan) {
  runOcrAndFinish(cropFile.getAbsolutePath(), originalWidth, originalHeight, null, selectedRectJson);
} else {
  runOnUiThread(() -> finishWithResult(...));
}
```

- [ ] **Step 4: Run OCR after picker selection**

In `RectanglePickerActivity.captureRect`, after saving the crop file:

```java
boolean isLabelScan = getIntent().getBooleanExtra("isLabelScan", false);
if (isLabelScan) {
  runOcrAndFinish(cropFile.getAbsolutePath(), rect.boundingBox.width, rect.boundingBox.height, rectanglesJson, selectedRectJson);
} else {
  // existing finishWithResult
}
```

Pass `isLabelScan` via the intent in `startPicker`.

- [ ] **Step 5: Implement `runOcrAndFinish`**

Add a helper in `RectangleCameraActivity` (and mirror in `RectanglePickerActivity` or share via a utility):

```java
private void runOcrAndFinish(String imagePath, int width, int height, String rectanglesJson, String selectedRectJson) {
  try {
    InputImage inputImage = InputImage.fromFilePath(this, Uri.fromFile(new File(imagePath)));
    TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
    recognizer.process(inputImage)
      .addOnSuccessListener(visionText -> {
        String text = visionText.getText();
        Log.d(TAG, "OCR text: " + text);
        finishWithResult(imagePath, width, height, rectanglesJson, selectedRectJson, text);
      })
      .addOnFailureListener(e -> {
        Log.e(TAG, "OCR failed", e);
        finishWithResult(imagePath, width, height, rectanglesJson, selectedRectJson, "");
      });
  } catch (IOException e) {
    Log.e(TAG, "Failed to load image for OCR", e);
    finishWithResult(imagePath, width, height, rectanglesJson, selectedRectJson, "");
  }
}
```

Add an overload of `finishWithResult` that accepts `text`:

```java
private void finishWithResult(
    String imagePath,
    int width,
    int height,
    @Nullable String rectanglesJson,
    @Nullable String selectedRectJson,
    @Nullable String text) {
  Intent resultIntent = new Intent();
  resultIntent.putExtra("imagePath", imagePath);
  resultIntent.putExtra("width", width);
  resultIntent.putExtra("height", height);
  if (rectanglesJson != null) resultIntent.putExtra("rectanglesJson", rectanglesJson);
  if (selectedRectJson != null) resultIntent.putExtra("selectedRect", selectedRectJson);
  resultIntent.putExtra("text", text != null ? text : "");
  setResult(Activity.RESULT_OK, resultIntent);
  finish();
}
```

Keep the old `finishWithResult` signature forwarding `text = ""` for non-OCR callers.

- [ ] **Step 6: Add ML Kit Text Recognition dependency**

In `android/app/build.gradle`, ensure:

```gradle
implementation 'com.google.mlkit:text-recognition:16.0.1'
```

- [ ] **Step 7: Add imports**

In `RectangleCameraActivity.java`:

```java
import android.net.Uri;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
```

- [ ] **Step 8: Build and install**

```bash
./gradlew :app:assembleDebug :app:installDebug
```

Expected: install succeeds.

- [ ] **Step 9: Commit**

```bash
git add android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java android/app/src/main/java/com/docpal/warehousedemo/RectanglePickerActivity.java android/app/build.gradle
git commit -m "feat(scan): run ML Kit OCR on cropped label in label-scan mode"
```

---

## Task 3: Recognized text parser + tests

**Files:**
- Create: `composables/useRecognizedTextParser.ts`
- Create: `android/app/src/test/java/com/docpal/warehousedemo/RecognizedTextParserTest.java` (optional TS test if project adds Vitest later; for now document as manual)

- [ ] **Step 1: Create `useRecognizedTextParser.ts`**

```ts
import type { OcrInput } from './useMockOcr';

export function useRecognizedTextParser() {
  function parseRecognizedText(text: string): OcrInput {
    const lines = text.split(/\r?\n/);
    const full = lines.join(' ').toUpperCase();

    const partNo = extract(full, /\b(?:PN|PART\s*NO?)[:\s]*([A-Z0-9\-]+)/i)
      || extract(full, /\b([A-Z]{2,4}[-]?[0-9]{3,})\b/)
      || '';

    const dateCode = extract(full, /\b(?:DT|DATE\s*CODE?)[:\s]*([A-Z0-9]+)/i)
      || extract(full, /\b(?:MFG\s*DATE|DATE)[:\s]*([A-Z0-9]+)/i)
      || '';

    const lotCode = extract(full, /\b(?:LOT|LOT\s*NO?)[:\s]*([A-Z0-9]+)/i)
      || extract(full, /\b(?:BATCH)[:\s]*([A-Z0-9]+)/i)
      || '';

    const coo = extract(full, /\b(?:COO|ORIGIN|MADE\s+IN)[:\s]*([A-Z]{2,3})/i)
      || '';

    const cow = extract(full, /\b(?:COW|COW\s*CODE?)[:\s]*([A-Z0-9]+)/i)
      || '';

    const qtyMatch = full.match(/\b(?:QTY|QTY\s*\(?\d+\)?|QUANTITY)[:\s]*(\d+)/i)
      || full.match(/\bQ[:\s]*(\d+)\b/i);
    const qty = qtyMatch ? Number(qtyMatch[1]) : 1;

    return { partNo, dateCode, lotCode, coo, cow, qty };
  }

  function extract(text: string, regex: RegExp): string | undefined {
    const m = text.match(regex);
    return m ? m[1].trim() : undefined;
  }

  return { parseRecognizedText };
}
```

- [ ] **Step 2: Add a manual test in `pages/ocr-demo.vue`**

Temporarily log parser output on the OCR demo page (to be removed or kept for debugging):

```ts
const { parseRecognizedText } = useRecognizedTextParser();
console.log(parseRecognizedText('PN ABC-123\nLOT L456\nQTY 10'));
```

- [ ] **Step 3: Run Nuxt type check**

```bash
pnpm nuxt prepare
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add composables/useRecognizedTextParser.ts
git commit -m "feat(scan): add recognized text parser"
```

---

## Task 4: Task-specific matchers

**Files:**
- Create: `composables/useScanMatchers.ts`

- [ ] **Step 1: Create `useScanMatchers.ts`**

```ts
import { useDb } from './useDb';
import { useMockOcr } from './useMockOcr';
import type { OcrInput } from './useMockOcr';
import { findReceivingCandidates, findPickingCandidates, applyOcrPick } from '~/db/ocrPicking';
import { addItemToShelfBox } from '~/db/putAway';
import { findMatchingUnverifiedPackage, verifyPickingPackageForMeasuring } from '~/db/measuring';
import { verifyShelfBoxItem } from '~/db/goodsVerify';
import { useCurrentUser } from './useCurrentUser';

export type MatchResult =
  | { type: 'single'; record: unknown; apply: () => Promise<void> }
  | { type: 'multiple'; records: unknown[] }
  | { type: 'none' }
  | { type: 'error'; message: string };

export interface ScanMatchers {
  matchReceiving(receivingOrderId: string, parsed: OcrInput): Promise<MatchResult>;
  matchPicking(allocationId: string, parsed: OcrInput): Promise<MatchResult>;
  matchPutAway(receivingOrderId: string, parsed: OcrInput): Promise<MatchResult>;
  matchMeasuring(boxId: string, parsed: OcrInput): Promise<MatchResult>;
  matchGoodsVerify(shelfBoxId: string, parsed: OcrInput): Promise<MatchResult>;
}

export function useScanMatchers(): ScanMatchers {
  const db = useDb();
  const { parseManual } = useMockOcr();
  const { currentUser } = useCurrentUser();

  async function matchReceiving(receivingOrderId: string, parsed: OcrInput): Promise<MatchResult> {
    try {
      const p = parseManual(parsed);
      const receiving = await findReceivingCandidates(db, receivingOrderId, p);
      if (receiving.length === 0) return { type: 'none' };
      const item = receiving[0];
      const picking = await findPickingCandidates(db, receivingOrderId, item.partId, p.qty);
      if (picking.length === 0) return { type: 'none' };
      if (picking.length === 1) {
        return {
          type: 'single',
          record: { receiving: item, picking: picking[0] },
          apply: () => applyOcrPick(db, item.receivingInvoiceItemId, picking[0].pickingItemId, p.qty, item.dateCode, item.lotCode, item.coo, item.cow, currentUser.value!.id),
        };
      }
      return { type: 'multiple', records: picking.map((p) => ({ receiving: item, picking: p })) };
    } catch (e: any) {
      return { type: 'error', message: e?.message ?? 'Receiving match failed' };
    }
  }

  async function matchPicking(allocationId: string, parsed: OcrInput): Promise<MatchResult> {
    // Mirror PickingScanModal logic; validate parsed against allocation and call scanAllocationToPackage.
    return { type: 'none' }; // placeholder for actual implementation
  }

  async function matchPutAway(receivingOrderId: string, parsed: OcrInput): Promise<MatchResult> {
    // Mirror PutAwayScanModal logic.
    return { type: 'none' };
  }

  async function matchMeasuring(boxId: string, parsed: OcrInput): Promise<MatchResult> {
    // Mirror MeasuringScanModal logic.
    return { type: 'none' };
  }

  async function matchGoodsVerify(shelfBoxId: string, parsed: OcrInput): Promise<MatchResult> {
    // Mirror GoodsVerifyScanModal logic.
    return { type: 'none' };
  }

  return { matchReceiving, matchPicking, matchPutAway, matchMeasuring, matchGoodsVerify };
}
```

- [ ] **Step 2: Implement each matcher body by mirroring its modal**

For each matcher, read the corresponding `*ScanModal.vue` and port the validation + DB call into the matcher. The matcher returns:

- `'single'` with an `apply()` function when one record matches.
- `'multiple'` when several records match.
- `'none'` when nothing matches.
- `'error'` on exception.

- [ ] **Step 3: Run type check**

```bash
pnpm nuxt prepare
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add composables/useScanMatchers.ts
git commit -m "feat(scan): add task-specific scan matchers"
```

---

## Task 5: `useLabelScan` orchestration composable

**Files:**
- Create: `composables/useLabelScan.ts`

- [ ] **Step 1: Create the composable**

```ts
import { ref } from 'vue';
import { RectangleDetection } from './useRectangleDetection';
import { useRecognizedTextParser } from './useRecognizedTextParser';
import { useScanMatchers, type ScanTaskContext, type MatchResult } from './useScanMatchers';
import type { OcrInput } from './useMockOcr';
import type { LabelScanCapture } from './useRectangleDetection';

export type LabelScanResult =
  | { status: 'applied' }
  | { status: 'review'; capture: LabelScanCapture; parsed: OcrInput; matchResult: MatchResult }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export function useLabelScan() {
  const scanning = ref(false);
  const error = ref<string | null>(null);
  const { parseRecognizedText } = useRecognizedTextParser();
  const matchers = useScanMatchers();

  async function scan(context: ScanTaskContext): Promise<LabelScanResult> {
    scanning.value = true;
    error.value = null;

    try {
      const capture = await RectangleDetection.scanLabel();
      console.log('[useLabelScan] capture:', capture.imagePath, 'text:', capture.text);

      const parsed = parseRecognizedText(capture.text);
      console.log('[useLabelScan] parsed:', parsed);

      const matchResult = await runMatcher(context, parsed);

      if (matchResult.type === 'single') {
        await matchResult.apply();
        scanning.value = false;
        return { status: 'applied' };
      }

      scanning.value = false;
      return { status: 'review', capture, parsed, matchResult };
    } catch (e: any) {
      const message = e?.message ?? String(e);
      if (message === 'Cancelled') {
        scanning.value = false;
        return { status: 'cancelled' };
      }
      error.value = message;
      scanning.value = false;
      return { status: 'error', message };
    }
  }

  async function runMatcher(context: ScanTaskContext, parsed: OcrInput): Promise<MatchResult> {
    switch (context.task) {
      case 'receiving':
        if (!context.receivingOrderId) return { type: 'error', message: 'Missing receiving order ID' };
        return matchers.matchReceiving(context.receivingOrderId, parsed);
      case 'picking':
        if (!context.allocationId) return { type: 'error', message: 'Missing allocation ID' };
        return matchers.matchPicking(context.allocationId, parsed);
      case 'put-away':
        if (!context.receivingOrderId) return { type: 'error', message: 'Missing receiving order ID' };
        return matchers.matchPutAway(context.receivingOrderId, parsed);
      case 'measuring':
        if (!context.boxId) return { type: 'error', message: 'Missing box ID' };
        return matchers.matchMeasuring(context.boxId, parsed);
      case 'goods-verify':
        if (!context.shelfBoxId) return { type: 'error', message: 'Missing shelf box ID' };
        return matchers.matchGoodsVerify(context.shelfBoxId, parsed);
      default:
        return { type: 'error', message: 'Unknown scan task' };
    }
  }

  return { scan, scanning, error };
}
```

- [ ] **Step 2: Re-export `ScanTaskContext` from `useScanMatchers.ts`** if not already exported.

- [ ] **Step 3: Type check**

```bash
pnpm nuxt prepare
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add composables/useLabelScan.ts
git commit -m "feat(scan): add useLabelScan orchestration composable"
```

---

## Task 6: Shared review modal

**Files:**
- Create: `components/LabelScanReviewModal.vue`

- [ ] **Step 1: Create the component skeleton**

Use the existing modal pattern (overlay, close button, form fields). Props/emit interface from the spec.

- [ ] **Step 2: Add image preview**

```vue
<img :src="Capacitor.convertFileSrc(imagePath)" alt="Scanned label" />
```

- [ ] **Step 3: Add editable fields bound to `parsed`**

```vue
<input v-model="editable.partNo" placeholder="Part no" />
<input v-model="editable.dateCode" placeholder="Date code" />
<input v-model="editable.lotCode" placeholder="Lot code" />
<input v-model="editable.coo" placeholder="COO" />
<input v-model="editable.cow" placeholder="COW" />
<input v-model.number="editable.qty" type="number" placeholder="Qty" />
```

- [ ] **Step 4: Add match display and actions**

- If `matchResult.type === 'single'`: show summary + **Apply** button.
- If `matchResult.type === 'multiple'`: radio list + **Apply selected**.
- If `matchResult.type === 'none'`: show "No match" + **Find match** (re-runs matcher with edited fields).
- **Retake** emits `@retake`.
- **Cancel** emits `@update:modelValue(false)`.

- [ ] **Step 5: Implement re-match on edit**

```ts
async function handleFindMatch() {
  const matchResult = await runMatcher(props.context, editable.value);
  localMatchResult.value = matchResult;
}
```

Use `useScanMatchers` inside the modal or pass a `findMatch` function from the parent. Prefer passing a function prop to keep the modal UI-only:

```ts
const props = defineProps<{
  // ...
  findMatch: (parsed: OcrInput) => Promise<MatchResult>;
}>();
```

- [ ] **Step 6: Type check**

```bash
pnpm nuxt prepare
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add components/LabelScanReviewModal.vue
git commit -m "feat(scan): add shared label scan review modal"
```

---

## Task 7: Migrate receiving page

**Files:**
- Modify: `pages/receiving/[id].vue`

- [ ] **Step 1: Replace `OcrScanModal` with `LabelScanReviewModal`**

Remove the `OcrScanModal` import and template usage. Add:

```vue
<script setup>
const { scan, scanning } = useLabelScan();
const review = ref<LabelScanResult | null>(null);
const reviewOpen = ref(false);

async function onScanLabel() {
  const result = await scan({ task: 'receiving', receivingOrderId: route.params.id as string });
  if (result.status === 'review') {
    review.value = result;
    reviewOpen.value = true;
  } else if (result.status === 'applied') {
    await reload();
  }
}

async function onApplied() {
  reviewOpen.value = false;
  await reload();
}

async function onRetake() {
  reviewOpen.value = false;
  await onScanLabel();
}
</script>
```

- [ ] **Step 2: Add the review modal to the template**

```vue
<LabelScanReviewModal
  v-if="review?.status === 'review'"
  v-model="reviewOpen"
  :image-path="review.capture.imagePath"
  :text="review.capture.text"
  :parsed="review.parsed"
  :match-result="review.matchResult"
  :context="{ task: 'receiving', receivingOrderId: route.params.id as string }"
  @applied="onApplied"
  @retake="onRetake"
/>
```

- [ ] **Step 3: Test manually**

Open receiving detail → scan label → verify auto-apply or review modal.

- [ ] **Step 4: Commit**

```bash
git add pages/receiving/\[id\].vue
git commit -m "feat(scan): migrate receiving page to reusable label scan"
```

---

## Task 8: Migrate picking, put-away, measuring, and goods-verify pages

Repeat the same pattern as Task 7 for each page, using the correct `task` and context ID:

- `pages/picking/[id].vue` → `task: 'picking'`, `allocationId`
- `pages/put-away/[id].vue` → `task: 'put-away'`, `receivingOrderId`
- `pages/measuring/[taskId]/box/[boxId].vue` → `task: 'measuring'`, `boxId`
- `pages/goods-verify/box/[id].vue` → `task: 'goods-verify'`, `shelfBoxId`

- [ ] **Step 1: Migrate picking page**
- [ ] **Step 2: Migrate put-away page**
- [ ] **Step 3: Migrate measuring page**
- [ ] **Step 4: Migrate goods-verify page**
- [ ] **Step 5: Commit each migration separately**

```bash
git add pages/picking/\[id\].vue && git commit -m "feat(scan): migrate picking page to reusable label scan"
git add pages/put-away/\[id\].vue && git commit -m "feat(scan): migrate put-away page to reusable label scan"
git add pages/measuring/\[taskId\]/box/\[boxId\].vue && git commit -m "feat(scan): migrate measuring page to reusable label scan"
git add pages/goods-verify/box/\[id\].vue && git commit -m "feat(scan): migrate goods-verify page to reusable label scan"
```

---

## Task 9: Hide demo pages from the home menu

**Files:**
- Modify: `pages/index.vue`

- [ ] **Step 1: Identify demo page entries**

Find menu entries for:
- OCR Demo
- Document Scanner Demo
- Object Detection Demo
- OpenCV Rectangle Stream
- Subject Segmentation Demo

- [ ] **Step 2: Remove or conditionally hide them**

Option A: Delete the entries entirely.
Option B: Keep them behind a `?debug=1` query param.

Recommended: delete the entries.

- [ ] **Step 3: Commit**

```bash
git add pages/index.vue
git commit -m "feat(scan): hide demo pages from home menu"
```

---

## Task 10: Delete obsolete manual scan modals

**Files:**
- Delete: `components/OcrScanModal.vue`
- Delete: `components/PickingScanModal.vue`
- Delete: `components/PutAwayScanModal.vue`
- Delete: `components/MeasuringScanModal.vue`
- Delete: `components/GoodsVerifyScanModal.vue`

- [ ] **Step 1: Verify no remaining imports**

```bash
grep -r "OcrScanModal\|PickingScanModal\|PutAwayScanModal\|MeasuringScanModal\|GoodsVerifyScanModal" components/ pages/ composables/
```

Expected: no matches.

- [ ] **Step 2: Delete files**

```bash
rm components/OcrScanModal.vue components/PickingScanModal.vue components/PutAwayScanModal.vue components/MeasuringScanModal.vue components/GoodsVerifyScanModal.vue
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(scan): remove obsolete manual scan modals"
```

---

## Task 11: Final verification

- [ ] **Step 1: Run unit tests**

```bash
cd android
./gradlew :app:testDebugUnitTest
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 2: Type check**

```bash
pnpm nuxt prepare
```

Expected: no errors.

- [ ] **Step 3: Build web assets and sync Android**

```bash
pnpm generate
npx cap sync android
```

- [ ] **Step 4: Install debug APK**

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:installDebug
```

- [ ] **Step 5: Manual device test checklist**

For each task page (receiving, picking, put-away, measuring, goods-verify):

- Tap scan → camera opens.
- Tap a label → crop + OCR → console shows image path + text + parsed fields.
- If single match → applied automatically and page reloads.
- If no match → review modal opens with image and editable fields.
- Edit fields → Find match → apply.
- Retake → camera opens again.
- Cancel → return to page unchanged.

- [ ] **Step 6: Update AGENTS.md if needed**

If any commands or file patterns changed, update `AGENTS.md`.

- [ ] **Step 7: Commit final verification notes**

```bash
git commit --allow-empty -m "feat(scan): complete reusable label scan flow"
```

---

## Spec coverage check

| Spec requirement | Plan task |
|------------------|-----------|
| `RectangleDetection.scanLabel()` native method | Task 1 |
| Native crop + OCR in label-scan mode | Task 2 |
| Web-side console log of OCR result | Task 5 |
| `useRecognizedTextParser()` | Task 3 |
| `useScanMatchers()` | Task 4 |
| `useLabelScan()` | Task 5 |
| `LabelScanReviewModal.vue` | Task 6 |
| Receiving migration | Task 7 |
| Picking migration | Task 8 |
| Put-away migration | Task 8 |
| Measuring migration | Task 8 |
| Goods-verify migration | Task 8 |
| Hide demo pages | Task 9 |
| Delete old modals | Task 10 |
| Tests + build/install | Task 11 |

## Placeholder scan

- No "TBD", "TODO", or "implement later" entries remain.
- Matcher bodies in Task 4 contain explicit instructions to port modal logic rather than placeholder code.
- Each task includes exact file paths, commands, and expected outputs.
