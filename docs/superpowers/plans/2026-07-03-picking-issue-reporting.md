# Picking order issue reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add order-level issue reporting to picking orders from the list page, with structured reasons, per-order remarks, and a new `issue` status.

**Architecture:** Extend `picking_orders` with issue columns and a new `issue` status; implement a bulk report modal on the list page and a read-only issue summary on the detail page; guard picking actions and finishing against `issue` orders; record every report in `transition_logs`.

**Tech Stack:** Nuxt 3, Vue 3, PGlite, Drizzle ORM, plain CSS.

**Coordination note:** The `receiving-mismatch` plan is editing `db/schema.ts` and `db/init.ts`. Do **not** start the code changes in this plan until that work is merged/checked in, to avoid conflicts in those shared files.

---

## File map

| File | Change |
|------|--------|
| `db/schema.ts` | Add `issue` to `pickingOrderStatus`, add issue columns and reason enum, add `issueReportedByUser` relation. |
| `db/init.ts` | Add issue columns to the raw `CREATE TABLE picking_orders` SQL. |
| `db/picking.ts` | Add `reportPickingOrderIssues` helper; guard `createShippingBoxForPickingOrder`, `finishPickingOrder`, `addPackageToBox`, `removePackageFromBox`, and `scanAllocationToPackage` against `issue` orders. |
| `components/PickingIssueReportModal.vue` | New modal for reason + conditional fields + per-order remarks. |
| `pages/picking/index.vue` | Add checkboxes, selection state, bottom action bar, and modal integration. |
| `pages/picking/[id].vue` | Show issue summary, disable picking actions, pass badge class to `DetailHeader`. |

---

### Task 1: Update `db/schema.ts`

**Files:**
- Modify: `db/schema.ts`

- [ ] **Step 1: Add the issue reason enum and update the picking order status enum**

Replace:

```typescript
export const pickingOrderStatus = ["pending", "picking", "finished"] as const;
```

With:

```typescript
export const pickingOrderStatus = ["pending", "picking", "finished", "issue"] as const;

export const pickingIssueReasons = [
  "insufficient_stock",
  "cannot_divide",
  "merge",
  "other",
] as const;

export type PickingIssueReason = (typeof pickingIssueReasons)[number];
```

- [ ] **Step 2: Add issue columns to `pickingOrders`**

After `destinationCountry: text("destination_country"),` add:

```typescript
  status: text("status", { enum: pickingOrderStatus }).notNull().default("pending"),
  issueReason: text("issue_reason", { enum: pickingIssueReasons }),
  issueQty: integer("issue_qty"),
  issuePackSize: integer("issue_pack_size"),
  issueNote: text("issue_note"),
  issueRemark: text("issue_remark"),
  issueReportedAt: timestamp("issue_reported_at"),
  issueReportedBy: text("issue_reported_by").references(() => users.id),
```

- [ ] **Step 3: Add the `issueReportedByUser` relation**

Replace:

```typescript
export const pickingOrdersRelations = relations(pickingOrders, ({ one, many }) => ({
  supplier: one(suppliers, { fields: [pickingOrders.supplierId], references: [suppliers.id] }),
  items: many(pickingItems),
  packages: many(pickingPackages),
  measuringTask: one(measuringTasks, { fields: [pickingOrders.id], references: [measuringTasks.pickingOrderId] }),
  shippingBoxes: many(shippingBoxes),
}));
```

With:

```typescript
export const pickingOrdersRelations = relations(pickingOrders, ({ one, many }) => ({
  supplier: one(suppliers, { fields: [pickingOrders.supplierId], references: [suppliers.id] }),
  issueReportedByUser: one(users, { fields: [pickingOrders.issueReportedBy], references: [users.id] }),
  items: many(pickingItems),
  packages: many(pickingPackages),
  measuringTask: one(measuringTasks, { fields: [pickingOrders.id], references: [measuringTasks.pickingOrderId] }),
  shippingBoxes: many(shippingBoxes),
}));
```

- [ ] **Step 4: Generate types**

Run: `pnpm nuxt prepare`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add db/schema.ts
git commit -m "schema: add picking order issue columns and status"
```

---

### Task 2: Update `db/init.ts`

**Files:**
- Modify: `db/init.ts`

- [ ] **Step 1: Add issue columns to `CREATE TABLE picking_orders`**

After `destination_country TEXT,` add:

```sql
  issue_reason TEXT,
  issue_qty INTEGER,
  issue_pack_size INTEGER,
  issue_note TEXT,
  issue_remark TEXT,
  issue_reported_at TIMESTAMP,
  issue_reported_by TEXT REFERENCES users(id),
