# OCR Helper Integration & Candidate UI Design

Date: 2026-07-04

## Goal

Wire the existing `parseAndIdentify` helper (`utils/parseOcrScan.ts`) into the live scan flow so every scan benefits from barcode parsing, fuzzy part-number matching, and ranked field candidates. Enhance the shared `LabelScanReviewModal` to let operators switch between candidate values using chips/tabs.

## Background

- `utils/parseOcrScan.ts` already exposes `parseAndIdentify(capture, targets)`, which returns:
  - `parsed` — best-guess values for itemId, qty, coo, dateCode, lotCode, cow.
  - `options` — ranked arrays of candidate values for each field.
  - `matched` — whether one of the supplied target part numbers was identified.
- The current live flow (`useLabelScan`) uses `parseRecognizedText`, which:
  - Only reads OCR text (ignores barcodes).
  - Returns a single value per field.
  - Does not accept a list of expected part numbers.
- All five task flows use the same `useLabelScan` → `LabelScanReviewModal` path, so a single integration point covers receiving, picking, put-away, measuring, and goods-verify.

## Scope

### In scope

1. Update `useLabelScan` to call `parseAndIdentify` instead of `parseRecognizedText`.
2. Add `targets?: string[]` to `ScanTaskContext` and populate it in each task page.
3. Thread the new `options` through `LabelScanResult` to `LabelScanReviewModal`.
4. Add candidate chips/tabs below review-modal fields when `options` contains more than one value.
5. Keep the existing matcher contract (`OcrInput`) unchanged.
6. Update tests and documentation.

### Out of scope

- Changes to the helper itself (`utils/parseOcrScan.ts`).
- Matcher logic changes in `useScanMatchers`.
- Database schema changes.
- Native Android changes.

## API / type changes

### `ScanTaskContext`

```ts
export interface ScanTaskContext {
  task: ScanTask;
  targets?: string[];                    // NEW: expected part numbers for this scan
  receivingOrderId?: string;
  pickingItemId?: string;
  allocation?: PickingAllocation;
  receivingItem?: PutAwayLot;
  targetBoxId?: string;
  boxId?: string;
  targetPackageId?: string;
  shelfBoxId?: string;
  items?: BoxItem[];
}
```

### `LabelScanResult`

```ts
export type LabelScanResult =
  | { status: 'applied' }
  | { status: 'review'; capture: LabelScanCapture; parsed: OcrInput; options: CandidateOptions; matchResult: ScanMatchResult }
  | { status: 'manual' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };
```

`CandidateOptions` is imported from `utils/parseOcrScan.ts`.

### `LabelScanReviewModal` props

```ts
const props = defineProps<{
  modelValue: boolean;
  imagePath: string;
  text: string;
  barcodes: string;
  parsed: OcrInput;
  options: CandidateOptions;            // NEW
  matchResult: ScanMatchResult;
  context: ScanTaskContext;
  mode?: 'review' | 'manual';
}>();
```

## Data flow

```
Task page scan button
        │
        ▼
useLabelScan.scan(context)
        │
        ▼
RectangleDetection.scanLabel()
        │
        ▼
parseAndIdentify(capture, context.targets)
        │
        ├──▶ result.parsed  ──▶ OcrInput ──▶ runScanMatcher()
        │                            │
        │                            ▼
        │                    single match? ──Yes──▶ apply automatically
        │                            │
        │                            No
        │                            ▼
        └──▶ result.options ──▶ LabelScanReviewModal candidate chips
```

1. Task page builds `context` and includes `targets`.
2. `useLabelScan` captures the label, then calls `parseAndIdentify`.
3. The best-guess `parsed` values are fed into the existing matcher.
4. If the matcher returns a single record, it is applied automatically.
5. Otherwise, the review modal opens with both the best guess and the candidate arrays.

## Target sources per flow

| Flow | `targets` source |
|------|------------------|
| Receiving | Part numbers of invoice items on the receiving order |
| Picking | The allocated part's `partNo` (single target) |
| Put-away | The receiving item's `part_no` (single target) |
| Measuring | Part numbers of unverified packages in the box |
| Goods-verify | Part numbers of unverified items in the shelf box |

If building a target list is impractical for a flow in the first iteration, pass `[]`. The helper still extracts field candidates, but part-number matching is skipped and the review modal opens.

## UI design

### Candidate chips

For each editable field (partNo, dateCode, lotCode, coo, cow, qty):

- If `options.<field>` has more than one distinct value, render a horizontal row of chips below the input.
- Each chip shows one candidate value.
- The chip matching the current input is highlighted.
- Tapping a chip updates the input to that candidate and re-runs validation state.
- If only one or zero candidates exist, no chips are rendered to keep the form clean.

### Example

```
Date code
[ 2544        ]
[2544] [201910] [2025-10-29]
```

### Manual mode

In manual mode `options` is empty, so no chips appear and the modal behaves exactly as today.

## Edge cases

- **No targets supplied:** `parseAndIdentify` still extracts candidates; `matched` is false; review modal opens.
- **No part number found:** `parsed.itemId` is null; the part-number input is empty; chips still show other field candidates.
- **Single candidate:** no chips shown; input already contains the only option.
- **Duplicate candidates:** chips are de-duplicated by display value.
- **User edits input manually:** if the typed value does not match any chip, no chip is highlighted until the user selects one.
- **Apply error:** modal stays open; input and chip selection are preserved.

## Testing strategy

1. **Unit tests**
   - Test mapping `OcrParseResult.parsed` → `OcrInput` (null handling, qty coercion).
   - Test candidate-chip de-duplication logic.
   - Keep existing `parseAndIdentify` tests passing.

2. **Type checks**
   - Run `pnpm nuxt prepare` after type changes.

3. **Manual browser check**
   - Log in as `operator` / `DocPal2026!`.
   - For at least two flows:
     - Scan a label with multiple candidates → review modal shows chips.
     - Tap a chip → input updates.
     - Tap **Find match** → matcher uses the selected value.
     - Retake and cancel still work.

## Files

### Create

- `utils/ocrResultToInput.ts` — map `OcrParseResult.parsed` to `OcrInput`.
- `components/CandidateChips.vue` — reusable chip row for a single field.

### Modify

- `composables/useLabelScan.ts` — call `parseAndIdentify`; thread `options`.
- `composables/useLabelScanReview.ts` — carry `options` through review state.
- `composables/useScanMatchers.ts` — add `targets?: string[]` to `ScanTaskContext`.
- `components/LabelScanReviewModal.vue` — accept `options`; render chips per field.
- `pages/receiving/[id].vue` — pass `targets`.
- `pages/picking/[id].vue` — pass `targets`.
- `pages/put-away/[id].vue` — pass `targets`.
- `pages/measuring/[taskId]/box/[boxId].vue` — pass `targets`.
- `pages/goods-verify/box/[id].vue` — pass `targets`.
- `tests/parseOcrScan.test.ts` or new `tests/ocrResultToInput.test.ts` — add mapping tests.

## Open questions

None at design time.
