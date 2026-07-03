# Browser Scan Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `RectangleDetection.scanLabel()` is unavailable in the browser, automatically fall back to a manual-entry form inside `LabelScanReviewModal` so the user can type label fields and find a matching record.

**Architecture:** `useLabelScan.scan()` detects the browser-unavailable error and returns a new `'manual'` status. A shared `createManualReview()` helper builds an empty review object. Each scanning page handles `'manual'` by opening `LabelScanReviewModal` with that empty object. The modal hides the retake button and relabels the title when there is no captured image.

**Tech Stack:** Nuxt 3, Vue 3, TypeScript, Capacitor.

---

## File structure

- `composables/useLabelScan.ts` — detect browser-unavailable error, add `'manual'` status, export `createManualReview()` helper.
- `components/LabelScanReviewModal.vue` — add `mode` prop, adjust title and retake button for manual entry.
- `pages/receiving/[id].vue` — handle `'manual'` status and pass `:mode` to modal.
- `pages/picking/[id].vue` — handle `'manual'` status and pass `:mode` to modal.
- `pages/put-away/[id].vue` — handle `'manual'` status and pass `:mode` to modal.
- `pages/goods-verify/box/[id].vue` — handle `'manual'` status and pass `:mode` to modal.
- `pages/measuring/[taskId]/box/[boxId].vue` — handle `'manual'` status and pass `:mode` to modal.

---

### Task 1: Update `useLabelScan.ts`

**Files:**
- Modify: `composables/useLabelScan.ts`

- [ ] **Step 1: Update `LabelScanResult` type**

```ts
export type LabelScanResult =
  | { status: 'applied' }
  | { status: 'review'; capture: LabelScanCapture; parsed: OcrInput; matchResult: ScanMatchResult }
  | { status: 'manual' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };
```

- [ ] **Step 2: Add `createManualReview()` helper after `LabelScanResult`**

```ts
export function createManualReview(): Extract<LabelScanResult, { status: 'review' }> {
  return {
    status: 'review',
    capture: { imagePath: '', text: '', barcodes: '[]' },
    parsed: { partNo: '', dateCode: '', lotCode: '', coo: '', cow: '', qty: '' },
    matchResult: { type: 'none' },
  };
}
```

- [ ] **Step 3: Detect browser-unavailable error in `scan()`**

Inside the `catch` block of `scan()`, replace the cancellation check with the following so the browser-unavailable error becomes `'manual'` instead of `'error'`:

```ts
} catch (e: unknown) {
  if (isCancellationError(e)) {
    return { status: 'cancelled' };
  }
  if (isBrowserUnavailableError(e)) {
    return { status: 'manual' };
  }
  const message = e instanceof Error ? e.message : String(e);
  error.value = message;
  return { status: 'error', message };
}
```

- [ ] **Step 4: Add `isBrowserUnavailableError()` helper**

Add this function next to `isCancellationError()`:

```ts
function isBrowserUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes('not available in the browser');
}
```

- [ ] **Step 5: Commit**

```bash
git add composables/useLabelScan.ts
git commit -m "feat(scan): return manual status when scanner unavailable in browser"
```

---

### Task 2: Update `LabelScanReviewModal.vue`

**Files:**
- Modify: `components/LabelScanReviewModal.vue`

- [ ] **Step 1: Add `mode` prop**

```ts
const props = defineProps<{
  modelValue: boolean;
  imagePath: string;
  text: string;
  barcodes: string;
  parsed: OcrInput;
  matchResult: ScanMatchResult;
  context: ScanTaskContext;
  mode?: 'review' | 'manual';
}>();
```

- [ ] **Step 2: Compute title from mode**

In the template, replace the static title:

```vue
<h3 id="review-title">{{ mode === 'manual' ? 'Manual entry' : 'Review scan' }}</h3>
```

- [ ] **Step 3: Hide retake button in manual mode**

Wrap the retake button:

```vue
<button
  v-if="mode !== 'manual'"
  type="button"
  class="btn btn--secondary"
  :disabled="applying || matching"
  @click="emit('retake')"
>
  Retake
</button>
```

- [ ] **Step 4: Commit**

```bash
git add components/LabelScanReviewModal.vue
git commit -m "feat(scan): support manual entry mode in review modal"
```

---

### Task 3: Update `pages/receiving/[id].vue`