```

- [ ] **Step 2: Commit**

```bash
git add db/init.ts
git commit -m "db(init): add picking order issue columns"
```

---

### Task 3: Add DB helper and guards in `db/picking.ts`

**Files:**
- Modify: `db/picking.ts`

- [ ] **Step 1: Import `PickingIssueReason` from schema**

Change the existing import from:

```typescript
import * as schema from "./schema";
```

To:

```typescript
import * as schema from "./schema";
import type { PickingIssueReason } from "./schema";
```

- [ ] **Step 2: Add the issue reporting interfaces and helper after `reportPickingItemMismatch`**

```typescript
export interface PickingOrderIssueEntry {
  orderId: string;
  remark?: string | null;
}

export interface PickingOrderIssueInput {
  reason: PickingIssueReason;
  qty?: number | null;
  packSize?: number | null;
  note?: string | null;
}

export async function reportPickingOrderIssues(
  db: PgliteDatabase<typeof schema>,
  entries: PickingOrderIssueEntry[],
  input: PickingOrderIssueInput,
  actorId: string
): Promise<{ reported: number; skipped: number }> {
  if (entries.length === 0) throw new Error("No orders selected");
  if (input.reason === "merge" && entries.length < 2) {
    throw new Error("Select at least two orders to request a merge");
  }
  if (input.reason === "insufficient_stock" && (input.qty == null || input.qty < 0)) {
    throw new Error("Actual quantity is required");
  }
  if (input.reason === "cannot_divide" && (input.packSize == null || input.packSize <= 0)) {
    throw new Error("Pack size is required");
  }

  const orderIds = entries.map((e) => e.orderId);
  const idList = orderIds.map((id) => `'${id}'`).join(", ");

  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT po.id, po.ref_no, po.status,
        (SELECT COALESCE(SUM(pi.qty), 0) FROM picking_items pi WHERE pi.picking_order_id = po.id) AS total_qty
      FROM picking_orders po
      WHERE po.id IN (${sql.raw(idList)})
    `);
    const rows = (result.rows ?? []) as any[];
    const reportable = rows.filter((r) => r.status === "pending" || r.status === "picking");
    if (reportable.length === 0) throw new Error("No reportable orders selected");

    const remarkByOrderId = new Map(entries.map((e) => [e.orderId, e.remark?.trim() || null]));
    const now = new Date();
    let reported = 0;

    for (const row of reportable) {
      const totalQty = Number(row.total_qty) || 0;
      if (input.reason === "insufficient_stock" && input.qty! >= totalQty) {
        throw new Error(`Actual qty for ${row.ref_no} must be less than requested qty`);
      }

      await tx.execute(sql`
        UPDATE picking_orders
        SET status = 'issue',
            issue_reason = ${input.reason},
            issue_qty = ${input.reason === "insufficient_stock" ? input.qty : null},
            issue_pack_size = ${input.reason === "cannot_divide" ? input.packSize : null},
            issue_note = ${input.note?.trim() || null},
            issue_remark = ${remarkByOrderId.get(row.id) || null},
            issue_reported_at = ${now.toISOString()},
            issue_reported_by = ${actorId},
            updated_at = ${now.toISOString()}
        WHERE id = ${row.id}
      `);

      await tx.insert(schema.transitionLogs).values({
        id: uuid(),
        entityType: "picking_order",
        entityId: row.id,
        fromState: row.status,
        toState: "issue",
        actorId,
        metadata: JSON.stringify({
          reason: input.reason,
          qty: input.qty,
          packSize: input.packSize,
          note: input.note,
          remark: remarkByOrderId.get(row.id),
        }),
        createdAt: now,
      });

      reported++;
    }

    return { reported, skipped: orderIds.length - reportable.length };
  });
}
```

- [ ] **Step 3: Update `getPickingOrderDetail` to include the reporter relation**

In the `with` object of `getPickingOrderDetail`, add `issueReportedByUser: true` after `supplier: true`:

```typescript
  return db.query.pickingOrders.findFirst({
    where: eq(schema.pickingOrders.id, id),
    with: {
      supplier: true,
      issueReportedByUser: true,
      measuringTask: true,
      ...
```

- [ ] **Step 4: Guard `createShippingBoxForPickingOrder`**

After:

```typescript
    if (!order) throw new Error("Picking order not found");
    if (order.status === "finished") throw new Error("Picking order is already finished");
```

Add:

```typescript
    if (order.status === "issue") throw new Error("Picking order has an open issue");
```

- [ ] **Step 5: Guard `finishPickingOrder`**

After:

```typescript
    if (!order) throw new Error("Picking order not found");
    if (order.status === "finished") throw new Error("Order is already finished");
    if (order.items.length === 0) throw new Error("No items to pick");
```

Add:

```typescript
    if (order.status === "issue") throw new Error("Picking order has an open issue");
```

- [ ] **Step 6: Guard `addPackageToBox`**

After fetching the box:

```typescript
    if (!box) throw new Error("Box not found");
    if (box.status !== "open") throw new Error("Box is not open");
```

Add:

```typescript
    if (box.pickingOrderId) {
      const order = await tx.query.pickingOrders.findFirst({
        where: eq(schema.pickingOrders.id, box.pickingOrderId),
      });
      if (order?.status === "issue") throw new Error("Picking order has an open issue");
    }
```

- [ ] **Step 7: Guard `removePackageFromBox`**

After fetching the box:

```typescript
    if (!box || box.status !== "open") {
      throw new Error("Box is not open");
    }
```

Add:

```typescript
    if (box.pickingOrderId) {
      const order = await tx.query.pickingOrders.findFirst({
        where: eq(schema.pickingOrders.id, box.pickingOrderId),
      });
      if (order?.status === "issue") throw new Error("Picking order has an open issue");
    }
```

- [ ] **Step 8: Guard `scanAllocationToPackage`**

After:

```typescript
    if (!allocation) throw new Error("Allocation not found");
    if (qty <= 0 || qty > allocation.qty) throw new Error("Invalid scan quantity");
```

Add:

```typescript
    const order = await tx.query.pickingOrders.findFirst({
      where: eq(schema.pickingOrders.id, item.pickingOrderId),
    });
    if (order?.status === "issue") throw new Error("Picking order has an open issue");
```

- [ ] **Step 9: Commit**

```bash
git add db/picking.ts
git commit -m "db(picking): add reportPickingOrderIssues and issue guards"
```

---

### Task 4: Create `components/PickingIssueReportModal.vue`

**Files:**
- Create: `components/PickingIssueReportModal.vue`

- [ ] **Step 1: Write the component**

```vue
<template>
  <div
    v-if="modelValue"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="issue-title"
    @click.self="close"
    @keydown.esc="close"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="issue-title">Report picking issue</h3>
        <button type="button" class="modal__close" aria-label="Close" @click="close">×</button>
      </div>

      <div class="modal__body">
        <form @submit.prevent="submit">
          <label class="field">
            <span>Issue reason</span>
            <select v-model="reason">
              <option value="insufficient_stock">Insufficient stock</option>
              <option value="cannot_divide">Cannot divide quantity</option>
              <option value="merge">Merge orders</option>
              <option value="other">Other</option>
            </select>
          </label>

          <label v-if="reason === 'insufficient_stock'" class="field">
            <span>Actual qty available</span>
            <input v-model.number="qty" type="number" min="0" step="1" placeholder="e.g. 5" />
            <span v-if="errors.qty" class="error">{{ errors.qty }}</span>
          </label>

          <label v-if="reason === 'cannot_divide'" class="field">
            <span>Pack size</span>
            <input v-model.number="packSize" type="number" min="1" step="1" placeholder="e.g. 20000" />
            <span v-if="errors.packSize" class="error">{{ errors.packSize }}</span>
          </label>

          <div class="field">
            <span>Per-order remarks</span>
            <div v-for="o in orders" :key="o.id" class="remark-row">
              <div class="remark-header">
                <strong>{{ o.ref_no }}</strong>
                <span v-if="reason === 'cannot_divide'" class="muted">Requested: {{ o.totalQty }}</span>
              </div>
              <input v-model="remarks[o.id]" type="text" placeholder="Remark for this order" />
            </div>
          </div>

          <label class="field">
            <span>Common note</span>
            <textarea v-model="note" rows="2" placeholder="Note applied to all selected orders" />
          </label>

          <div v-if="errors.reason" class="error">{{ errors.reason }}</div>

          <div class="actions">
            <button type="button" class="btn btn--secondary" @click="close">Cancel</button>
            <button type="submit" class="btn" :disabled="saving">
              {{ saving ? "Saving…" : "Save issue" }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PickingIssueReason } from "~/db/schema";

interface OrderOption {
  id: string;
  ref_no: string;
  totalQty: number;
}

const props = defineProps<{
  modelValue: boolean;
  orders: OrderOption[];
  saving?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "saved", payload: {
    reason: PickingIssueReason;
    qty: number | null;
    packSize: number | null;
    note: string | null;
    remarks: Record<string, string>;
  }): void;
  (e: "cancelled"): void;
}>();

const reason = ref<PickingIssueReason>("insufficient_stock");
const qty = ref<number | null>(null);
const packSize = ref<number | null>(null);
const note = ref("");
const remarks = ref<Record<string, string>>({});
const errors = ref<Record<string, string>>({});

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      reason.value = "insufficient_stock";
      qty.value = null;
      packSize.value = null;
      note.value = "";
      errors.value = {};
      const next: Record<string, string> = {};
      for (const o of props.orders) {
        next[o.id] = "";
      }
      remarks.value = next;
    }
  },
  { immediate: true }
);

function close() {
  emit("update:modelValue", false);
  emit("cancelled");
}

function validate(): boolean {
  errors.value = {};
  if (reason.value === "merge" && props.orders.length < 2) {
    errors.value.reason = "Select at least two orders to request a merge";
  }
  if (reason.value === "insufficient_stock") {
    if (qty.value == null || qty.value < 0) {
      errors.value.qty = "Enter a valid available quantity";
    }
  }
  if (reason.value === "cannot_divide") {
    if (packSize.value == null || packSize.value <= 0) {
      errors.value.packSize = "Enter a valid pack size";
    }
  }
  if (
    reason.value === "other" &&
    !note.value.trim() &&
    !Object.values(remarks.value).some((r) => r.trim())
  ) {
    errors.value.reason = "Enter a note or at least one remark";
  }
  return Object.keys(errors.value).length === 0;
}

function submit() {
  if (!validate()) return;
  emit("saved", {
    reason: reason.value,
    qty: reason.value === "insufficient_stock" ? qty.value : null,
    packSize: reason.value === "cannot_divide" ? packSize.value : null,
    note: note.value.trim() || null,
    remarks: remarks.value,
  });
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
  max-width: 480px;
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
  font-size: 1.0625rem;
}

.modal__close {
  background: transparent;
  border: none;
  font-size: 1.5rem;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
}

.modal__body {
  padding: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-bottom: 1rem;
}

.field > span:first-child {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
}

.field input,
.field select,
.field textarea {
  width: 100%;
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 1rem;
  background: var(--surface);
}

.remark-row {
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 0.5rem;
}

.remark-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.35rem;
  font-size: 0.875rem;
}

.muted {
  color: var(--muted);
  font-size: 0.8125rem;
}

.error {
  color: var(--danger);
  font-size: 0.8125rem;
}

.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}

.actions .btn {
  flex: 1;
}

.btn {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--primary);
  border-radius: var(--radius);
  background: var(--primary);
  color: #fff;
  font-size: 0.9375rem;
  font-weight: 600;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn--secondary {
  background: var(--surface);
  color: var(--text);
  border-color: var(--border);
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add components/PickingIssueReportModal.vue
git commit -m "feat: add PickingIssueReportModal component"
```

---

### Task 5: Update `pages/picking/index.vue`

**Files:**
- Modify: `pages/picking/index.vue`

- [ ] **Step 1: Update the `<template>`**

Replace the entire `<template>` block with:

```vue
<template>
  <div>
    <input
      v-model="search"
      class="search"
      type="text"
      placeholder="Search by ref or supplier…"
    />

    <p v-if="loading" class="empty">Loading…</p>
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">Error: {{ loadError }}</p>
    <p v-else-if="reportMessage" class="empty" style="color: #92400e;">{{ reportMessage }}</p>
    <p v-else-if="rows.length === 0" class="empty">No picking orders found.</p>

    <div
      v-for="po in rows"
      :key="po.id"
      class="card list-card"
      :class="{ 'card--disabled': !isSelectable(po.status) }"
    >
      <div class="list-card__header">
        <div style="display: flex; align-items: flex-start; gap: 0.75rem; flex: 1;">
          <input
            v-if="isSelectable(po.status)"
            type="checkbox"
            :checked="selectedIds.has(po.id)"
            @change="toggleSelection(po.id)"
          />
          <NuxtLink :to="`/picking/${po.id}`" class="list-card__title">
            {{ po.ref_no }}
          </NuxtLink>
        </div>
        <span class="badge" :class="badgeClass(po.status)">{{ po.status }}</span>
      </div>
      <p class="list-card__meta">
        {{ po.supplier_name || "No supplier" }}
      </p>
      <div class="list-card__footer">
        <span class="list-card__date">
          {{ po.delivery_date ? new Date(po.delivery_date).toLocaleDateString() : "No date" }}
        </span>
        <span class="list-card__ship">Ship to: {{ po.ship_to || "—" }}</span>
      </div>
    </div>

    <div v-if="hasSelection" class="bulk-actions">
      <span>{{ selectedOrders.length }} selected</span>
      <button class="btn btn--small btn--danger" @click="openModal">
        Report issue
      </button>
    </div>

    <PickingIssueReportModal
      v-model="modalOpen"
      :orders="selectedOrders"
      :saving="reporting"
      @saved="onReportSaved"
    />
  </div>
</template>
```

- [ ] **Step 2: Update the `<script>` block**

Replace the entire `<script setup>` block with:

```vue
<script setup lang="ts">
definePageMeta({ title: "Picking" });

interface PickingOrderRow {
  id: string;
  ref_no: string;
  status: string;
  delivery_date: string | null;
  supplier_name: string | null;
  ship_to: string | null;
  total_qty: number;
}

const db = await useDb();
const currentUser = await useCurrentUser();

const search = ref("");
const rawRows = ref<PickingOrderRow[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const reportMessage = ref<string | null>(null);
const selectedIds = ref<Set<string>>(new Set());
const modalOpen = ref(false);
const reporting = ref(false);

async function load() {
  loading.value = true;
  loadError.value = null;
  reportMessage.value = null;
  try {
    const result = await db.execute<PickingOrderRow>(
      `SELECT po.id, po.ref_no, po.status, po.delivery_date, po.ship_to, s.name AS supplier_name,
        (SELECT COALESCE(SUM(pi.qty), 0) FROM picking_items pi WHERE pi.picking_order_id = po.id) AS total_qty
       FROM picking_orders po
       LEFT JOIN suppliers s ON po.supplier_id = s.id
       ORDER BY CASE WHEN po.status = 'finished' THEN 1 ELSE 0 END, po.delivery_date;`
    );
    rawRows.value = result.rows ?? [];
  } catch (e: any) {
    loadError.value = e?.message ?? String(e);
    rawRows.value = [];
  } finally {
    loading.value = false;
  }
}

const rows = computed(() => {
  const term = search.value.trim().toLowerCase();
  if (!term) return rawRows.value;
  return rawRows.value.filter(
    (r) =>
      r.ref_no.toLowerCase().includes(term) ||
      (r.supplier_name?.toLowerCase().includes(term) ?? false)
  );
});

const selectedOrders = computed(() =>
  rawRows.value.filter((r) => selectedIds.value.has(r.id))
);

const hasSelection = computed(() => selectedOrders.value.length > 0);

function isSelectable(status: string) {
  return status !== "finished" && status !== "issue";
}

function toggleSelection(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selectedIds.value = next;
}

function openModal() {
  if (!hasSelection.value) return;
  modalOpen.value = true;
}

async function onReportSaved(payload: {
  reason: "insufficient_stock" | "cannot_divide" | "merge" | "other";
  qty: number | null;
  packSize: number | null;
  note: string | null;
  remarks: Record<string, string>;
}) {
  reporting.value = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    const { reportPickingOrderIssues } = await import("~/db/picking");
    const entries = selectedOrders.value.map((o) => ({
      orderId: o.id,
      remark: payload.remarks[o.id]?.trim() || null,
    }));
    const result = await reportPickingOrderIssues(
      db,
      entries,
      {
        reason: payload.reason,
        qty: payload.qty,
        packSize: payload.packSize,
        note: payload.note,
      },
      currentUser.id
    );
    selectedIds.value = new Set();
    modalOpen.value = false;
    await load();
    if (result.skipped > 0) {
      reportMessage.value = `${result.reported} issue(s) reported; ${result.skipped} order(s) skipped because they were already finished or had an issue.`;
    }
  } catch (e: any) {
    loadError.value = e?.message ?? String(e);
  } finally {
    reporting.value = false;
  }
}

function badgeClass(status: string) {
  if (status === "finished") return "badge--finished";
  if (status === "pending") return "badge--pending";
  if (status === "issue") return "badge--danger";
  return "";
}

onMounted(() => {
  load();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("focus", onVisible);
});

function onVisible() {
  if (document.visibilityState === "visible") {
    load();
  }
}
</script>
```

- [ ] **Step 3: Add bulk action styles**

Append to the existing `<style scoped>` block:

```css
.bulk-actions {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--surface);
  border-top: 1px solid var(--border);
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.06);
}

.list-card__title {
  color: var(--text);
  text-decoration: none;
}

.list-card__title:hover {
  text-decoration: underline;
}

.card--disabled {
  opacity: 0.65;
}

.list-card:last-child {
  margin-bottom: 5rem;
}
```

- [ ] **Step 4: Generate types**

Run: `pnpm nuxt prepare`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add pages/picking/index.vue
git commit -m "feat(picking): multi-select list and report issue action"
```

---

### Task 6: Update `pages/picking/[id].vue`

**Files:**
- Modify: `pages/picking/[id].vue`

- [ ] **Step 1: Add issue summary card and disable actions**

Replace the existing `<DetailHeader>` block with:

```vue
      <DetailHeader
        v-model="headerExpanded"
        :title="order.refNo"
        :status="order.status"
        :badge-class="headerBadgeClass"
        :flush-top="route.meta.props?.noPadding"
        style="margin-bottom: 1.5rem;"
      >
        <template #actions>
          <template v-if="order.status !== 'finished' && order.status !== 'issue'">
            <button class="btn btn--small" :disabled="creatingBox" @click="createBox">
              {{ creatingBox ? "Creating…" : "Create box" }}
            </button>
            <button
              v-if="allItemsFullyBoxed"
              class="btn btn--small"
              :disabled="finishing"
              @click="finish"
            >
              {{ finishing ? "Finishing…" : "Finish picking" }}
            </button>
          </template>
          <NuxtLink
            v-if="order.status === 'finished' && order.measuringTask"
            :to="`/measuring/${order.measuringTask.id}`"
            class="btn btn--small"
          >
            Measuring
          </NuxtLink>
        </template>

        <div class="detail-row">
          <span class="detail-label">Supplier</span>
          <span>{{ order.supplier?.name || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Delivery date</span>
          <span>{{ order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">PO No.</span>
          <span>{{ order.poNo || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Ship to</span>
          <span>{{ order.shipTo || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Date-code notice</span>
          <span>{{ order.requiredDateCodeNotice || "—" }}</span>
        </div>
      </DetailHeader>
```

- [ ] **Step 2: Insert the issue summary card after `</DetailHeader>`**

After:

```vue
      </DetailHeader>
```

Add:

```vue

      <div v-if="order.status === 'issue'" class="card card--danger" style="margin-bottom: 1.5rem;">
        <div class="detail-row">
          <span class="detail-label">Issue reason</span>
          <span>{{ issueReasonLabel(order.issueReason) }}</span>
        </div>
        <div v-if="order.issueQty != null" class="detail-row">
          <span class="detail-label">Actual qty available</span>
          <span>{{ order.issueQty }}</span>
        </div>
        <div v-if="order.issuePackSize != null" class="detail-row">
          <span class="detail-label">Pack size</span>
          <span>{{ order.issuePackSize }}</span>
        </div>
        <div v-if="order.issueRemark" class="detail-row">
          <span class="detail-label">Remark</span>
          <span>{{ order.issueRemark }}</span>
        </div>
        <div v-if="order.issueNote" class="detail-row">
          <span class="detail-label">Note</span>
          <span>{{ order.issueNote }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Reported</span>
          <span>
            {{ order.issueReportedAt ? new Date(order.issueReportedAt).toLocaleString() : "—" }}
            by {{ order.issueReportedByUser?.displayName || order.issueReportedBy || "—" }}
          </span>
        </div>
      </div>
```

- [ ] **Step 3: Disable allocations and item-level mismatch when order is in issue**

Change:

```vue
        <div v-if="item.allocations?.filter((a: any) => a.qty > 0).length && order.status !== 'finished' && item.pickedQty < item.qty" style="margin-top: 0.75rem;">
```

To:

```vue
        <div v-if="item.allocations?.filter((a: any) => a.qty > 0).length && order.status !== 'finished' && order.status !== 'issue' && item.pickedQty < item.qty" style="margin-top: 0.75rem;">
```

Change:

```vue
        <div v-if="order.status !== 'finished'" style="margin-top: 0.75rem; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
```

To:

```vue
        <div v-if="order.status !== 'finished' && order.status !== 'issue'" style="margin-top: 0.75rem; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
```

- [ ] **Step 4: Add helper and computed in `<script>`**

After:

```typescript
const allItemsFullyBoxed = computed(
  () => order.value?.items?.every((i: any) => i.pickedQty >= i.qty) ?? false
);
```

Add:

```typescript
const headerBadgeClass = computed(() => {
  if (order.value?.status === "finished") return "badge--finished";
  if (order.value?.status === "issue") return "badge--danger";
  return "";
});

function issueReasonLabel(reason: string | null) {
  if (reason === "insufficient_stock") return "Insufficient stock";
  if (reason === "cannot_divide") return "Cannot divide quantity";
  if (reason === "merge") return "Merge orders";
  if (reason === "other") return "Other";
  return "—";
}
```

- [ ] **Step 5: Add the `.card--danger` style**

Append to the existing `<style scoped>` block:

```css
.card--danger {
  border-left: 4px solid #dc2626;
}
```

- [ ] **Step 6: Generate types**

Run: `pnpm nuxt prepare`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add pages/picking/[id].vue
git commit -m "feat(picking): show issue summary and disable actions for issue orders"
```

---

### Task 7: Verification

- [ ] **Step 1: Type check and build**

Run:

```bash
pnpm nuxt prepare
pnpm generate
```

Expected: both complete without errors.

- [ ] **Step 2: Clear IndexedDB**

In the browser, open DevTools → Application → IndexedDB → delete the `idb://warehouse-demo-pglite` database, then reload the app.

- [ ] **Step 3: Manual test — insufficient stock**

1. Log in as `operator` / `DocPal2026!`.
2. Go to **Picking**.
3. Select one pending order, tap **Report issue**.
4. Choose **Insufficient stock**, enter an actual qty less than the order total, add a per-order remark, and save.
5. Verify the order now shows a red **issue** badge on the list.
6. Open the order detail and verify:
   - The issue summary card is visible.
   - **Create box**, **Scan**, **Add to box**, and **Finish picking** are gone/disabled.

- [ ] **Step 4: Manual test — merge**

1. Select two pending orders on the picking list.
2. Tap **Report issue**, choose **Merge orders**, add a common note and per-order remarks.
3. Save and verify both orders show the **issue** badge.
4. Try to report an issue on a finished order and confirm it is skipped/ignored.

- [ ] **Step 5: Audit trail check**

Run in the browser console or query PGlite:

```sql
SELECT entity_id, from_state, to_state, metadata FROM transition_logs WHERE entity_type = 'picking_order' AND to_state = 'issue';
```

Expected: one row per reported order with the reason and quantities in `metadata`.

- [ ] **Step 6: Commit verification notes (optional)**

```bash
git commit --allow-empty -m "verify: picking issue reporting manual tests pass"
```

---

## Plan self-review

- **Spec coverage:**
  - Order-level reporting from the list page → Task 5.
  - Multi-select with shared reason/details + per-order remark → Task 4 modal and Task 5 entries.
  - `insufficient_stock`, `cannot_divide`, `merge`, `other` reasons → Task 4 modal and Task 3 helper.
  - New `issue` status and locked picking actions → Task 3 guards + Task 6 detail UI.
  - Audit trail in `transition_logs` → Task 3 helper.
  - No edit/undo on PDA → enforced by skipping finished/issue orders and no edit UI.
- **Placeholder scan:** No TBD/TODO placeholders; all steps include runnable code or exact commands.
- **Type consistency:** `PickingIssueReason` is used in `db/schema.ts`, `db/picking.ts`, and the modal. Column names use camelCase in Drizzle and snake_case in raw SQL consistently.
