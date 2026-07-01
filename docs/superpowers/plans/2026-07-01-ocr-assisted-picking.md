# OCR-Assisted Picking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a floating scan button to the receiving order detail page that lets the operator pick a predefined label, match it to linked picking orders, and apply the pick.

**Architecture:** A new `OcrScanModal` component drives the UI. Two new composables handle mock OCR (`useMockOcr`) and the matching/apply flow (`useOcrPicking`). Database logic lives in `db/ocrPicking.ts` and reuses the existing `materializeReceivingAllocation` and `confirmAllocationPicked` functions.

**Tech Stack:** Nuxt 3, Vue 3, TypeScript, PGlite, Drizzle ORM, no test framework (manual UI verification).

---

## File Map

| File | Responsibility |
|---|---|
| `db/ocrPicking.ts` | Find receiving stock candidates, find picking order candidates, apply the pick by creating an allocation + materializing + confirming. |
| `composables/useMockOcr.ts` | Generate predefined label presets from current receiving order data and return parsed OCR results. |
| `composables/useOcrPicking.ts` | Orchestrate the scan-to-pick flow: match parsed OCR against DB candidates and apply the selected pick. |
| `components/OcrScanModal.vue` | Modal UI for preset picker, single match summary, multiple match picker, and no-match/error states. |
| `pages/receiving/[id].vue` | Add floating icon-only scan button and wire the modal. |
| `db/seed.ts` | Ensure seed data produces at least one single-match and one multiple-match scenario. |

---

## Task 1: DB queries for matching and apply

**Files:**
- Create: `db/ocrPicking.ts`

- [ ] **Step 1: Add types and receiving candidate query**

```typescript
import { sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";
import { materializeReceivingAllocation, confirmAllocationPicked } from "./picking";

export interface OcrParseResult {
  partNo: string;
  dateCode: string | null;
  lotCode: string | null;
  originCountry: string | null;
  qty: number;
}

export interface ReceivingCandidate {
  receivingInvoiceItemId: string;
  partId: string;
  partNo: string;
  dateCode: string | null;
  lotCode: string | null;
  originCountry: string | null;
  availableQty: number;
}

export interface PickingCandidate {
  pickingOrderId: string;
  pickingOrderRefNo: string;
  pickingItemId: string;
  shipTo: string | null;
  requiredQty: number;
  pickedQty: number;
  remainingQty: number;
}

export async function findReceivingCandidates(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string,
  parsed: OcrParseResult
): Promise<ReceivingCandidate[]> {
  return db
    .execute(sql`
      SELECT
        rii.id AS receiving_invoice_item_id,
        p.id AS part_id,
        p.part_no,
        rii.date_code,
        rii.lot_code,
        rii.origin_country,
        (rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0)) AS available_qty
      FROM receiving_orders ro
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      JOIN parts p ON p.id = rii.part_id
      LEFT JOIN (
        SELECT receiving_invoice_item_id, SUM(qty) AS allocated_qty
        FROM allocations
        WHERE receiving_invoice_item_id IS NOT NULL
        GROUP BY receiving_invoice_item_id
      ) alloc ON alloc.receiving_invoice_item_id = rii.id
      WHERE ro.id = ${receivingOrderId}
        AND ro.status = 'in_hand'
        AND p.part_no = ${parsed.partNo}
        AND (rii.date_code IS NOT DISTINCT FROM ${parsed.dateCode})
        AND (rii.lot_code IS NOT DISTINCT FROM ${parsed.lotCode})
        AND (rii.origin_country IS NOT DISTINCT FROM ${parsed.originCountry})
        AND rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0) >= ${parsed.qty}
      ORDER BY rii.date_code, rii.lot_code
    `)
    .then((r) =>
      (r.rows ?? []).map((row) => ({
        receivingInvoiceItemId: String(row.receiving_invoice_item_id),
        partId: String(row.part_id),
        partNo: String(row.part_no),
        dateCode: row.date_code ? String(row.date_code) : null,
        lotCode: row.lot_code ? String(row.lot_code) : null,
        originCountry: row.origin_country ? String(row.origin_country) : null,
        availableQty: Number(row.available_qty),
      })) as ReceivingCandidate[]
    );
}
```

- [ ] **Step 2: Add picking candidate query**

Append to `db/ocrPicking.ts`:

```typescript
export async function findPickingCandidates(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string,
  partId: string,
  qty: number
): Promise<PickingCandidate[]> {
  return db
    .execute(sql`
      SELECT DISTINCT
        po.id AS picking_order_id,
        po.ref_no AS picking_order_ref_no,
        pi.id AS picking_item_id,
        po.ship_to,
        pi.qty AS required_qty,
        pi.picked_qty,
        (pi.qty - pi.picked_qty - pi.allocated_qty) AS remaining_qty
      FROM picking_orders po
      JOIN picking_items pi ON pi.picking_order_id = po.id
      WHERE po.id IN (
        SELECT DISTINCT po2.id
        FROM receiving_orders ro
        JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
        JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        JOIN allocations a ON a.receiving_invoice_item_id = rii.id
        JOIN picking_items pi2 ON pi2.id = a.picking_item_id
        JOIN picking_orders po2 ON po2.id = pi2.picking_order_id
        WHERE ro.id = ${receivingOrderId}
      )
        AND pi.part_id = ${partId}
        AND po.status != 'finished'
        AND (pi.qty - pi.picked_qty - pi.allocated_qty) >= ${qty}
      ORDER BY po.ref_no
    `)
    .then((r) =>
      (r.rows ?? []).map((row) => ({
        pickingOrderId: String(row.picking_order_id),
        pickingOrderRefNo: String(row.picking_order_ref_no),
        pickingItemId: String(row.picking_item_id),
        shipTo: row.ship_to ? String(row.ship_to) : null,
        requiredQty: Number(row.required_qty),
        pickedQty: Number(row.picked_qty),
        remainingQty: Number(row.remaining_qty),
      })) as PickingCandidate[]
    );
}
```

- [ ] **Step 3: Add apply function**

Append to `db/ocrPicking.ts`:

```typescript
export async function applyOcrPick(
  db: PgliteDatabase<typeof schema>,
  receivingInvoiceItemId: string,
  pickingItemId: string,
  qty: number,
  dateCode: string | null,
  lotCode: string | null,
  originCountry: string | null,
  actorId: string
): Promise<{ allocationId: string; materializedAllocationId: string }> {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error("Qty must be a positive integer");
  }

  const [allocation] = await db
    .insert(schema.allocations)
    .values({
      id: uuid(),
      pickingItemId,
      receivingInvoiceItemId,
      qty,
    })
    .returning();

  const materializedAllocationId = await materializeReceivingAllocation(
    db,
    allocation.id,
    qty,
    dateCode,
    lotCode,
    originCountry
  );

  await confirmAllocationPicked(db, materializedAllocationId, qty, actorId);

  return { allocationId: allocation.id, materializedAllocationId };
}
```

- [ ] **Step 4: Verify types compile**

Run:

```bash
pnpm nuxt prepare
```

Expected: types generated without errors.

---

## Task 2: Mock OCR composable

**Files:**
- Create: `composables/useMockOcr.ts`

- [ ] **Step 1: Write the composable**

