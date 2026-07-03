# Receiving mismatch reporting redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single mismatch flag with structured mismatch reasons on receiving invoice items.

**Architecture:** Extend `receiving_invoice_items` with `mismatchReason`, `mismatchQty`, and `wrongPartNo` columns; compute `receivedQty` from the reason; record every change in `transition_logs`; update the receiving detail UI with a reason selector and conditional inputs.

**Tech Stack:** Nuxt 3, Vue 3, TypeScript, PGlite, Drizzle ORM.

---

## Files to touch

| File | Responsibility |
|------|----------------|
| `db/schema.ts` | Drizzle schema for `receivingInvoiceItems` |
| `db/init.ts` | Raw SQL bootstrap for PGlite |
| `db/receiving.ts` | `updateReceivingItemMismatch` and item lock check |
| `pages/receiving/[id].vue` | Receiving detail UI |

---

## Constants

Create or reuse an enum for mismatch reasons:

```ts
export const mismatchReasons = [
  "not_found",
  "damaged",
  "qty_mismatch",
  "wrong_part",
  "over_shipment",
  "quality_rejection",
] as const;

export type MismatchReason = (typeof mismatchReasons)[number];
```

Place this in `db/schema.ts` near `receivingInvoiceItems` so both schema and helpers can import it.

---

## Task 1: Add columns to Drizzle schema

**Files:**
- Modify: `db/schema.ts:63-82`

- [ ] **Step 1: Add the enum and type**

Add above the `receivingInvoiceItems` table definition:

```ts
export const mismatchReasons = [
  "not_found",
  "damaged",
  "qty_mismatch",
  "wrong_part",
  "over_shipment",
  "quality_rejection",
] as const;

export type MismatchReason = (typeof mismatchReasons)[number];
```

- [ ] **Step 2: Add columns to `receivingInvoiceItems`**

Update the table definition:

```ts
export const receivingInvoiceItems = pgTable("receiving_invoice_items", {
  id: text("id").primaryKey(),
  receivingInvoiceId: text("receiving_invoice_id")
    .notNull()
    .references(() => receivingInvoices.id, { onDelete: "cascade" }),
  partId: text("part_id").notNull().references(() => parts.id),
  poNo: text("po_no"),
  poLine: text("po_line"),
  qty: integer("qty").notNull(),
  receivedQty: integer("received_qty").notNull().default(0),
  pickedQty: integer("picked_qty").notNull().default(0),
  putAwayQty: integer("put_away_qty").notNull().default(0),
  boxId: text("box_id"),
  dateCode: text("date_code"),
  lotCode: text("lot_code"),
  coo: text("coo"),
  cow: text("cow"),
  reportedMismatch: boolean("reported_mismatch").default(false),
  mismatchReason: text("mismatch_reason"),
  mismatchQty: integer("mismatch_qty"),
  wrongPartNo: text("wrong_part_no"),
  mismatchNote: text("mismatch_note"),
});
```

- [ ] **Step 3: Verify types generate**

Run:

```bash
pnpm nuxt prepare
```

Expected: exits 0 with no type errors.

---

## Task 2: Add columns to raw SQL bootstrap

**Files:**
- Modify: `db/init.ts:54-71`

- [ ] **Step 1: Update the `receiving_invoice_items` CREATE TABLE statement**

Change:

```sql
CREATE TABLE IF NOT EXISTS receiving_invoice_items (
  id TEXT PRIMARY KEY,
  receiving_invoice_id TEXT NOT NULL REFERENCES receiving_invoices(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES parts(id),
  po_no TEXT,
  po_line TEXT,
  qty INTEGER NOT NULL,
  received_qty INTEGER NOT NULL DEFAULT 0,
  picked_qty INTEGER NOT NULL DEFAULT 0,
  put_away_qty INTEGER NOT NULL DEFAULT 0,
  box_id TEXT,
  date_code TEXT,
  lot_code TEXT,
  coo TEXT,
  cow TEXT,
  reported_mismatch BOOLEAN DEFAULT FALSE,
  mismatch_reason TEXT,
  mismatch_qty INTEGER,
  wrong_part_no TEXT,
  mismatch_note TEXT
);
```

- [ ] **Step 2: Confirm no syntax errors**

Run:

```bash
pnpm nuxt prepare
```

Expected: exits 0.

