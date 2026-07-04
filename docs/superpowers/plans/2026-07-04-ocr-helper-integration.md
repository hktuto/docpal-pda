# OCR Helper Integration & Candidate UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `parseAndIdentify` into the live scan flow and add candidate chips to `LabelScanReviewModal`.

**Architecture:** `useLabelScan` calls `parseAndIdentify` with per-flow target part numbers, feeds the best-guess `OcrInput` into the existing matcher, and carries candidate `options` to the review modal. The modal renders reusable `CandidateChips` rows for any field with multiple candidates.

**Tech Stack:** Nuxt 3, Vue 3, TypeScript, Capacitor, PGlite, Vitest.

---

## File structure

| File | Responsibility |
|------|----------------|
| `utils/ocrResultToInput.ts` (new) | Map `OcrParseResult.parsed` → `OcrInput`; keeps conversion logic testable and isolated. |
| `components/CandidateChips.vue` (new) | Render a row of selectable chips for one field. |
| `composables/useScanMatchers.ts` (modify) | Add `targets?: string[]` to `ScanTaskContext`. |
| `composables/useLabelScan.ts` (modify) | Use `parseAndIdentify`; thread `options` through `LabelScanResult`. |
| `composables/useLabelScanReview.ts` (modify) | No structural change; result already flows through transparently. |
| `components/LabelScanReviewModal.vue` (modify) | Accept `options`; render chips per field. |
| `pages/receiving/[id].vue` (modify) | Pass target part numbers in scan context. |
| `pages/picking/[id].vue` (modify) | Pass target part number in scan context. |
| `pages/put-away/[id].vue` (modify) | Pass target part number in scan context. |
| `pages/measuring/[taskId]/box/[boxId].vue` (modify) | Pass target part numbers in scan context. |
| `pages/goods-verify/box/[id].vue` (modify) | Pass target part numbers in scan context. |
| `tests/ocrResultToInput.test.ts` (new) | Unit tests for the mapping utility. |

---

## Task 1: Create `utils/ocrResultToInput.ts` and tests

**Files:**
- Create: `utils/ocrResultToInput.ts`
- Create: `tests/ocrResultToInput.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { ocrResultToInput } from '../utils/ocrResultToInput';
import type { OcrParseResult } from '../utils/parseOcrScan';

describe('ocrResultToInput', () => {
  it('maps parsed fields to OcrInput', () => {
    const parsed: OcrParseResult['parsed'] = {
      itemId: 'RK73B1JTTD181G',
      qty: 5000,
      dateCode: '2544',
      lotCode: 'ABC123',
      coo: 'JP',
      cow: 'W1',
    };

    const result = ocrResultToInput(parsed);

    expect(result.partNo).toBe('RK73B1JTTD181G');
    expect(result.qty).toBe(5000);
    expect(result.dateCode).toBe('2544');
    expect(result.lotCode).toBe('ABC123');
    expect(result.coo).toBe('JP');
    expect(result.cow).toBe('W1');
  });

  it('uses empty defaults for missing values', () => {
    const parsed: OcrParseResult['parsed'] = { itemId: null };
    const result = ocrResultToInput(parsed);

    expect(result.partNo).toBe('');
    expect(result.qty).toBe('');
    expect(result.dateCode).toBe('');
    expect(result.lotCode).toBe('');
    expect(result.coo).toBe('');
    expect(result.cow).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/ocrResultToInput.test.ts`

Expected: FAIL with "ocrResultToInput is not defined" or module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { OcrInput } from "~/composables/useMockOcr";
import type { OcrParseResult } from "~/utils/parseOcrScan";

/**
 * Convert the helper's best-guess parsed fields into the OcrInput shape
 * consumed by the matchers and the review modal.
 */