```typescript
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "~/db/schema";
import type { OcrParseResult } from "~/db/ocrPicking";

export interface MockPreset {
  id: string;
  rawText: string;
  parsed: OcrParseResult;
}

export function useMockOcr() {
  async function generatePresets(
    db: PgliteDatabase<typeof schema>,
    receivingOrderId: string
  ): Promise<MockPreset[]> {
    const rows = await db.execute(sql`
      SELECT DISTINCT
        p.part_no,
        rii.date_code,
        rii.lot_code,
        rii.origin_country,
        (rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0)) AS qty
      FROM receiving_orders ro
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      JOIN parts p ON p.id = rii.part_id
      LEFT JOIN (
        SELECT receiving_invoice_item_id, SUM(qty) AS allocated_qty
        FROM allocations
        WHERE receiving_invoice_item_id IS NOT NULL
        GROUP BY receiving_invoice_item_id
      ) alloc ON alloc.receiving_invoice_item_id = rii.id
      WHERE ro.id = ${receivingOrderId}
        AND ro.status = 'in_hand'
        AND rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0) > 0
      ORDER BY p.part_no
      LIMIT 10
    `);

    const presets: MockPreset[] = (rows.rows ?? []).map((row, idx) => {
      const partNo = normalize(String(row.part_no));
      const dateCode = row.date_code ? normalizeCode(String(row.date_code)) : null;
      const lotCode = row.lot_code ? normalizeCode(String(row.lot_code)) : null;
      const originCountry = row.origin_country ? normalize(String(row.origin_country)) : null;
      const qty = Number(row.qty);
      const rawText = [partNo, dateCode, lotCode, qty, originCountry]
        .filter(Boolean)
        .join(" ");

      return {
        id: `preset-${idx}`,
        rawText,
        parsed: { partNo, dateCode, lotCode, originCountry, qty },
      };
    });

    // Always include one guaranteed no-match preset so the demo can show the error path.
    presets.push({
      id: "preset-no-match",
      rawText: "NOMATCH-999 2099Z XX9 1 NA",
      parsed: {
        partNo: "NOMATCH-999",
        dateCode: "2099Z",
        lotCode: "XX9",
        originCountry: "NA",
        qty: 1,
      },
    });

    return presets;
  }

)

  /**
   * Base normalization: trim, uppercase, collapse whitespace.
   * Keeps dashes and letters intact so part numbers like KOA-103 stay valid.
   */
  function normalize(value: string): string {
    return value.trim().toUpperCase().replace(/\s+/g, " ");
  }

  /**
   * Code normalization: same as base plus common OCR digit substitutions.
   * Use only for fields that are known to be codes/dates/lots, not part numbers.
   */
  function normalizeCode(value: string): string {
    return normalize(value)
      .replace(/O/g, "0")
      .replace(/I/g, "1")
      .replace(/L/g, "1")
      .replace(/Z/g, "2")
      .replace(/S/g, "5");
  }

  function scan(preset: MockPreset): OcrParseResult {
    return {
      partNo: normalize(preset.parsed.partNo),
      dateCode: preset.parsed.dateCode ? normalizeCode(preset.parsed.dateCode) : null,
      lotCode: preset.parsed.lotCode ? normalizeCode(preset.parsed.lotCode) : null,
      originCountry: preset.parsed.originCountry ? normalize(preset.parsed.originCountry) : null,
      qty: preset.parsed.qty,
    };
  }

  return { generatePresets, scan, normalize };
}
```

Add the missing import at the top:

```typescript
import { sql } from "drizzle-orm";
```

- [ ] **Step 2: Verify types compile**

Run:

```bash
pnpm nuxt prepare
```

Expected: types generated without errors.

---

## Task 3: OCR picking flow composable

**Files:**
- Create: `composables/useOcrPicking.ts`

- [ ] **Step 1: Write the composable**

```typescript
import { ref } from "vue";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "~/db/schema";
import type {
  OcrParseResult,
  ReceivingCandidate,
  PickingCandidate,
} from "~/db/ocrPicking";
import {
  findReceivingCandidates,
  findPickingCandidates,
  applyOcrPick,
} from "~/db/ocrPicking";

export type MatchResult =
  | { status: "idle" }
  | { status: "scanning" }
  | { status: "no_match"; reason: string }
  | { status: "single"; receiving: ReceivingCandidate; picking: PickingCandidate }
  | { status: "multiple"; receiving: ReceivingCandidate; picking: PickingCandidate[] }
  | { status: "applying" }
  | { status: "success"; pickingOrderRefNo: string; qty: number }
  | { status: "error"; message: string };

export function useOcrPicking() {
  const matchResult = ref<MatchResult>({ status: "idle" });
  const scannedQty = ref<number>(0);

  async function match(
    db: PgliteDatabase<typeof schema>,
    receivingOrderId: string,
    parsed: OcrParseResult
  ) {
    scannedQty.value = parsed.qty;
    matchResult.value = { status: "scanning" };

    const receivingCandidates = await findReceivingCandidates(
      db,
      receivingOrderId,
      parsed
    );

    if (receivingCandidates.length === 0) {
      matchResult.value = {
        status: "no_match",
        reason: "No matching stock in receiving area.",
      };
      return;
    }

    const receiving = receivingCandidates[0];

    if (parsed.qty > receiving.availableQty) {
      matchResult.value = {
        status: "no_match",
        reason: "Quantity exceeds available stock.",
      };
      return;
    }

    const pickingCandidates = await findPickingCandidates(
      db,
      receivingOrderId,
      receiving.partId,
      parsed.qty
    );

    if (pickingCandidates.length === 0) {
      matchResult.value = {
        status: "no_match",
        reason: "No linked picking order needs this item.",
      };
      return;
    }

    if (pickingCandidates.length === 1) {
      matchResult.value = {
        status: "single",
        receiving,
        picking: pickingCandidates[0],
      };
      return;
    }

    matchResult.value = {
      status: "multiple",
      receiving,
      picking: pickingCandidates,
    };
  }

  async function apply(
    db: PgliteDatabase<typeof schema>,
    receiving: ReceivingCandidate,
    picking: PickingCandidate,
    actorId: string
  ) {
    matchResult.value = { status: "applying" };
    try {
      const qty = Math.min(scannedQty.value, receiving.availableQty, picking.remainingQty);
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new Error("Invalid quantity to apply");
      }
      await applyOcrPick(
        db,
        receiving.receivingInvoiceItemId,
        picking.pickingItemId,
        qty,
        receiving.dateCode,
        receiving.lotCode,
        receiving.originCountry,
        actorId
      );
      matchResult.value = {
        status: "success",
        pickingOrderRefNo: picking.pickingOrderRefNo,
        qty,
      };
    } catch (e: any) {
      matchResult.value = {
        status: "error",
        message: e?.message ?? "Failed to apply pick",
      };
    }
  }

  function reset() {
    matchResult.value = { status: "idle" };
    scannedQty.value = 0;
  }

  return { matchResult, match, apply, reset };
}
```