---

## Task 3: Add mismatch computation helpers

**Files:**
- Modify: `db/receiving.ts`

- [ ] **Step 1: Import the enum/type**

At the top of `db/receiving.ts`:

```ts
import { mismatchReasons, type MismatchReason } from "./schema";
```

- [ ] **Step 2: Add `computeReceivedQty`**

Add this helper before `updateReceivingItemMismatch`:

```ts
export function computeReceivedQty(
  expectedQty: number,
  reason: MismatchReason | null,
  mismatchQty: number | null
): number {
  if (!reason) return expectedQty;

  switch (reason) {
    case "not_found":
      return 0;
    case "damaged":
    case "quality_rejection": {
      const bad = mismatchQty ?? 0;
      return Math.max(0, expectedQty - bad);
    }
    case "qty_mismatch": {
      return mismatchQty ?? 0;
    }
    case "over_shipment": {
      return expectedQty;
    }
    case "wrong_part":
      return 0;
    default:
      return expectedQty;
  }
}
```

- [ ] **Step 3: Add `validateMismatchInputs`**

Add this helper:

```ts
export function validateMismatchInputs(
  expectedQty: number,
  reason: MismatchReason | null,
  mismatchQty: number | null,
  wrongPartNo: string | null
): void {
  if (!reason) return;

  const qty = mismatchQty ?? 0;

  if (!Number.isInteger(qty) || qty < 0) {
    throw new Error("Quantity must be a non-negative integer");
  }

  if (reason === "damaged" || reason === "quality_rejection") {
    if (qty > expectedQty) {
      throw new Error("Damaged/rejected quantity cannot exceed expected quantity");
    }
  }

  if (reason === "over_shipment" || reason === "wrong_part") {
    if (qty <= 0) {
      throw new Error("Quantity must be greater than 0");
    }
  }

  if (reason === "wrong_part" && (!wrongPartNo || wrongPartNo.trim() === "")) {
    throw new Error("Wrong part number is required");
  }

  const receivedQty = computeReceivedQty(expectedQty, reason, mismatchQty);
  if (receivedQty < 0) {
    throw new Error("Computed received quantity cannot be negative");
  }
}
```

- [ ] **Step 4: Add `canEditReceivingItemMismatch`**

Add this helper:

```ts
export async function canEditReceivingItemMismatch(
  db: PgliteDatabase<typeof schema>,
  itemId: string
): Promise<boolean> {
  const item = await db.query.receivingInvoiceItems.findFirst({
    where: eq(schema.receivingInvoiceItems.id, itemId),
  });
  if (!item) return false;

  const allocatedResult = await db
    .select({ total: sql<number>`coalesce(sum(${schema.allocations.qty}), 0)`.mapWith(Number) })
    .from(schema.allocations)
    .where(eq(schema.allocations.receivingInvoiceItemId, itemId));

  const allocated = allocatedResult[0]?.total ?? 0;
  return item.pickedQty === 0 && item.putAwayQty === 0 && allocated === 0;
}
```

- [ ] **Step 5: Rewrite `updateReceivingItemMismatch`**

Replace the existing function with:

```ts
export async function updateReceivingItemMismatch(
  db: PgliteDatabase<typeof schema>,
  itemId: string,
  actorId: string,
  reason: MismatchReason | null,
  mismatchQty: number | null,
  wrongPartNo: string | null,
  note: string
) {
  const item = await db.query.receivingInvoiceItems.findFirst({
    where: eq(schema.receivingInvoiceItems.id, itemId),
  });

  if (!item) {
    throw new Error("Receiving invoice item not found");
  }

  validateMismatchInputs(item.qty, reason, mismatchQty, wrongPartNo);

  const editable = await canEditReceivingItemMismatch(db, itemId);
  if (!editable) {
    throw new Error("Cannot edit mismatch: stock already allocated, picked, or put away");
  }

  const receivedQty = reason
    ? computeReceivedQty(item.qty, reason, mismatchQty)
    : item.qty;

  const trimmedWrongPartNo = wrongPartNo?.trim() || null;
  const trimmedNote = note.trim() || null;

  await db.transaction(async (tx) => {
    await tx
      .update(schema.receivingInvoiceItems)
      .set({
        receivedQty,
        reportedMismatch: reason !== null,
        mismatchReason: reason,
        mismatchQty: reason ? mismatchQty : null,
        wrongPartNo: reason === "wrong_part" ? trimmedWrongPartNo : null,
        mismatchNote: trimmedNote,
      })
      .where(eq(schema.receivingInvoiceItems.id, itemId));

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "receiving_invoice_item",
      entityId: itemId,
      fromState: item.mismatchReason ?? null,
      toState: reason ?? null,
      actorId,
      metadata: JSON.stringify({
        reason,
        mismatchQty,
        wrongPartNo: trimmedWrongPartNo,
        receivedQty,
        note: trimmedNote,
      }),
      createdAt: new Date(),
    });
  });
}
```