export function ocrResultToInput(parsed: OcrParseResult["parsed"]): OcrInput {
  return {
    partNo: parsed.itemId ?? "",
    dateCode: parsed.dateCode ?? "",
    lotCode: parsed.lotCode ?? "",
    coo: parsed.coo ?? "",
    cow: parsed.cow ?? "",
    qty: parsed.qty ?? "",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/ocrResultToInput.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/ocrResultToInput.test.ts utils/ocrResultToInput.ts
git commit -m "feat(scan): add ocrResultToInput mapping utility with tests"
```

---

## Task 2: Create reusable `components/CandidateChips.vue`

**Files:**
- Create: `components/CandidateChips.vue`

- [ ] **Step 1: Write the component**

```vue
<template>
  <div v-if="showChips" class="candidate-chips">
    <button
      v-for="candidate in candidates"
      :key="candidate"
      type="button"
      class="candidate-chip"
      :class="{ 'candidate-chip--active': candidate === modelValue }"
      @click="emit('update:modelValue', candidate)"
    >
      {{ candidate }}
    </button>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  modelValue: string;
  candidates: string[];
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const showChips = computed(() => props.candidates.length > 1);
</script>

<style scoped>
.candidate-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.candidate-chip {
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 0.8125rem;
  cursor: pointer;
}

.candidate-chip:hover:not(.candidate-chip--active) {
  border-color: var(--primary);
}

.candidate-chip--active {
  border-color: var(--primary);
  background: var(--primary);
  color: #fff;
}
</style>
```

- [ ] **Step 2: Verify with type check**

Run: `pnpm nuxt prepare`

Expected: succeeds. The component has no runtime dependencies beyond Vue and existing CSS variables.

- [ ] **Step 3: Commit**

```bash
git add components/CandidateChips.vue
git commit -m "feat(scan): add CandidateChips component"
```

---

## Task 3: Update type contracts

**Files:**
- Modify: `composables/useScanMatchers.ts`
- Modify: `composables/useLabelScan.ts`
- Modify: `components/LabelScanReviewModal.vue`

- [ ] **Step 1: Add `targets` to `ScanTaskContext`**

In `composables/useScanMatchers.ts`, update the interface:

```ts
export interface ScanTaskContext {
  task: ScanTask;
  targets?: string[];
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

- [ ] **Step 2: Update `LabelScanResult` and imports in `useLabelScan.ts`**

Add the import at the top of `composables/useLabelScan.ts`:

```ts
import type { CandidateOptions } from "~/utils/parseOcrScan";
```

Update the type:

```ts
export type LabelScanResult =
  | { status: "applied" }
  | {
      status: "review";
      capture: LabelScanCapture;
      parsed: OcrInput;
      options: CandidateOptions;
      matchResult: ScanMatchResult;
    }
  | { status: "manual" }
  | { status: "cancelled" }
  | { status: "error"; message: string };
```

- [ ] **Step 3: Update `createManualReview` defaults**

In `composables/useLabelScan.ts`, update `createManualReview` to include empty `options`:

```ts
export function createManualReview(): Extract<LabelScanResult, { status: "review" }> {
  return {
    status: "review",
    capture: { imagePath: "", text: "", barcodes: "[]" },
    parsed: { partNo: "", dateCode: "", lotCode: "", coo: "", cow: "", qty: "" },
    options: { itemIds: [], qtys: [], coos: [], dateCodes: [], lotCodes: [], cows: [] },
    matchResult: { type: "none" },
  };
}
```

- [ ] **Step 4: Update `LabelScanReviewModal.vue` props**

Add the prop:

```ts
const props = defineProps<{
  modelValue: boolean;
  imagePath: string;
  text: string;
  barcodes: string;
  parsed: OcrInput;
  options: CandidateOptions;
  matchResult: ScanMatchResult;
  context: ScanTaskContext;
  mode?: "review" | "manual";
}>();
```

Add the import:

```ts
import type { CandidateOptions } from "~/utils/parseOcrScan";
```

- [ ] **Step 5: Run type check**

Run: `pnpm nuxt prepare`

Expected: succeeds (other type errors from unimplemented integration are acceptable at this point).

- [ ] **Step 6: Commit**

```bash
git add composables/useScanMatchers.ts composables/useLabelScan.ts components/LabelScanReviewModal.vue
git commit -m "feat(scan): add targets and options to scan type contracts"
```

---

## Task 4: Integrate `parseAndIdentify` into `useLabelScan`

**Files:**
- Modify: `composables/useLabelScan.ts`

- [ ] **Step 1: Add helper imports and conversion utilities**

Replace the existing imports at the top of `composables/useLabelScan.ts` with:

```ts
import { ref } from "vue";
import {
  RectangleDetection,
  SCAN_NOT_AVAILABLE_MESSAGE,
  type LabelScanCapture,
} from "./useRectangleDetection";
import { runScanMatcher, type ScanTaskContext, type ScanMatchResult } from "./useScanMatchers";
import { I18nError } from "~/composables/i18nError";
import { useErrorMessage } from "~/composables/errorMessage";
import { parseAndIdentify, type RawOcrCapture } from "~/utils/parseOcrScan";
import { ocrResultToInput } from "~/utils/ocrResultToInput";
import type { OcrInput } from "./useMockOcr";
```

- [ ] **Step 2: Add barcode parsing helper**

Add above `useLabelScan`:

```ts
function parseBarcodes(barcodesJson: string): RawOcrCapture["barcodes"] {
  try {
    const parsed = JSON.parse(barcodesJson);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // ignore malformed barcode JSON
  }
  return [];
}
```

- [ ] **Step 3: Replace parser call in `scan()`**

Replace:

```ts
const parsed = parseRecognizedText(capture.text);
console.log("[useLabelScan]", { imagePath: capture.imagePath, text: capture.text, parsed });
```

with:

```ts
const barcodes = parseBarcodes(capture.barcodes);
const parsedResult = parseAndIdentify(
  { text: capture.text, barcodes },
  context.targets ?? []
);
const parsed = ocrResultToInput(parsedResult.parsed);
console.log("[useLabelScan]", {
  imagePath: capture.imagePath,
  text: capture.text,
  parsedResult,
  parsed,
});
```

- [ ] **Step 4: Return options from review branch**

Replace:

```ts
return { status: "review", capture, parsed, matchResult };
```

with:

```ts
return {
  status: "review",
  capture,
  parsed,
  options: parsedResult.options,
  matchResult,
};
```

- [ ] **Step 5: Remove obsolete `parseRecognizedText` import**

Delete the line:

```ts
import { parseRecognizedText } from "./useRecognizedTextParser";
```

- [ ] **Step 6: Run type check**

Run: `pnpm nuxt prepare`

Expected: succeeds.

- [ ] **Step 7: Commit**

```bash
git add composables/useLabelScan.ts
git commit -m "feat(scan): use parseAndIdentify in live scan flow"
```

---

## Task 5: Render candidate chips in `LabelScanReviewModal`

**Files:**
- Modify: `components/LabelScanReviewModal.vue`

- [ ] **Step 1: Add computed candidates**

After the `editable` ref, add:

```ts
const partNoCandidates = computed(() => props.options.itemIds);
const dateCodeCandidates = computed(() => props.options.dateCodes);
const lotCodeCandidates = computed(() => props.options.lotCodes);
const cooCandidates = computed(() => props.options.coos);
const cowCandidates = computed(() => props.options.cows);
const qtyCandidates = computed(() => props.options.qtys.map(String));

const qtyChipValue = computed({
  get: () => String(editable.value.qty),
  set: (v) => {
    if (v === "") {
      editable.value.qty = "";
    } else {
      const n = Number(v);
      editable.value.qty = Number.isNaN(n) ? "" : n;
    }
  },
});
```

- [ ] **Step 2: Add chips below each field**

Update the form block in the template:

```vue
<form class="form" @submit.prevent="findMatch">
  <label class="field">
    <span>{{ $t('labelScanReviewModal.partNo') }}</span>
    <input v-model="editable.partNo" type="text" :placeholder="$t('labelScanReviewModal.placeholderPartNo')" />
    <CandidateChips
      v-model="editable.partNo"
      :candidates="partNoCandidates"
      :label="$t('labelScanReviewModal.partNo')"
    />
  </label>
  <label class="field">
    <span>{{ $t('labelScanReviewModal.dateCode') }}</span>
    <input v-model="editable.dateCode" type="text" :placeholder="$t('labelScanReviewModal.placeholderDateCode')" />
    <CandidateChips
      v-model="editable.dateCode"
      :candidates="dateCodeCandidates"
      :label="$t('labelScanReviewModal.dateCode')"
    />
  </label>
  <label class="field">
    <span>{{ $t('labelScanReviewModal.lotCode') }}</span>
    <input v-model="editable.lotCode" type="text" :placeholder="$t('labelScanReviewModal.placeholderLotCode')" />
    <CandidateChips
      v-model="editable.lotCode"
      :candidates="lotCodeCandidates"
      :label="$t('labelScanReviewModal.lotCode')"
    />
  </label>
  <label class="field">
    <span>{{ $t('labelScanReviewModal.coo') }}</span>
    <input v-model="editable.coo" type="text" :placeholder="$t('labelScanReviewModal.placeholderCoo')" />
    <CandidateChips
      v-model="editable.coo"
      :candidates="cooCandidates"
      :label="$t('labelScanReviewModal.coo')"
    />
  </label>
  <label class="field">
    <span>{{ $t('labelScanReviewModal.cow') }}</span>
    <input v-model="editable.cow" type="text" :placeholder="$t('labelScanReviewModal.placeholderCow')" />
    <CandidateChips
      v-model="editable.cow"
      :candidates="cowCandidates"
      :label="$t('labelScanReviewModal.cow')"
    />
  </label>
  <label class="field">
    <span>{{ $t('labelScanReviewModal.qty') }}</span>
    <input v-model.number="editable.qty" type="number" min="1" :placeholder="$t('labelScanReviewModal.placeholderQty')" />
    <CandidateChips
      v-model="qtyChipValue"
      :candidates="qtyCandidates"
      :label="$t('labelScanReviewModal.qty')"
    />
  </label>
</form>
```

- [ ] **Step 3: Run type check**

Run: `pnpm nuxt prepare`

Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add components/LabelScanReviewModal.vue
git commit -m "feat(scan): render candidate chips in review modal"
```

---

## Task 6: Populate `targets` in all task pages

**Files:**
- Modify: `pages/receiving/[id].vue`
- Modify: `pages/picking/[id].vue`
- Modify: `pages/put-away/[id].vue`
- Modify: `pages/measuring/[taskId]/box/[boxId].vue`
- Modify: `pages/goods-verify/box/[id].vue`

### Task 6a: Receiving page

- [ ] **Step 1: Compute target part numbers**

In `pages/receiving/[id].vue`, add a computed target list near the other computed properties:

```ts
const scanTargets = computed(() => {
  if (!order.value) return [];
  return order.value.invoices
    .flatMap((invoice) => invoice.items)
    .map((item) => item.part?.partNo)
    .filter((partNo): partNo is string => !!partNo);
});
```

Adjust `item.part?.partNo` to match the actual shape of `DisplayReceivingItem` if different.

- [ ] **Step 2: Pass targets to `scan()`**

Update the `scan()` call in `openScan` so the context includes `targets`:

```ts
const result = await scan({
  task: "receiving",
  receivingOrderId: orderId,
  pickingItemId: scanPickingItemId.value,
  targets: scanTargets.value,
});
```

The `:context` binding on `LabelScanReviewModal` stays unchanged; `targets` is consumed by `useLabelScan.scan()`, not by the modal.

- [ ] **Step 3: Commit**

```bash
git add pages/receiving/[id].vue
git commit -m "feat(scan): pass target part numbers from receiving page"
```

### Task 6b: Picking page

- [ ] **Step 1: Compute target part number**

In `pages/picking/[id].vue`, add:

```ts
const scanTargets = computed(() => {
  const partNo = scanAllocation.value?.pickingItem?.part?.partNo;
  return partNo ? [partNo] : [];
});
```

- [ ] **Step 2: Pass targets to `scan()`**

Update the `scan()` call so the context includes `targets`:

```ts
const result = await scan({
  task: "picking",
  allocation: scanAllocation.value,
  targets: scanTargets.value,
});
```

The `:context` binding on `LabelScanReviewModal` stays unchanged.

- [ ] **Step 3: Commit**

```bash
git add pages/picking/[id].vue
git commit -m "feat(scan): pass target part number from picking page"
```

### Task 6c: Put-away page

- [ ] **Step 1: Compute target part number**

In `pages/put-away/[id].vue`, the `openScan` function already receives `lot: PutAwayLot`. Use it inline:

```ts
const result = await scan({
  task: "put-away",
  receivingItem: lot,
  targetBoxId: scanBoxId.value,
  targets: lot.part_no ? [lot.part_no] : [],
});
```

- [ ] **Step 2: Commit**

```bash
git add pages/put-away/[id].vue
git commit -m "feat(scan): pass target part number from put-away page"
```

### Task 6d: Measuring page

- [ ] **Step 1: Compute target part numbers**

In `pages/measuring/[taskId]/box/[boxId].vue`, add:

```ts
const scanTargets = computed(() => {
  if (!box.value) return [];
  return box.value.packages
    .filter((pkg) => !pkg.verified)
    .map((pkg) => pkg.pickingItem?.part?.partNo)
    .filter((partNo): partNo is string => !!partNo);
});
```

- [ ] **Step 2: Pass targets to `scan()`**

Update the `scan()` call so the context includes `targets`:

```ts
const result = await scan({
  task: "measuring",
  boxId,
  targetPackageId: scanTargetPackageId.value,
  targets: scanTargets.value,
});
```

The `:context` binding on `LabelScanReviewModal` stays unchanged.

- [ ] **Step 3: Commit**

```bash
git add pages/measuring/[taskId]/box/[boxId].vue
git commit -m "feat(scan): pass target part numbers from measuring page"
```

### Task 6e: Goods-verify page

- [ ] **Step 1: Compute target part numbers**

In `pages/goods-verify/box/[id].vue`, add:

```ts
const scanTargets = computed(() => {
  if (!box.value) return [];
  return box.value.items
    .filter((item) => !item.verified)
    .map((item) => item.part?.partNo)
    .filter((partNo): partNo is string => !!partNo);
});
```

- [ ] **Step 2: Pass targets to `scan()`**

Update the `scan()` call so the context includes `targets`:

```ts
const result = await scan({
  task: "goods-verify",
  items: box.value?.items ?? [],
  targets: scanTargets.value,
});
```

The `:context` binding on `LabelScanReviewModal` stays unchanged.

- [ ] **Step 3: Commit**

```bash
git add pages/goods-verify/box/[id].vue
git commit -m "feat(scan): pass target part numbers from goods-verify page"
```

---

## Task 7: Verification and documentation

**Files:**
- Modify: `docs/app-docs/flows/picking/label-scan.md`
- Modify: `docs/app-docs/ai/feature-registry.md` (if feature entry needs updating)
- Modify: `docs/app-docs/ai/code-map.md` (if code map needs updating)

- [ ] **Step 1: Run unit tests**

Run: `pnpm vitest run`

Expected: all tests pass, including new `ocrResultToInput` tests.

- [ ] **Step 2: Run type generation**

Run: `pnpm nuxt prepare`

Expected: succeeds with no errors.

- [ ] **Step 3: Run lint / format if configured**

Run: `pnpm lint` if it exists; otherwise skip.

- [ ] **Step 4: Update operator docs**

In `docs/app-docs/flows/picking/label-scan.md`, add a short paragraph under "Known behavior":

```md
- When the scanner detects more than one possible value for a field (for example, multiple date codes or countries of origin), the review modal shows the alternatives as a row of chips below the input. Tap a chip to switch the field to that value.
```

- [ ] **Step 5: Update AI code map**

In `docs/app-docs/ai/code-map.md`, ensure the scan flow entries mention:

- `utils/parseOcrScan.ts` and `utils/ocrResultToInput.ts` for OCR parsing.
- `components/CandidateChips.vue` for candidate UI.

Make minimal edits only if the existing entries are now misleading.

- [ ] **Step 6: Manual browser check**

Run: `pnpm dev`

Log in as `operator` / `DocPal2026!`. For at least two flows (e.g., receiving and picking):

1. Trigger a scan.
2. If review opens, verify candidate chips appear for fields with multiple options.
3. Tap a chip and confirm the input updates.
4. Click **Find match** and confirm the matcher uses the selected value.
5. Verify retake and cancel still work.

- [ ] **Step 7: Commit docs and final verification**

```bash
git add docs/app-docs/flows/picking/label-scan.md docs/app-docs/ai/code-map.md docs/superpowers/plans/2026-07-04-ocr-helper-integration.md
git commit -m "docs(scan): document candidate chips and update code map"
```

---

## Self-review

1. **Spec coverage:**
   - Helper integration → Tasks 3 and 4.
   - Candidate chips UI → Tasks 2 and 5.
   - Per-flow targets → Task 6.
   - Testing → Tasks 1 and 7.
   - Docs → Task 7.

2. **Placeholder scan:**
   - No TBD/TODO/"implement later" found.
   - Every code step contains actual code.
   - Every task has a verification step.

3. **Type consistency:**
   - `CandidateOptions` is imported from `~/utils/parseOcrScan` consistently.
   - `OcrInput` fields map correctly from `OcrParseResult["parsed"]`.
   - `qtyChipValue` converts between number and string for `CandidateChips`.
