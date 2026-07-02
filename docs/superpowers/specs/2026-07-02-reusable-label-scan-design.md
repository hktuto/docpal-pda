# Reusable Label Scan Flow — Design

Date: 2026-07-02

## 1. Goal

Replace the five manual `*ScanModal.vue` components with a single, reusable camera-OCR scan flow:

- User taps a scan button in any task page.
- The OpenCV rectangle camera opens.
- User taps or shutters a label/document.
- Native side crops the region, runs ML Kit OCR, logs the recognized text to Android Logcat, and returns the cropped image path plus raw recognized text.
- Web layer parses the text into the existing `OcrInput` shape (`partNo`, `dateCode`, `lotCode`, `coo`, `cow`, `qty`), logs the capture to the browser console for debugging, runs the task-specific matcher, and either applies the match automatically or opens a shared review/edit modal.
- If there is no match, the user can edit the parsed fields or retake the image.

## 2. Scope

### In scope

- Native `RectangleDetection.scanLabel()` method.
- Reusable web composables:
  - `useLabelScan()` — orchestrates capture → parse → match.
  - `useRecognizedTextParser()` — turns raw OCR text into `OcrInput`.
  - `useScanMatchers()` — task-specific matching logic.
- Shared `LabelScanReviewModal.vue` component.
- Migration of the five task pages to the new flow.
- Deletion of the obsolete manual modals after migration.
- Hide the demo/testing pages from the home menu so only production warehouse flows are visible. Pages to hide: OCR Demo, Document Scanner Demo, Object Detection Demo, OpenCV Rectangle Stream, Subject Segmentation Demo.

### Out of scope

- Still-image `detectRectangles()` keeps its current behavior.
- Color output remains grayscale as decided in the rectangle-stream fixes.

## 3. User flow

```
Task page scan button
        │
        ▼
RectangleDetection.scanLabel()
        │
        ▼
OpenCV camera → tap/shutter crop
        │
        ▼
Native OCR on crop
        │
        ▼
Return { imagePath, text }
        │
        ▼
useLabelScan.parse() + match()
        │
        ▼
┌─────────────────┐
│  Single match?  │──Yes──▶ apply automatically ──▶ @applied
└─────────────────┘
        │ No
        ▼
LabelScanReviewModal
(image + editable fields + retake)
        │
        ▼
User edits / retakes / picks match ──▶ @applied
```

## 4. Native side

### 4.1 New Capacitor method

Add to `RectangleDetectionPlugin.java`:

```java
@PluginMethod
public void scanLabel(PluginCall call) {
    Intent intent = new Intent(getActivity(), RectangleCameraActivity.class);
    intent.putExtra(RectangleCameraActivity.EXTRA_MODE, RectangleCameraActivity.MODE_LABEL_SCAN);
    startActivityForResult(call, intent, "scanLabelResult");
}
```

Add a matching callback `scanLabelResult` that resolves with:

```json
{
  "imagePath": "/data/data/.../cache/rectangle_capture_crop_123.jpg",
  "text": "DOC PAL\nPN 12345\nLOT ABC123\n..."
}
```

### 4.2 RectangleCameraActivity changes

Add extras/constants:

```java
public static final String EXTRA_MODE = "mode";
public static final String MODE_DEFAULT = "default";
public static final String MODE_LABEL_SCAN = "label_scan";
```

When `MODE_LABEL_SCAN`:

- After `processTapCapture` or `captureRect` (in `RectanglePickerActivity`) produces a crop, run OCR on the crop before returning.
- Reuse the existing crop file path; do not duplicate the image.

### 4.3 Native OCR

Use ML Kit Text Recognition directly on Android:

```java
InputImage inputImage = InputImage.fromFilePath(context, Uri.fromFile(new File(imagePath)));
TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
recognizer.process(inputImage)
    .addOnSuccessListener(visionText -> finishWithResult(imagePath, visionText.getText()))
    .addOnFailureListener(e -> finishWithResult(imagePath, ""));
```

The dependency `com.google.mlkit:text-recognition:16.0.1` is already available via the patched `@pantrist/capacitor-plugin-ml-kit-text-recognition` plugin.

### 4.4 Cancellation

If the user cancels the camera or picker, reject the Capacitor call with message `"Cancelled"`.

## 5. Web side