- [ ] **Step 6: Run type check**

```bash
pnpm nuxt prepare
```

Expected: exits 0.

---

## Task 4: Update the receiving detail page UI

**Files:**
- Modify: `pages/receiving/[id].vue`

### Template changes

- [ ] **Step 1: Replace the mismatch form block**

Find this block (around lines 121-142):

```vue
<div v-if="order.status === 'pending'" style="margin-top: 0.75rem; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
  <input
    v-model.number="form[item.id].actualQty"
    type="number"
    placeholder="Actual qty"
    style="width: 6rem;"
  />
  <input
    v-model="form[item.id].note"
    type="text"
    placeholder="Mismatch note"
    style="flex: 1; min-width: 8rem;"
  />
  <button class="btn btn--small" @click="saveMismatch(item.id)" :disabled="saving[item.id]">
    Save mismatch
  </button>
</div>

<div v-else-if="item.reportedMismatch" class="mismatch-badge">
  Mismatch reported
</div>
```

Replace with:

```vue
<div v-if="order.status === 'pending' || order.status === 'in_hand'" style="margin-top: 0.75rem;">
  <template v-if="item.locked">
    <p class="mismatch-locked">Locked: stock already allocated, picked, or put away.</p>
  </template>

  <template v-else-if="!editingMismatch[item.id] && item.reportedMismatch">
    <div class="mismatch-summary">
      <span class="mismatch-badge">{{ formatMismatchSummary(item) }}</span>
      <span v-if="item.mismatchNote" class="mismatch-note">{{ item.mismatchNote }}</span>
      <button class="btn btn--small" @click="startEdit(item.id)">Edit</button>
    </div>
  </template>

  <template v-else>
    <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.5rem;">
      <select v-model="form[item.id].reason" style="min-width: 10rem;">
        <option value="">— Select reason —</option>
        <option v-for="r in mismatchReasons" :key="r" :value="r">{{ formatReason(r) }}</option>
      </select>
    </div>

    <div v-if="form[item.id].reason" style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.5rem;">
      <input
        v-if="showMismatchQty(form[item.id].reason)"
        v-model.number="form[item.id].mismatchQty"
        type="number"
        :placeholder="qtyPlaceholder(form[item.id].reason)"
        style="width: 8rem;"
      />
      <input
        v-if="form[item.id].reason === 'wrong_part'"
        v-model="form[item.id].wrongPartNo"
        type="text"
        placeholder="Wrong part number"
        style="flex: 1; min-width: 8rem;"
      />
    </div>

    <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
      <input
        v-model="form[item.id].note"
        type="text"
        placeholder="Mismatch note"
        style="flex: 1; min-width: 8rem;"
      />
      <button class="btn btn--small" @click="saveMismatch(item.id)" :disabled="saving[item.id]">
        {{ saving[item.id] ? "Saving…" : "Save mismatch" }}
      </button>
      <button
        v-if="item.reportedMismatch || form[item.id].reason"
        class="btn btn--small btn--ghost"
        @click="cancelEdit(item.id)"
      >
        Cancel
      </button>
    </div>
  </template>
</div>
```

- [ ] **Step 2: Add styles**

Append to the `<style scoped>` block:

```vue
.mismatch-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.mismatch-note {
  font-size: 0.875rem;
  color: var(--muted);
  flex: 1;
}

.mismatch-locked {
  font-size: 0.875rem;
  color: var(--danger);
  margin: 0;
}
```

### Script changes

- [ ] **Step 3: Update imports**

Change:

```ts
import {
  getReceivingOrderDetail,
  updateReceivingItemMismatch,
  confirmReceivingOrderArrived,
} from "~/db/receiving";
```