- [ ] **Step 2: Verify types compile**

Run:

```bash
pnpm nuxt prepare
```

Expected: types generated without errors.

---

## Task 4: OcrScanModal component

**Files:**
- Create: `components/OcrScanModal.vue`

- [ ] **Step 1: Write the component**

```vue
<template>
  <div v-if="modelValue" class="modal-overlay" @click.self="close">
    <div class="modal">
      <div class="modal__header">
        <h3>Scan label</h3>
        <button class="modal__close" aria-label="Close" @click="close">×</button>
      </div>

      <div class="modal__body">
        <template v-if="matchResult.status === 'idle' || matchResult.status === 'scanning'">
          <p class="subtitle">Tap a predefined label to simulate OCR capture.</p>
          <p v-if="presetsLoading" class="empty">Loading presets…</p>
          <p v-else-if="presetsError" class="empty" style="color: var(--danger);">{{ presetsError }}</p>
          <div v-else-if="presets.length === 0" class="empty">No scan presets available.</div>
          <div v-else class="options">
            <div
              v-for="preset in presets"
              :key="preset.id"
              class="option"
              @click="onPresetClick(preset)"
            >
              <div class="letter">📷</div>
              <div class="content">
                <h3>{{ preset.rawText }}</h3>
                <p>{{ preset.parsed.partNo }} · qty {{ preset.parsed.qty }}</p>
              </div>
            </div>
          </div>
        </template>

        <template v-else-if="matchResult.status === 'single'">
          <div class="card" style="border-left: 4px solid #16a34a;">
            <p><strong>{{ matchResult.picking.pickingOrderRefNo }}</strong></p>
            <p class="subtitle">Match found — applying pick…</p>
          </div>
        </template>

        <template v-else-if="matchResult.status === 'multiple'">
          <p class="subtitle">Multiple orders need this item. Choose one.</p>
          <div class="options">
            <div
              v-for="candidate in matchResult.picking"
              :key="candidate.pickingItemId"
              class="option"
              @click="onCandidateClick(candidate)"
            >
              <div class="letter">📦</div>
              <div class="content">
                <h3>{{ candidate.pickingOrderRefNo }}</h3>
                <p>Ship to: {{ candidate.shipTo || "—" }} · still needs {{ candidate.remainingQty }}</p>
              </div>
            </div>
          </div>
        </template>

        <template v-else-if="matchResult.status === 'no_match'">
          <div class="card" style="border-left: 4px solid #dc2626;">
            <p><strong>No match</strong></p>
            <p class="subtitle">{{ matchResult.reason }}</p>
          </div>
          <button class="btn" style="width: 100%; margin-top: 1rem;" @click="resetState">Try again</button>
        </template>

        <template v-else-if="matchResult.status === 'applying'">
          <p class="empty">Applying pick…</p>
        </template>

        <template v-else-if="matchResult.status === 'success'">
          <div class="card" style="border-left: 4px solid #16a34a;">
            <p><strong>Pick applied</strong></p>
            <p class="subtitle">{{ matchResult.qty }} pcs added to {{ matchResult.pickingOrderRefNo }}</p>
          </div>
          <button class="btn" style="width: 100%; margin-top: 1rem;" @click="close">Done</button>
        </template>

        <template v-else-if="matchResult.status === 'error'">
          <div class="card" style="border-left: 4px solid #dc2626;">
            <p><strong>Error</strong></p>
            <p class="subtitle">{{ matchResult.message }}</p>
          </div>
          <button class="btn" style="width: 100%; margin-top: 1rem;" @click="resetState">Try again</button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { MockPreset } from "~/composables/useMockOcr";
import type { PickingCandidate } from "~/db/ocrPicking";

const props = defineProps<{
  modelValue: boolean;
  receivingOrderId: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "applied"): void;
}>();

const db = await useDb();
const currentUser = await useCurrentUser();
const { generatePresets, scan } = useMockOcr();
const { matchResult, match, apply, reset } = useOcrPicking();

const presets = ref<MockPreset[]>([]);
const presetsLoading = ref(false);
const presetsError = ref<string | null>(null);

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      reset();
      loadPresets();
    }
  }
);

async function loadPresets() {
  presetsLoading.value = true;
  presetsError.value = null;
  try {
    presets.value = await generatePresets(db, props.receivingOrderId);
  } catch (e: any) {
    presetsError.value = e?.message ?? "Failed to load presets";
  } finally {
    presetsLoading.value = false;
  }
}

async function onPresetClick(preset: MockPreset) {
  const parsed = scan(preset);
  await match(db, props.receivingOrderId, parsed);

  if (matchResult.value.status === "single") {
    const { receiving, picking } = matchResult.value;
    await apply(db, receiving, picking, currentUser?.id ?? "");
    if (matchResult.value.status === "success") {
      emit("applied");
    }
  }
}

async function onCandidateClick(candidate: PickingCandidate) {
  if (matchResult.value.status !== "multiple") return;
  await apply(db, matchResult.value.receiving, candidate, currentUser?.id ?? "");
  if (matchResult.value.status === "success") {
    emit("applied");
  }
}

function resetState() {
  reset();
  loadPresets();
}

function close() {
  emit("update:modelValue", false);
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 100;
}

.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  width: 100%;
  max-width: 420px;
  max-height: 90vh;
  overflow-y: auto;
}

.modal__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  border-bottom: 1px solid var(--border);
}

.modal__header h3 {
  margin: 0;
}

.modal__close {
  background: transparent;
  border: none;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  color: var(--muted);
}

.modal__body {
  padding: 1rem;
}

.subtitle {
  color: var(--muted);
  font-size: 0.875rem;
  margin: 0 0 1rem;
}

.empty {
  text-align: center;
  color: var(--muted);
  padding: 1rem 0;
}

.options {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.option {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  cursor: pointer;
}

.option:hover {
  border-color: var(--primary);
}

.option .letter {
  font-size: 1.25rem;
}

.option .content h3 {
  margin: 0;
  font-size: 0.9375rem;
}

.option .content p {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  color: var(--muted);
}
</style>
```