### 5.1 Type definitions

```ts
export interface LabelScanCapture {
  imagePath: string;
  text: string;
}

export interface OcrInput {
  partNo: string;
  dateCode: string;
  lotCode: string;
  coo: string;
  cow: string;
  qty: number | "";
}

export interface ScanTaskContext {
  task: 'receiving' | 'picking' | 'put-away' | 'measuring' | 'goods-verify';
  receivingOrderId?: string;
  allocationId?: string;
  boxId?: string;
  shelfBoxId?: string;
}

export type LabelScanResult =
  | { status: 'applied' }
  | { status: 'review'; capture: LabelScanCapture; parsed: OcrInput; matchResult: MatchResult }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };
```

### 5.2 `useRectangleDetection.ts`

Extend the registered plugin interface:

```ts
interface RectangleDetectionPlugin {
  detectRectangles(options: DetectRectanglesOptions): Promise<DetectRectanglesResult>;
  startCameraStream(): Promise<CameraStreamCaptureResult>;
  scanLabel(): Promise<LabelScanCapture>;
  // ... listeners
}
```

### 5.3 `useRecognizedTextParser()`

New composable. Responsibilities:

- Accept raw multi-line OCR text.
- Extract part number, date code, lot code, origin country, COW code, and quantity using regex heuristics.
- Apply OCR-digit normalization (`O` → `0`, `I/L` → `1`, `Z` → `2`, `S` → `5`) to codes.
- Return a partial `OcrInput` matching the existing `useMockOcr` shape (`partNo`, `dateCode`, `lotCode`, `coo`, `cow`, `qty`); missing fields default to empty string / 1.
- Do not apply OCR-digit substitutions here; the matcher calls `useMockOcr.parseManual()` to normalize and validate the input.

Example heuristics:

- `PN?[:\s]*([A-Z0-9\-]+)` → `partNo`.
- `(?:DT|DATE|Date Code)[:\s]*([A-Z0-9]+)` → `dateCode`.
- `(?:LOT|Lot|lot)[:\s]*([A-Z0-9]+)` → `lotCode`.
- `(?:COO|Origin|Made in)[:\s]*([A-Z]{2,3})` → `coo`.
- `(?:COW|COW Code)[:\s]*([A-Z0-9]+)` → `cow`.
- `(?:QTY|Qty|Quantity)[:\s]*(\d+)` → `qty`.

Keep the parser dumb and permissive; the review modal lets the user fix mistakes.

### 5.4 `useScanMatchers()`

New composable. Exposes one matcher per task. Each matcher is stateless and calls the existing DB helpers directly, so `useLabelScan` does not depend on the reactive `useOcrPicking` composable.

- Each matcher first calls `useMockOcr().parseManual(parsed)` to validate `qty` and normalize codes.
- `matchReceiving` and `matchPicking` use `findReceivingCandidates`, `findPickingCandidates`, and `applyOcrPick` from `db/ocrPicking.ts`.
- `matchPutAway`, `matchMeasuring`, and `matchGoodsVerify` mirror the validation/queries currently inside `PutAwayScanModal.vue`, `MeasuringScanModal.vue`, and `GoodsVerifyScanModal.vue`.

```ts
export interface ScanMatchers {
  matchReceiving(db, receivingOrderId: string, parsed: OcrInput): Promise<MatchResult>;
  matchPicking(db, allocationId: string, parsed: OcrInput): Promise<MatchResult>;
  matchPutAway(db, receivingOrderId: string, parsed: OcrInput): Promise<MatchResult>;
  matchMeasuring(db, boxId: string, parsed: OcrInput): Promise<MatchResult>;
  matchGoodsVerify(db, shelfBoxId: string, parsed: OcrInput): Promise<MatchResult>;
}
```

`MatchResult` can be a union:

```ts
type MatchResult =
  | { type: 'single'; record: unknown; apply: () => Promise<void> }
  | { type: 'multiple'; records: unknown[] }
  | { type: 'none' }
  | { type: 'error'; message: string };
```

### 5.5 `useLabelScan()`

New composable. Orchestration:

```ts
async function scan(context: ScanTaskContext): Promise<LabelScanResult> {
  const capture = await RectangleDetection.scanLabel();
  const parsed = parseRecognizedText(capture.text);
  console.log("[useLabelScan] capture:", capture.imagePath, "text:", capture.text, "parsed:", parsed);
  const matchResult = await runMatcher(context, parsed);

  if (matchResult.type === 'single') {
    await matchResult.apply();
    return { status: 'applied' };
  }

  return { status: 'review', capture, parsed, matchResult };
}
```

Expose:

```ts
const { scan, scanning, error } = useLabelScan();
```

### 5.6 `LabelScanReviewModal.vue`

New shared component.

Props:

```ts
interface Props {
  modelValue: boolean;
  imagePath: string;
  text: string;
  parsed: OcrInput;
  matchResult: MatchResult;
  context: ScanTaskContext;
}
```

Emits:

```ts
interface Emits {
  (e: 'update:modelValue', value: boolean): void;
  (e: 'applied'): void;
  (e: 'retake'): void;
}
```

UI sections:

1. **Image preview** — `Capacitor.convertFileSrc(imagePath)`.
2. **Raw text** — collapsible textarea (useful for debugging OCR).
3. **Editable fields** — part, date, lot, COO, COW, qty inputs.
4. **Match area** —
   - Single match: show summary + **Apply** button.
   - Multiple matches: list with radio/select + **Apply selected**.
   - No match: "No matching record found."
5. **Actions** — **Find match** (re-run matcher with edited fields), **Retake** (emits retake), **Cancel**.

When the user edits fields, call `parseRecognizedText` is not needed; the fields are already the parsed input. The matcher re-runs with the updated `OcrInput`.

## 6. Task page migration

Each task page replaces its scan-button handler:

```vue
<script setup>
const { scan, scanning } = useLabelScan();
const review = ref<LabelScanResult | null>(null);
const reviewOpen = ref(false);

async function onScan() {
  review.value = null;
  const result = await scan({ task: 'picking', allocationId: String(props.allocation.id) });
  if (result.status === 'review') {
    review.value = result;
    reviewOpen.value = true;
  } else if (result.status === 'applied') {
    await reloadPageData();
  }
}

async function onApplied() {
  reviewOpen.value = false;
  await reloadPageData();
}

async function onRetake() {
  reviewOpen.value = false;
  await onScan();
}
</script>
```

Migration order:

1. Receiving (`pages/receiving/[id].vue`) — simplest because `useOcrPicking` already exists.
2. Picking (`pages/picking/[id].vue`).
3. Put-away (`pages/put-away/[id].vue`).
4. Measuring (`pages/measuring/[taskId]/box/[boxId].vue`).
5. Goods-verify (`pages/goods-verify/box/[id].vue`).

Delete the old manual modals only after all pages are migrated and tested.

## 7. Error handling

- Camera/OCR native error → `useLabelScan` returns `{ status: 'error', message }`.
- No text recognized → parser returns empty `OcrInput`; review modal opens immediately.
- Matcher error → review modal shows error state and lets user edit/retake.
- Apply error → show toast in modal; keep modal open so user can retry.

## 8. Testing strategy

1. Unit test `parseRecognizedText` with sample label texts.
2. Android unit tests for `RectangleCropper.orderPoints` remain relevant.
3. Manual device test for each task:
   - Successful scan → auto-apply.
   - No match → edit fields → find match → apply.
   - No match → retake.
   - Cancel at camera → parent page unchanged.
   - Cancel at review → parent page unchanged.

## 9. Files

### Create

- `composables/useLabelScan.ts`
- `composables/useRecognizedTextParser.ts`
- `composables/useScanMatchers.ts`
- `components/LabelScanReviewModal.vue`

### Modify

- `android/app/src/main/java/com/docpal/warehousedemo/RectangleDetectionPlugin.java`
- `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java`
- `composables/useRectangleDetection.ts`
- `pages/receiving/[id].vue`
- `pages/picking/[id].vue`
- `pages/put-away/[id].vue`
- `pages/measuring/[taskId]/box/[boxId].vue`
- `pages/goods-verify/box/[id].vue`

### Delete (after migration)

- `components/OcrScanModal.vue`
- `components/PickingScanModal.vue`
- `components/PutAwayScanModal.vue`
- `components/MeasuringScanModal.vue`
- `components/GoodsVerifyScanModal.vue`

## 10. Open questions

None at design time; all major choices were clarified before writing this spec.