**Files:**
- Modify: `pages/receiving/[id].vue`

- [ ] **Step 1: Import `createManualReview`**

Change the import line from:

```ts
import { useLabelScan, type LabelScanResult } from "~/composables/useLabelScan";
```

to:

```ts
import { useLabelScan, createManualReview, type LabelScanResult } from "~/composables/useLabelScan";
```

- [ ] **Step 2: Pass `:mode` to `LabelScanReviewModal`**

Add the `:mode` binding on the modal:

```vue
<LabelScanReviewModal
  v-if="review?.status === 'review'"
  v-model="reviewOpen"
  :image-path="review.capture.imagePath"
  :text="review.capture.text"
  :barcodes="review.capture.barcodes"
  :parsed="review.parsed"
  :match-result="review.matchResult"
  :mode="review.capture.imagePath ? 'review' : 'manual'"
  :context="{ task: 'receiving', receivingOrderId: orderId, pickingItemId: scanPickingItemId }"
  @applied="onApplied"
  @retake="onRetake"
/>
```

- [ ] **Step 3: Handle `'manual'` status in `openScan()`**

Inside `openScan(itemId?: string)`, add a branch after `'review'`:

```ts
} else if (result.status === 'manual') {
  review.value = createManualReview();
  scanPickingItemId.value = itemId;
  reviewOpen.value = true;
} else if (result.status === 'error') {
```

- [ ] **Step 4: Commit**

```bash
git add pages/receiving/[id].vue
git commit -m "feat(receiving): fall back to manual entry when scanner unavailable"
```

---

### Task 4: Update `pages/picking/[id].vue`

**Files:**
- Modify: `pages/picking/[id].vue`

- [ ] **Step 1: Import `createManualReview`**

Change:

```ts
import { useLabelScan, type LabelScanResult } from "~/composables/useLabelScan";
```

to:

```ts
import { useLabelScan, createManualReview, type LabelScanResult } from "~/composables/useLabelScan";
```

- [ ] **Step 2: Pass `:mode` to `LabelScanReviewModal`**

```vue
<LabelScanReviewModal
  v-if="review?.status === 'review'"
  v-model="reviewOpen"
  :image-path="review.capture.imagePath"
  :text="review.capture.text"
  :barcodes="review.capture.barcodes"
  :parsed="review.parsed"
  :match-result="review.matchResult"
  :mode="review.capture.imagePath ? 'review' : 'manual'"
  :context="{ task: 'picking', allocation: scanAllocation }"
  @applied="onApplied"
  @retake="onRetake"
/>
```

- [ ] **Step 3: Handle `'manual'` status in `openScan()`**

Inside `openScan(allocation: any)`, add after `'review'`:

```ts
} else if (result.status === 'manual') {
  review.value = createManualReview();
  scanAllocation.value = allocation;
  reviewOpen.value = true;
} else if (result.status === 'error') {
```

- [ ] **Step 4: Commit**

```bash
git add pages/picking/[id].vue
git commit -m "feat(picking): fall back to manual entry when scanner unavailable"
```

---

### Task 5: Update `pages/put-away/[id].vue`

**Files:**
- Modify: `pages/put-away/[id].vue`

- [ ] **Step 1: Import `createManualReview`**

Change:

```ts
import { useLabelScan, type LabelScanResult } from "~/composables/useLabelScan";
```

to:

```ts
import { useLabelScan, createManualReview, type LabelScanResult } from "~/composables/useLabelScan";
```

- [ ] **Step 2: Pass `:mode` to `LabelScanReviewModal`**

```vue
<LabelScanReviewModal
  v-if="review?.status === 'review'"
  v-model="reviewOpen"
  :image-path="review.capture.imagePath"
  :text="review.capture.text"
  :parsed="review.parsed"
  :match-result="review.matchResult"
  :mode="review.capture.imagePath ? 'review' : 'manual'"
  :context="{ task: 'put-away', receivingItem: scanItem, targetBoxId: scanBoxId }"
  @applied="onApplied"
  @retake="onRetake"
/>
```

- [ ] **Step 3: Handle `'manual'` status in `openScan()`**

Inside `openScan(lot: PutAwayLot)`, add after `'review'`:

```ts
} else if (result.status === 'manual') {
  review.value = createManualReview();
  scanItem.value = lot;
  scanBoxId.value = targetBoxSelections.value[lot.receiving_invoice_item_id] ?? '';
  reviewOpen.value = true;
} else if (result.status === 'error') {
```