To:

```ts
import {
  getReceivingOrderDetail,
  updateReceivingItemMismatch,
  confirmReceivingOrderArrived,
} from "~/db/receiving";
import { mismatchReasons, type MismatchReason } from "~/db/schema";
```

No new Drizzle imports are needed in this file.

- [ ] **Step 4: Update form state**

Change:

```ts
const form = ref<Record<string, { actualQty: number; note: string }>>({});
```

To:

```ts
const form = ref<
  Record<
    string,
    {
      reason: MismatchReason | "";
      mismatchQty: number | null;
      wrongPartNo: string;
      note: string;
    }
  >
>({});
```

Add editing state:

```ts
const editingMismatch = ref<Record<string, boolean>>({});
```

- [ ] **Step 5: Update `load()` form initialization**

Find this block inside `load()`:

```ts
if (orderData) {
  const nextForm: Record<string, { actualQty: number; note: string }> = {};
  for (const invoice of orderData.invoices) {
    for (const item of invoice.items) {
      nextForm[item.id] = {
        actualQty: form.value[item.id]?.actualQty ?? (item.reportedMismatch ? item.receivedQty : item.qty),
        note: form.value[item.id]?.note ?? (item.mismatchNote || ""),
      };
    }
  }
  form.value = nextForm;
}
```

Replace with:

```ts
if (orderData) {
  const nextForm: Record<string, { reason: MismatchReason | ""; mismatchQty: number | null; wrongPartNo: string; note: string }> = {};
  for (const invoice of orderData.invoices) {
    for (const item of invoice.items) {
      nextForm[item.id] = {
        reason: form.value[item.id]?.reason ?? (item.mismatchReason || ""),
        mismatchQty: form.value[item.id]?.mismatchQty ?? (item.mismatchQty ?? null),
        wrongPartNo: form.value[item.id]?.wrongPartNo ?? (item.wrongPartNo || ""),
        note: form.value[item.id]?.note ?? (item.mismatchNote || ""),
      };
    }
  }
  form.value = nextForm;
}
```

Also augment each item with a `locked` flag. After the allocated result is computed (around line 480), add:

```ts
const lockedByItem = ref<Record<string, boolean>>({});
```

Then inside `load()`, after computing `allocatedByItem`, compute:

```ts
const nextLocked: Record<string, boolean> = {};
for (const invoice of orderData.invoices) {
  for (const item of invoice.items) {
    const allocated = nextAllocated[item.id] ?? 0;
    nextLocked[item.id] = item.pickedQty > 0 || item.putAwayQty > 0 || allocated > 0;
  }
}
lockedByItem.value = nextLocked;
```

Then when assigning `order.value`, map items to include `locked`:

```ts
order.value = {
  ...orderData,
  invoices: orderData.invoices.map((invoice) => ({
    ...invoice,
    items: invoice.items.map((item) => ({
      ...item,
      locked: nextLocked[item.id] ?? false,
    })),
  })),
};
```

Remove the direct assignment `order.value = orderData;`.

- [ ] **Step 6: Add helper functions**

Add these helper functions before `saveMismatch`:

```ts
function formatReason(reason: MismatchReason): string {
  const labels: Record<MismatchReason, string> = {
    not_found: "Not found",
    damaged: "Damaged",
    qty_mismatch: "Quantity mismatch",
    wrong_part: "Wrong part shipped",
    over_shipment: "Over shipment",
    quality_rejection: "Quality rejection",
  };
  return labels[reason];
}

function showMismatchQty(reason: MismatchReason | ""): boolean {
  if (!reason) return false;
  return reason !== "not_found";
}

function qtyPlaceholder(reason: MismatchReason | ""): string {
  switch (reason) {
    case "damaged":
      return "Damaged qty";
    case "quality_rejection":
      return "Rejected qty";
    case "qty_mismatch":
      return "Actual received qty";
    case "over_shipment":
      return "Extra qty";
    case "wrong_part":
      return "Wrong part qty";
    default:
      return "Qty";
  }
}

function formatMismatchSummary(item: any): string {
  switch (item.mismatchReason) {
    case "not_found":
      return "Not found";
    case "damaged":
      return `Damaged: ${item.mismatchQty} of ${item.qty}`;
    case "quality_rejection":
      return `Quality rejection: ${item.mismatchQty} of ${item.qty}`;
    case "qty_mismatch":
      return `Quantity mismatch: received ${item.mismatchQty} of ${item.qty}`;
    case "over_shipment":
      return `Over shipment: +${item.mismatchQty}`;
    case "wrong_part":
      return `Wrong part: ${item.wrongPartNo} × ${item.mismatchQty}`;
    default:
      return "Mismatch reported";
  }
}

function startEdit(itemId: string) {
  editingMismatch.value[itemId] = true;
}

function cancelEdit(itemId: string) {
  editingMismatch.value[itemId] = false;
  const item = findItemById(itemId);
  if (item) {
    form.value[itemId] = {
      reason: item.mismatchReason || "",
      mismatchQty: item.mismatchQty ?? null,
      wrongPartNo: item.wrongPartNo || "",
      note: item.mismatchNote || "",
    };
  }
}

function findItemById(itemId: string) {
  if (!order.value) return undefined;
  for (const invoice of order.value.invoices) {
    const item = invoice.items.find((i: any) => i.id === itemId);
    if (item) return item;
  }
  return undefined;
}
```

