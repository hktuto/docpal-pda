# Browser Scan Fallback — Design Spec

## Goal

Allow users to continue scanning workflows when the native `RectangleDetection` plugin is unavailable (e.g., running the app in a browser). Instead of showing an error, the app opens the existing review modal in "manual entry" mode so the user can type the label fields and find a matching record.

## Trigger

`RectangleDetection.scanLabel()` throws `RectangleDetection label scan is not available in the browser.` when the web implementation is used. `useLabelScan.scan()` will detect this specific error and convert it to a new result status `'manual'`.

## Result type change

`composables/useLabelScan.ts`:

```ts
export type LabelScanResult =
  | { status: 'applied' }
  | { status: 'review'; capture: LabelScanCapture; parsed: OcrInput; matchResult: ScanMatchResult }
  | { status: 'manual' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };
```

A helper detects the browser-unavailable error:

```ts
function isBrowserUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes('not available in the browser');
}
```

## Page integration

Each page that calls `useLabelScan.scan()` updates its `openScan()` handler:

```ts
async function openScan(itemId?: string) {
  scanPickingItemId.value = itemId;
  const result = await scan({ ... });
  if (result.status === 'applied') {
    await load();
  } else if (result.status === 'review') {
    review.value = result;
    reviewOpen.value = true;
  } else if (result.status === 'manual') {
    review.value = {
      status: 'review',
      capture: { imagePath: '', text: '', barcodes: '[]' },
      parsed: { partNo: '', dateCode: '', lotCode: '', coo: '', cow: '', qty: '' },
      matchResult: { type: 'none' },
    };
    scanPickingItemId.value = itemId;
    reviewOpen.value = true;
  } else if (result.status === 'error') {
    error.value = result.message;
  }
}
```

Pages affected:

- `pages/receiving/[id].vue`
- `pages/picking/[id].vue`
- `pages/put-away/[id].vue`
- `pages/goods-verify/box/[id].vue`
- `pages/measuring/[taskId]/box/[boxId].vue`

## UI changes

`components/LabelScanReviewModal.vue`:

- Add a `mode: 'review' | 'manual'` prop (default `'review'`).
- When `mode === 'manual'`:
  - Title changes from "Review scan" to "Manual entry".
  - The **Retake** button is hidden (nothing to retake).
  - **Cancel** and **Find match** remain.
  - The empty image preview shows the existing "No image" placeholder.
  - The raw-text area is empty.

Pages pass `:mode="review.capture.imagePath ? 'review' : 'manual'"` or a computed equivalent.

## Data flow

1. User clicks **Scan** in browser.
2. `useLabelScan.scan()` catches the plugin error and returns `{ status: 'manual' }`.
3. Page builds a synthetic review object and opens `LabelScanReviewModal` in manual mode.
4. User types part number, date code, lot code, COO, COW, and quantity.
5. User clicks **Find match**; `runScanMatcher()` runs against the editable fields.
6. User clicks **Apply**; the matching record is updated and the modal closes.
7. Page reloads the detail data.

## Out of scope

- Browser image upload or browser-based OCR.
- Changing the native Android scanner behavior.
- Persisting manual entries separately from scan reviews.

## Testing

- Run `pnpm nuxt prepare` and confirm no type errors.
- Manual browser check:
  1. Log in as `operator` / `DocPal2026!`.
  2. Navigate to a receiving or picking detail page.
  3. Click **Scan**.
  4. Confirm the "Manual entry" modal opens.
  5. Type fields, click **Find match**, then **Apply**.
  6. Confirm the page updates correctly.