- [ ] **Step 4: Commit**

```bash
git add pages/put-away/[id].vue
git commit -m "feat(put-away): fall back to manual entry when scanner unavailable"
```

---

### Task 6: Update `pages/goods-verify/box/[id].vue`

**Files:**
- Modify: `pages/goods-verify/box/[id].vue`

- [ ] **Step 1: Import `createManualReview`**

Change:

```ts
import { useLabelScan, type LabelScanResult } from "~/composables/useLabelScan";
```

to:

```ts
import { useLabelScan, createManualReview, type LabelScanResult } from "~/composables/useLabelScan";
```

- [ ] **Step 2: Pass `:mode` to `LabelScanReviewModal`**

```vue
<LabelScanReviewModal
  v-if="review?.status === 'review'"
  v-model="reviewOpen"
  :image-path="review.capture.imagePath"
  :text="review.capture.text"
  :barcodes="review.capture.barcodes"
  :parsed="review.parsed"
  :match-result="review.matchResult"
  :mode="review.capture.imagePath ? 'review' : 'manual'"
  :context="{ task: 'goods-verify', items: box?.items ?? [] }"
  @applied="onApplied"
  @retake="onRetake"
/>
```

- [ ] **Step 3: Handle `'manual'` status in `openScan()`**

Inside `openScan()`, add after `'review'`:

```ts
} else if (result.status === 'manual') {
  review.value = createManualReview();
  reviewOpen.value = true;
} else if (result.status === 'error') {
```

- [ ] **Step 4: Commit**

```bash
git add pages/goods-verify/box/[id].vue
git commit -m "feat(goods-verify): fall back to manual entry when scanner unavailable"
```

---

### Task 7: Update `pages/measuring/[taskId]/box/[boxId].vue`

**Files:**
- Modify: `pages/measuring/[taskId]/box/[boxId].vue`

- [ ] **Step 1: Import `createManualReview`**

Change:

```ts
import { useLabelScan, type LabelScanResult } from "~/composables/useLabelScan";
```

to:

```ts
import { useLabelScan, createManualReview, type LabelScanResult } from "~/composables/useLabelScan";
```

- [ ] **Step 2: Pass `:mode` to `LabelScanReviewModal`**

```vue
<LabelScanReviewModal
  v-if="review?.status === 'review'"
  v-model="reviewOpen"
  :image-path="review.capture.imagePath"
  :text="review.capture.text"
  :barcodes="review.capture.barcodes"
  :parsed="review.parsed"
  :match-result="review.matchResult"
  :mode="review.capture.imagePath ? 'review' : 'manual'"
  :context="{ task: 'measuring', boxId, targetPackageId: scanTargetPackageId }"
  @applied="onApplied"
  @retake="onRetake"
/>
```

- [ ] **Step 3: Handle `'manual'` status in `openScan()`**

Inside `openScan(packageId?: string)`, add after `'review'`:

```ts
} else if (result.status === 'manual') {
  review.value = createManualReview();
  scanTargetPackageId.value = packageId;
  reviewOpen.value = true;
} else if (result.status === 'error') {
```

- [ ] **Step 4: Commit**

```bash
git add pages/measuring/[taskId]/box/[boxId].vue
git commit -m "feat(measuring): fall back to manual entry when scanner unavailable"
```

---

### Task 8: Verify types

**Files:**
- Project root

- [ ] **Step 1: Run Nuxt type preparation**

```bash
pnpm nuxt prepare
```

Expected: command completes with no TypeScript errors.

- [ ] **Step 2: Commit if any generated type changes appear**

If `.nuxt/` changes are produced, commit them with:

```bash
git add .nuxt/
git commit -m "chore: regenerate nuxt types"
```

---

## Self-review

- **Spec coverage:**
  - Browser-unavailable detection → Task 1.
  - Manual status returned → Task 1.
  - Empty review object helper → Task 1.
  - Modal title/retake adjustments → Task 2.
  - Page integrations → Tasks 3–7.
  - Type verification → Task 8.
- **Placeholder scan:** No TBD/TODO placeholders. Each step includes exact code.
- **Type consistency:** `createManualReview()` returns the same `LabelScanResult` review shape used by real scans. `mode` prop is consistently `'review' | 'manual'` across all files.