- [ ] **Step 2: Verify types compile**

Run:

```bash
pnpm nuxt prepare
```

Expected: types generated without errors.

---

## Task 5: Wire scan button into receiving detail page

**Files:**
- Modify: `pages/receiving/[id].vue`

- [ ] **Step 1: Import the modal**

Add to the `<script setup>` imports:

```typescript
import OcrScanModal from "~/components/OcrScanModal.vue";
```

- [ ] **Step 2: Add modal state**

Add inside `<script setup>`:

```typescript
const scanOpen = ref(false);
```

- [ ] **Step 3: Add the floating scan button**

Add this just before the closing `</div>` of the first `.card` (after the "Shelve remaining stock" link):

```vue
<div v-if="order.status === 'in_hand'" style="position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 50;">
  <button
    class="btn"
    style="border-radius: 9999px; width: 3.5rem; height: 3.5rem; padding: 0; display: flex; align-items: center; justify-content: center; box-shadow: var(--shadow);"
    aria-label="Scan label"
    @click="scanOpen = true"
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
      <circle cx="12" cy="13" r="4"/>
    </svg>
  </button>
</div>
```

- [ ] **Step 4: Add the modal component**

Add this at the bottom of the template, after the `</template>` of the `v-else-if="order"` block but still inside the main `template`:

```vue
<OcrScanModal
  v-model="scanOpen"
  :receiving-order-id="orderId"
  @applied="load"
/>
```

Because `load()` is defined in the same component, this will refresh the receiving detail after a successful pick.

- [ ] **Step 5: Verify the page renders**

Run the dev server if not already running:

```bash
pnpm dev
```

Open http://localhost:3001/receiving/{id} and confirm:
- The floating scan button appears on `in_hand` receiving orders.
- Tapping it opens the modal with presets.

---

## Task 6: Seed data for demo scenarios

**Files:**
- Modify: `db/seed.ts` (only if the existing seed does not already produce the scenarios below)

The existing seed already produces the required scenarios through `allocatePickingOrder`. Verify the following by inspecting `db/seed.ts` and `db/allocate.ts`:

1. **Single-match scenario** — Receiving order `RO-240701-002` has `IC-LM358DR` and `MOS-IRLML6244` invoice items. Each is allocated to exactly one picking order (`TN-240701-005`).
2. **Multiple-match scenario** — Receiving order `RO-240701-001` has `RES-0603-10K` allocated to three picking orders (`TN-240701-002`, `TN-240701-003`, `TN-240701-004`).
3. **No-match scenario** — Receiving order `RO-240701-002` has `SNS-BMP280` with no linked picking order (its date code does not satisfy `TN-240705-001`'s `>2406` rule). Also, `RO-240701-001`'s `CAP-0805-100N` lots are not linked because `TN-240701-001`'s demand was filled from shelf stock.

- [ ] **Step 1: Verify seed produces the scenarios**

No code change is required if the analysis above holds. If any scenario is missing, adjust quantities or allocations in `db/seed.ts` before continuing.

- [ ] **Step 2: Reset local DB and verify seed**

Use the app header "Reset local DB" button or clear IndexedDB manually, then reload the page to re-seed.

---

## Task 7: Manual verification

- [ ] **Step 1: Start dev server**

```bash
pnpm dev
```

Open http://localhost:3001 and log in.

- [ ] **Step 2: Single-match scenario**

1. Navigate to receiving order `RO-240701-002`.
2. Tap the scan icon.
3. Select the `IC-LM358DR` or `MOS-IRLML6244` preset (linked only to `TN-240701-005`).
4. Confirm the modal shows success and the receiving order remaining qty decreases.

- [ ] **Step 3: Multiple-match scenario**

1. Navigate to receiving order `RO-240701-001`.
2. Tap the scan icon.
3. Select the `RES-0603-10K` preset.
4. Confirm the modal shows candidate picking orders (`TN-240701-002`, `TN-240701-003`, `TN-240701-004`).
5. Choose one.
6. Confirm the pick is applied to the chosen order.

- [ ] **Step 4: No-match scenario**

1. In any receiving order, select the guaranteed no-match preset `NOMATCH-999`.
2. Confirm the modal shows "No match" with a reason.

Optional: in `RO-240701-001`, select the `CAP-0805-100N` preset (demand already filled from shelf stock) and confirm it also produces "No match". In `RO-240701-002`, select the `SNS-BMP280` preset and confirm "No match".

- [ ] **Step 5: Check browser console**

No errors should appear during the flow.

---

## Spec Coverage Check

| Spec Requirement | Implementing Task |
|---|---|
| Floating icon-only scan button on receiving detail | Task 5 |
| Modal with preset picker | Task 4 |
| Parse label to part/date/lot/origin/qty | Task 2 |
| Match part first, then date/lot filters | Task 1 + Task 3 |
| Single match auto-apply | Task 3 + Task 4 |
| Multiple match picker | Task 3 + Task 4 |
| No match error | Task 3 + Task 4 |
| Scanned qty fixed, must fit available + needed | Task 1 + Task 3 |
| Apply pick reuses existing allocation/pick logic | Task 1 |
| Mock OCR (no real camera) | Task 2 |

## Placeholder Scan

No TBD, TODO, or vague requirements remain. Each task includes exact file paths, code, and verification commands.