- [ ] **Step 7: Update `saveMismatch`**

Replace `saveMismatch` with:

```ts
async function saveMismatch(itemId: string) {
  saving.value[itemId] = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    const f = form.value[itemId];
    const reason = f.reason || null;
    await updateReceivingItemMismatch(
      db,
      itemId,
      currentUser.id,
      reason as MismatchReason | null,
      reason ? (f.mismatchQty ?? null) : null,
      reason === "wrong_part" ? f.wrongPartNo : null,
      f.note
    );
    editingMismatch.value[itemId] = false;
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    saving.value[itemId] = false;
  }
}
```

- [ ] **Step 8: Run type check**

```bash
pnpm nuxt prepare
```

Expected: exits 0.

---

## Task 5: Manual verification

**Files:**
- Test in browser

- [ ] **Step 1: Clear IndexedDB**

Open the app in a browser, open DevTools → Application → IndexedDB, delete the `warehouse-demo-pglite` database, and reload.

- [ ] **Step 2: Log in and open a pending receiving order**

Use `operator` / `DocPal2026!`. Navigate to a pending order such as `RO-240705-001`.

- [ ] **Step 3: Test each mismatch reason**

For the item line, select each reason and save:

- `not_found` — card turns red, badge says "Not found", `receivedQty` becomes 0.
- `damaged` — enter damaged qty 2, badge says "Damaged: 2 of 500", `receivedQty` becomes 498.
- `qty_mismatch` — enter actual qty 450, badge says "Quantity mismatch: received 450 of 500", `receivedQty` becomes 450.
- `wrong_part` — enter wrong part number and qty 10, badge says "Wrong part: PART-123 × 10", `receivedQty` becomes 0.
- `over_shipment` — enter extra qty 50, badge says "Over shipment: +50", `receivedQty` stays 500.
- `quality_rejection` — enter rejected qty 5, badge says "Quality rejection: 5 of 500", `receivedQty` becomes 495.

- [ ] **Step 4: Confirm arrival and verify allocation**

Click "Confirm arrived". The order moves to `in_hand`. Navigate to the linked picking order and confirm only the corrected quantity is allocated.

- [ ] **Step 5: Verify post-arrival lock**

Open an `in_hand` order where the item has already been allocated or picked. Confirm the mismatch form is replaced by "Locked: stock already allocated, picked, or put away."

---

## Self-review against spec

| Spec requirement | Implementing task |
|------------------|-------------------|
| Six mismatch reasons | Task 1, Task 4 |
| One reason per item line | Task 1 (`mismatchReason` column), Task 4 (single select) |
| Quantity mapping by reason | Task 3 (`computeReceivedQty`) |
| Wrong part number input | Task 1, Task 4 |
| No new invoice lines | Task 4 (form stays on existing item) |
| Allowed before and after arrival | Task 4 (template shows for `pending` and `in_hand`) |
| Post-arrival guard | Task 3 (`canEditReceivingItemMismatch`), Task 4 (locked UI) |
| UI shows reason | Task 4 (`formatMismatchSummary`) |
| Audit trail | Task 3 (`transitionLogs` insert) |
| IndexedDB clear note | Task 5 |

No placeholders or TBD items remain.
