# Allocate Picking at Receiving-Order Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change allocations from invoice-item level to receiving-order + part level, allowing scan-time FIFO consumption across multiple invoice items for the same part.

**Architecture:** Replace `allocations.receiving_invoice_item_id` with `allocations.receiving_order_id`; keep packages and inventory lot sources tied to concrete invoice items by selecting them at scan time; update all queries, services, matchers, seed generation, and tests that reference the old column.

**Tech Stack:** Nuxt 3, Vue 3, PGlite, Drizzle ORM, TypeScript, Vitest

---

## File structure

| File | Responsibility |
|------|----------------|
| `db/schema.ts` | Drizzle schema: replace allocation column and relations |
| `db/init.ts` | Raw SQL bootstrap: replace allocation column and index |
| `db/helpers.ts` | `allocationsCte` and `availableReceivingQtySql` now aggregate by receiving order + part |
| `db/ocrPicking.ts` | Picking candidate lookup and `applyOcrPick` scan application with split-across-invoice consumption |
| `db/allocate.ts` | Allocation insertion now uses `receivingOrderId`; receiving-area query aggregates by receiving order |
| `db/picking.ts` | `materializeReceivingAllocation` accepts explicit invoice item; boxing/unboxing/cancellation handles coarse allocations |
| `db/receiving.ts` | `tryMarkReceivingOrderClear` / `tryMarkReceivingOrderInHand` use receiving-order + part aggregation |
| `services/types.ts` | DTOs expose `receivingOrderId` instead of `receivingInvoiceItemId` in allocation contexts |
| `services/warehouse.ts` | `applyOcrPick` interface uses `receivingOrderId` |
| `services/adapters/pgliteWarehouse.ts` | Adapter passes `receivingOrderId`; receiving list/detail allocation joins updated |
| `services/adapters/apiWarehouse.ts` | Stub signature updated |
| `composables/useScanMatchers.ts` | `matchPicking` uses `receivingOrderId`; receiving candidate passes order id |
| `scripts/generate-wcl-seed.mjs` | Allocation generation emits `receivingOrderId` grouped by order + part |
| `scripts/picking-seed-output.ts` | Updated allocation records |
| `db/seed-precalc.ts` | Updated allocation records |
| `db/seed.ts` | Updated allocation records |
| `tests/picking.test.ts` | Allocation setup updated; regression test added |
| `tests/scanMatchers.test.ts` | Allocation setup updated |
| `tests/putAway.test.ts` | Allocation setup updated |
| `tests/goodsVerify.test.ts` | Allocation setup updated |
| `tests/mismatch.test.ts` | Allocation setup updated |
| `tests/seed-precalc.test.ts` | Allocation assertions updated |

---

### Task 1: Schema migration

**Files:**
- Modify: `db/schema.ts:230-241`
- Modify: `db/schema.ts:323-340`
- Modify: `db/schema.ts:383-387`
- Modify: `db/init.ts:165-175`
- Modify: `db/init.ts:265`

- [ ] **Step 1: Update `allocations` table in `db/schema.ts`**

Replace:
```typescript
export const allocations = pgTable("allocations", {
  id: text("id").primaryKey(),
  pickingItemId: text("picking_item_id")
    .notNull()
    .references(() => pickingItems.id, { onDelete: "cascade" }),
  inventoryLotId: text("inventory_lot_id")
    .references(() => inventoryLots.id, { onDelete: "cascade" }),
  receivingInvoiceItemId: text("receiving_invoice_item_id")
    .references(() => receivingInvoiceItems.id, { onDelete: "cascade" }),
  qty: integer("qty").notNull(),
});
```

With:
```typescript
export const allocations = pgTable("allocations", {
  id: text("id").primaryKey(),
  pickingItemId: text("picking_item_id")
    .notNull()
    .references(() => pickingItems.id, { onDelete: "cascade" }),
  inventoryLotId: text("inventory_lot_id")
    .references(() => inventoryLots.id, { onDelete: "cascade" }),
  receivingOrderId: text("receiving_order_id")
    .references(() => receivingOrders.id, { onDelete: "cascade" }),
  qty: integer("qty").notNull(),
});
```

- [ ] **Step 2: Update relations in `db/schema.ts`**

In `receivingInvoiceItemsRelations`, remove `allocations: many(allocations),`.

In `receivingOrdersRelations`, add `allocations: many(allocations),`:
```typescript
export const receivingOrdersRelations = relations(receivingOrders, ({ many, one }) => ({
  supplier: one(suppliers, { fields: [receivingOrders.supplierId], references: [suppliers.id] }),
  invoices: many(receivingInvoices),
  shelfBoxes: many(shelfBoxes),
  allocations: many(allocations),
}));
```

In `allocationsRelations`, replace `receivingInvoiceItem` with `receivingOrder`:
```typescript
export const allocationsRelations = relations(allocations, ({ one }) => ({
  pickingItem: one(pickingItems, { fields: [allocations.pickingItemId], references: [pickingItems.id] }),
  inventoryLot: one(inventoryLots, { fields: [allocations.inventoryLotId], references: [inventoryLots.id] }),
  receivingOrder: one(receivingOrders, { fields: [allocations.receivingOrderId], references: [receivingOrders.id] }),
}));
```

- [ ] **Step 3: Update raw SQL in `db/init.ts`**

Replace the `allocations` table block:
```sql
CREATE TABLE IF NOT EXISTS allocations (
  id TEXT PRIMARY KEY,
  picking_item_id TEXT NOT NULL REFERENCES picking_items(id) ON DELETE CASCADE,
  inventory_lot_id TEXT REFERENCES inventory_lots(id) ON DELETE CASCADE,
  receiving_invoice_item_id TEXT REFERENCES receiving_invoice_items(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL
);
```

With:
```sql
CREATE TABLE IF NOT EXISTS allocations (
  id TEXT PRIMARY KEY,
  picking_item_id TEXT NOT NULL REFERENCES picking_items(id) ON DELETE CASCADE,
  inventory_lot_id TEXT REFERENCES inventory_lots(id) ON DELETE CASCADE,
  receiving_order_id TEXT REFERENCES receiving_orders(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL
);
```

Replace `CREATE INDEX IF NOT EXISTS idx_allocations_receiving_item ON allocations(receiving_invoice_item_id);`
with `CREATE INDEX IF NOT EXISTS idx_allocations_receiving_order ON allocations(receiving_order_id);`.

- [ ] **Step 4: Run type generation**

Run: `pnpm nuxt prepare`
Expected: completes without errors.

- [ ] **Step 5: Commit**

```bash
git add db/schema.ts db/init.ts
git commit -m "schema: allocations link to receiving_order_id"
```

---

### Task 2: Update allocation helpers

**Files:**
- Modify: `db/helpers.ts`

- [ ] **Step 1: Rewrite `allocationsCte` to aggregate by receiving order + part**

Replace the entire file content of `db/helpers.ts` with:

```typescript
import { sql } from "drizzle-orm";

export const availableReceivingQtySql = sql`
  rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0) - COALESCE(alloc.unboxed_scanned_qty, 0)
`;

/**
 * Returns per-item reservation totals used by `availableReceivingQtySql`.
 * Includes picking allocations plus unboxed put-away scans, both of which
 * reserve quantity from the receiving item.
 *
 * Allocations are now at receiving-order + part level, so allocated_qty
 * for a receiving invoice item is the sum of allocations against the same
 * receiving order and same part.
 */
export function allocationsCte() {
  return sql`
    SELECT
      receiving_invoice_item_id,
      SUM(allocated_qty) AS allocated_qty,
      SUM(unboxed_scanned_qty) AS unboxed_scanned_qty
    FROM (
      SELECT
        rii.id AS receiving_invoice_item_id,
        COALESCE(SUM(a.qty), 0) AS allocated_qty,
        0 AS unboxed_scanned_qty
      FROM receiving_invoice_items rii
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      JOIN allocations a ON a.receiving_order_id = ri.receiving_order_id
      JOIN picking_items pi ON pi.id = a.picking_item_id
      WHERE pi.part_id = rii.part_id
      GROUP BY rii.id
      UNION ALL
      SELECT
        receiving_invoice_item_id,
        0 AS allocated_qty,
        SUM(qty) AS unboxed_scanned_qty
      FROM put_away_scans
      WHERE shelf_box_id IS NULL
      GROUP BY receiving_invoice_item_id
    ) combined
    GROUP BY receiving_invoice_item_id
  `;
}
```

- [ ] **Step 2: Commit**

```bash
git add db/helpers.ts
git commit -m "helpers: aggregate allocations by receiving order + part"
```

---

### Task 3: Update `db/allocate.ts`

**Files:**
- Modify: `db/allocate.ts:98-145`

- [ ] **Step 1: Change receiving-area allocation query to use receiving order**

In the Phase 2 raw SQL query, replace:
```typescript
          SELECT
            rii.id,
            rii.date_code,
            rii.received_qty,
            rii.picked_qty,
            rii.put_away_qty,
            COALESCE(SUM(a.qty), 0) AS allocated_qty,
            ro.delivery_date
          FROM receiving_invoice_items rii
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
          LEFT JOIN allocations a ON a.receiving_invoice_item_id = rii.id
          WHERE rii.part_id = ${item.partId}
            AND ro.status = 'in_hand'
          GROUP BY rii.id, rii.date_code, rii.received_qty, rii.picked_qty, rii.put_away_qty, ro.delivery_date
          HAVING rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(SUM(a.qty), 0) > 0
          ORDER BY ro.delivery_date ASC, rii.date_code ASC NULLS LAST
```

With:
```typescript
          SELECT
            rii.id,
            rii.date_code,
            rii.received_qty,
            rii.picked_qty,
            rii.put_away_qty,
            COALESCE(SUM(a.qty), 0) AS allocated_qty,
            ro.id AS receiving_order_id,
            ro.delivery_date,
            ri.invoice_no
          FROM receiving_invoice_items rii
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
          LEFT JOIN allocations a ON a.receiving_order_id = ro.id
            AND EXISTS (
              SELECT 1 FROM picking_items pi
              WHERE pi.id = a.picking_item_id AND pi.part_id = rii.part_id
            )
          WHERE rii.part_id = ${item.partId}
            AND ro.status = 'in_hand'
          GROUP BY rii.id, rii.date_code, rii.received_qty, rii.picked_qty, rii.put_away_qty, ro.id, ro.delivery_date, ri.invoice_no
          HAVING rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(SUM(a.qty), 0) > 0
          ORDER BY ro.delivery_date ASC NULLS LAST, ri.invoice_no ASC, rii.date_code ASC NULLS LAST
```

- [ ] **Step 2: Update row mapping and allocation insertion**

In `interface ReceivingItemRow` (around line 35), add `receivingOrderId`:
```typescript
interface ReceivingItemRow {
  id: string;
  dateCode: string | null;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  allocatedQty: number;
  receivingOrderId: string;
  deliveryDate: string | null;
}
```

In the row mapping (around line 119), add `receivingOrderId`:
```typescript
        const rows: ReceivingItemRow[] = result.rows.map((row) => ({
          id: row.id as string,
          dateCode: row.date_code as string | null,
          receivedQty: Number(row.received_qty),
          pickedQty: Number(row.picked_qty),
          putAwayQty: Number(row.put_away_qty),
          allocatedQty: Number(row.allocated_qty),
          receivingOrderId: row.receiving_order_id as string,
          deliveryDate: row.delivery_date as string | null,
        }));
```

Replace:
```typescript
          await tx.insert(schema.allocations).values({
            id: uuid(),
            pickingItemId: item.id,
            receivingInvoiceItemId: row.id,
            qty: take,
          });
```

With:
```typescript
          await tx.insert(schema.allocations).values({
            id: uuid(),
            pickingItemId: item.id,
            receivingOrderId: row.receivingOrderId,
            qty: take,
          });
```

- [ ] **Step 3: Commit**

```bash
git add db/allocate.ts
git commit -m "allocate: create allocations at receiving-order level"
```

---

### Task 4: Update `db/ocrPicking.ts`

**Files:**
- Modify: `db/ocrPicking.ts:94-145` (findPickingCandidates)
- Modify: `db/ocrPicking.ts:232-282` (findPickingCandidatesForOrder)
- Modify: `db/ocrPicking.ts:284-402` (applyOcrPick)

- [ ] **Step 1: Update `findPickingCandidates` EXISTS subquery**

Replace the EXISTS subquery:
```typescript
        AND EXISTS (
          SELECT 1
          FROM picking_items pi2
          JOIN allocations a ON a.picking_item_id = pi2.id
          JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE pi2.picking_order_id = po.id
            AND ri.receiving_order_id = ${receivingOrderId}
        )
```

With:
```typescript
        AND EXISTS (
          SELECT 1
          FROM picking_items pi2
          JOIN allocations a ON a.picking_item_id = pi2.id
          WHERE pi2.picking_order_id = po.id
            AND a.receiving_order_id = ${receivingOrderId}
        )
```

- [ ] **Step 2: Update `findPickingCandidatesForOrder` EXISTS subquery**

Same replacement as Step 1 in the second function.

- [ ] **Step 3: Rewrite `applyOcrPick` signature and body**

Change signature from:
```typescript
export async function applyOcrPick(
  db: PgliteDatabase<typeof schema>,
  receivingInvoiceItemId: string,
  pickingItemId: string,
  qty: number,
  ...
```

To:
```typescript
export async function applyOcrPick(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string,
  pickingItemId: string,
  qty: number,
  ...
```

Rewrite the transaction body. The new logic:

```typescript
  return db.transaction(async (tx) => {
    const [receivingOrder] = await tx
      .select()
      .from(schema.receivingOrders)
      .where(eq(schema.receivingOrders.id, receivingOrderId));
    if (!receivingOrder) throw new I18nError("receiving_order_not_found");
    if (receivingOrder.status !== "in_hand") throw new I18nError("receiving_order_not_in_hand");

    const [pickingItem] = await tx
      .select()
      .from(schema.pickingItems)
      .where(eq(schema.pickingItems.id, pickingItemId));
    if (!pickingItem) throw new I18nError("picking_item_not_found");

    const partInOrder = await tx.execute(sql`
      SELECT 1
      FROM receiving_orders ro
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      WHERE ro.id = ${receivingOrderId}
        AND rii.part_id = ${pickingItem.partId}
      LIMIT 1
    `);
    if ((partInOrder.rows ?? []).length === 0) {
      throw new I18nError("receiving_picking_part_mismatch");
    }

    const scannedResult = await tx
      .select({
        total: sql<number>`coalesce(sum(${schema.pickingPackages.qty}), 0)`.mapWith(Number),
      })
      .from(schema.pickingPackages)
      .where(
        and(
          eq(schema.pickingPackages.pickingItemId, pickingItemId),
          isNull(schema.pickingPackages.shippingBoxId)
        )
      );
    const scannedNotBoxed = scannedResult[0]?.total ?? 0;
    const remaining = pickingItem.qty - pickingItem.pickedQty - scannedNotBoxed;
    if (qty > remaining) throw new I18nError("quantity_exceeds_picking_need");

    const existingAllocations = await tx
      .select()
      .from(schema.allocations)
      .where(
        sql`${schema.allocations.receivingOrderId} = ${receivingOrderId}
          AND ${schema.allocations.pickingItemId} = ${pickingItemId}
          AND ${schema.allocations.qty} > 0`
      )
      .orderBy(schema.allocations.id);
    const existingTotal = existingAllocations.reduce((sum, a) => sum + a.qty, 0);

    // Determine physical availability for this part in the receiving order,
    // minus reservations held by other picking items for the same part.
    const availabilityResult = await tx.execute(sql`
      SELECT
        COALESCE(SUM(rii.received_qty - rii.picked_qty - rii.put_away_qty), 0) AS physical_qty,
        COALESCE(SUM(other_alloc.qty), 0) AS reserved_by_others
      FROM receiving_orders ro
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      LEFT JOIN allocations other_alloc
        ON other_alloc.receiving_order_id = ro.id
        AND other_alloc.picking_item_id != ${pickingItemId}
        AND EXISTS (
          SELECT 1 FROM picking_items pi
          WHERE pi.id = other_alloc.picking_item_id AND pi.part_id = rii.part_id
        )
      WHERE ro.id = ${receivingOrderId}
        AND rii.part_id = ${pickingItem.partId}
    `);
    const availabilityRow = availabilityResult.rows[0] as any;
    const physicalQty = Number(availabilityRow.physical_qty ?? 0);
    const reservedByOthers = Number(availabilityRow.reserved_by_others ?? 0);
    const availableForScan = physicalQty - reservedByOthers;
    if (qty > availableForScan) {
      throw new I18nError("quantity_not_available_receiving");
    }

    const left = Math.max(0, qty - existingTotal);
    if (left > 0) {
      const unallocatedDemand = pickingItem.qty - pickingItem.pickedQty - pickingItem.allocatedQty - scannedNotBoxed;
      if (left > unallocatedDemand) {
        throw new I18nError("quantity_exceeds_unallocated_picking_need");
      }
      await tx.insert(schema.allocations).values({
        id: uuid(),
        pickingItemId,
        receivingOrderId,
        qty: left,
      });
      await tx
        .update(schema.pickingItems)
        .set({ allocatedQty: sql`${schema.pickingItems.allocatedQty} + ${left}` })
        .where(eq(schema.pickingItems.id, pickingItemId));
    }

    // Select concrete invoice items and split the scan qty across them.
    const invoiceItems = await tx.execute(sql`
      SELECT
        rii.id AS receiving_invoice_item_id,
        rii.received_qty,
        rii.picked_qty,
        rii.put_away_qty,
        rii.date_code,
        COALESCE(SUM(other_alloc.qty), 0) AS reserved_by_others,
        (
          SELECT COALESCE(SUM(pas.qty), 0)
          FROM put_away_scans pas
          WHERE pas.receiving_invoice_item_id = rii.id
            AND pas.shelf_box_id IS NULL
        ) AS unboxed_scanned_qty
      FROM receiving_orders ro
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      LEFT JOIN allocations other_alloc
        ON other_alloc.receiving_order_id = ro.id
        AND other_alloc.picking_item_id != ${pickingItemId}
        AND EXISTS (
          SELECT 1 FROM picking_items pi
          WHERE pi.id = other_alloc.picking_item_id AND pi.part_id = rii.part_id
        )
      WHERE ro.id = ${receivingOrderId}
        AND rii.part_id = ${pickingItem.partId}
      GROUP BY rii.id, rii.received_qty, rii.picked_qty, rii.put_away_qty, rii.date_code, ri.invoice_no, ro.delivery_date
      HAVING rii.received_qty - rii.picked_qty - rii.put_away_qty -
        COALESCE(SUM(other_alloc.qty), 0) -
        (
          SELECT COALESCE(SUM(pas.qty), 0)
          FROM put_away_scans pas
          WHERE pas.receiving_invoice_item_id = rii.id
            AND pas.shelf_box_id IS NULL
        ) > 0
      ORDER BY ro.delivery_date ASC NULLS LAST, ri.invoice_no ASC, rii.date_code ASC NULLS LAST
    `);

    let remainingScan = qty;
    for (const raw of invoiceItems.rows ?? []) {
      if (remainingScan <= 0) break;
      const available =
        Number(raw.received_qty) -
        Number(raw.picked_qty) -
        Number(raw.put_away_qty) -
        Number(raw.reserved_by_others) -
        Number(raw.unboxed_scanned_qty);
      if (available <= 0) continue;
      const use = Math.min(remainingScan, available);
      const receivingInvoiceItemId = String(raw.receiving_invoice_item_id);

      const [allocation] = await tx
        .select()
        .from(schema.allocations)
        .where(
          sql`${schema.allocations.receivingOrderId} = ${receivingOrderId}
            AND ${schema.allocations.pickingItemId} = ${pickingItemId}
            AND ${schema.allocations.qty} > 0`
        )
        .orderBy(schema.allocations.id)
        .limit(1);
      if (!allocation) throw new I18nError("allocation_not_found");

      const materializedAllocationId = await materializeReceivingAllocation(
        db,
        allocation.id,
        use,
        dateCode,
        lotCode,
        coo,
        cow,
        receivingInvoiceItemId,
        tx
      );
      await scanAllocationToPackage(db, materializedAllocationId, use, actorId, tx);
      remainingScan -= use;
    }

    if (remainingScan > 0) {
      throw new I18nError("quantity_not_available_receiving");
    }
  });
```

- [ ] **Step 4: Commit**

```bash
git add db/ocrPicking.ts
git commit -m "ocrPicking: receiving-order-level allocation and split scan consumption"
```

---

### Task 5: Update `db/picking.ts`

**Files:**
- Modify: `db/picking.ts:33-52` (getPickingOrderDetail relation)
- Modify: `db/picking.ts:54-125` (materializeReceivingAllocation)
- Modify: `db/picking.ts:313-466` (removeScannedPackage)

- [ ] **Step 1: Update `getPickingOrderDetail` allocation relation**

Replace the allocation `with` block:
```typescript
          allocations: {
            with: {
              inventoryLot: { with: { part: true } },
              receivingInvoiceItem: { with: { invoice: { with: { receivingOrder: true } } } },
              pickingItem: { with: { part: true } },
            },
          },
```

With:
```typescript
          allocations: {
            with: {
              inventoryLot: { with: { part: true } },
              receivingOrder: true,
              pickingItem: { with: { part: true } },
            },
          },
```

- [ ] **Step 2: Update `materializeReceivingAllocation` signature and logic**

Change signature to accept explicit `receivingInvoiceItemId`:
```typescript
export async function materializeReceivingAllocation(
  db: PgliteDatabase<typeof schema>,
  allocationId: string,
  qty: number,
  dateCode: string | null,
  lotCode: string | null,
  coo: string | null,
  cow: string | null,
  receivingInvoiceItemId: string,
  tx?: PgliteDatabase<typeof schema>
): Promise<string> {
```

Inside, replace the allocation query `with` clause:
```typescript
      with: { pickingItem: true, receivingInvoiceItem: { with: { invoice: true } } },
```

With:
```typescript
      with: { pickingItem: true, receivingOrder: true },
```

Replace:
```typescript
    if (!allocation.receivingInvoiceItemId) throw new I18nError("allocation_not_against_receiving_item");
```

With:
```typescript
    if (!allocation.receivingOrderId) throw new I18nError("allocation_not_against_receiving_order");
```

Replace:
```typescript
    const invoiceItem = allocation.receivingInvoiceItem!;
```

With a direct select:
```typescript
    const [invoiceItem] = await tx
      .select()
      .from(schema.receivingInvoiceItems)
      .where(eq(schema.receivingInvoiceItems.id, receivingInvoiceItemId));
    if (!invoiceItem) throw new I18nError("receiving_invoice_item_not_found");
```

In the `qty < allocation.qty` branch, the new lot allocation should still point to the receiving order so future scans can consume the remainder:
```typescript
      await tx.insert(schema.allocations).values({
        id: newAllocationId,
        pickingItemId: allocation.pickingItemId,
        receivingOrderId: allocation.receivingOrderId,
        qty,
      });
```

In the `else` branch, when moving the whole allocation to the new lot, clear `receivingOrderId` because the allocation is now backed by the inventory lot:
```typescript
      await tx
        .update(schema.allocations)
        .set({ inventoryLotId: lotId, receivingOrderId: null })
        .where(eq(schema.allocations.id, allocationId));
```

- [ ] **Step 3: Update `removeScannedPackage` allocation restoration**

In the `sourceType === "receiving_invoice_item"` branch, replace the allocation lookup:
```typescript
      const [allocation] = await tx
        .select()
        .from(schema.allocations)
        .where(
          and(
            eq(schema.allocations.receivingInvoiceItemId, pkg.sourceId),
            eq(schema.allocations.pickingItemId, item.id)
          )
        );
```

With a lookup that restores against the receiving order (derived from the invoice item):
```typescript
      const [invoice] = await tx
        .select({ receivingOrderId: schema.receivingInvoices.receivingOrderId })
        .from(schema.receivingInvoices)
        .innerJoin(
          schema.receivingInvoiceItems,
          eq(schema.receivingInvoiceItems.receivingInvoiceId, schema.receivingInvoices.id)
        )
        .where(eq(schema.receivingInvoiceItems.id, pkg.sourceId));

      const receivingOrderId = invoice?.receivingOrderId ?? null;
      const [allocation] = receivingOrderId
        ? await tx
            .select()
            .from(schema.allocations)
            .where(
              and(
                eq(schema.allocations.receivingOrderId, receivingOrderId),
                eq(schema.allocations.pickingItemId, item.id)
              )
            )
        : [undefined];
```

When inserting a new allocation in this branch, use `receivingOrderId`:
```typescript
        await tx.insert(schema.allocations).values({
          id: uuid(),
          pickingItemId: item.id,
          receivingOrderId,
          qty,
        });
```

- [ ] **Step 4: Commit**

```bash
git add db/picking.ts
git commit -m "picking: materialize and reverse against receiving-order allocations"
```

---

### Task 6: Update `db/receiving.ts`

**Files:**
- Modify: `db/receiving.ts:23-42` (tryMarkReceivingOrderClear)
- Modify: `db/receiving.ts:78-97` (tryMarkReceivingOrderInHand)

- [ ] **Step 1: Update allocation aggregation in `tryMarkReceivingOrderClear`**

Replace:
```typescript
  const allocatedRows = await tx
    .select({
      receivingInvoiceItemId: schema.allocations.receivingInvoiceItemId,
      total: sql<number>`coalesce(sum(${schema.allocations.qty}), 0)`.mapWith(Number),
    })
    .from(schema.allocations)
    .where(inArray(schema.allocations.receivingInvoiceItemId, itemIds))
    .groupBy(schema.allocations.receivingInvoiceItemId);

  const allocatedMap = new Map(
    allocatedRows.map((r) => [r.receivingInvoiceItemId, r.total])
  );
```

With:
```typescript
  const allocatedRows = await tx.execute(sql`
    SELECT
      rii.id AS receiving_invoice_item_id,
      COALESCE(SUM(a.qty), 0) AS total
    FROM receiving_invoice_items rii
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    JOIN allocations a ON a.receiving_order_id = ri.receiving_order_id
    JOIN picking_items pi ON pi.id = a.picking_item_id AND pi.part_id = rii.part_id
    WHERE rii.id IN (${sql.raw(itemIds.map((id) => `'${id}'`).join(", "))})
    GROUP BY rii.id
  `);

  const allocatedMap = new Map(
    (allocatedRows.rows ?? []).map((r: any) => [r.receiving_invoice_item_id, Number(r.total)])
  );
```

- [ ] **Step 2: Apply same change to `tryMarkReceivingOrderInHand`**

Repeat the same replacement in the second function.

- [ ] **Step 3: Commit**

```bash
git add db/receiving.ts
git commit -m "receiving: aggregate allocations by receiving order + part"
```

---

### Task 7: Update service types

**Files:**
- Modify: `services/types.ts:297-325`
- Modify: `services/types.ts:388-396`

- [ ] **Step 1: Update `PickingAllocation`**

Replace the `receivingInvoiceItem` block with:
```typescript
  receivingOrder: {
    id: string;
    refNo: string;
  } | null;
```

- [ ] **Step 2: Update `ApplyOcrPickInput`**

Replace:
```typescript
export interface ApplyOcrPickInput {
  receivingInvoiceItemId: string;
  pickingItemId: string;
  ...
```

With:
```typescript
export interface ApplyOcrPickInput {
  receivingOrderId: string;
  pickingItemId: string;
  ...
```

- [ ] **Step 3: Commit**

```bash
git add services/types.ts
git commit -m "types: allocation uses receivingOrderId"
```

---

### Task 8: Update service adapters

**Files:**
- Modify: `services/warehouse.ts:68`
- Modify: `services/adapters/pgliteWarehouse.ts:210-252`
- Modify: `services/adapters/pgliteWarehouse.ts:855-960`
- Modify: `services/adapters/apiWarehouse.ts:34`

- [ ] **Step 1: Update `services/warehouse.ts` interface**

`applyOcrPick(input: ApplyOcrPickInput)` already uses the input type, so it needs no direct change beyond type propagation.

- [ ] **Step 2: Update `toPickingAllocation` in `pgliteWarehouse.ts`**

Replace the `receivingInvoiceItem` mapper with:
```typescript
    receivingOrder: allocation.receivingOrder
      ? {
          id: allocation.receivingOrder.id,
          refNo: allocation.receivingOrder.refNo,
        }
      : null,
```

- [ ] **Step 3: Update `getReceivingOrders` allocation joins**

Replace the `pending_picking_orders` subquery that uses `a.receiving_invoice_item_id IN (...)` with a version using `a.receiving_order_id = ro.id`:

```sql
            SELECT po.id AS po_id
            FROM allocations a
            JOIN picking_items pi ON pi.id = a.picking_item_id
            JOIN picking_orders po ON po.id = pi.picking_order_id
            WHERE a.receiving_order_id = ro.id
              AND a.qty > 0
              AND po.status IN ('pending', 'picking')

            UNION ALL

            SELECT po.id AS po_id
            FROM allocations a
            JOIN picking_items pi ON pi.id = a.picking_item_id
            JOIN picking_orders po ON po.id = pi.picking_order_id
            JOIN inventory_lots il ON il.id = a.inventory_lot_id
            JOIN inventory_lot_sources ils ON ils.inventory_lot_id = il.id
            JOIN receiving_invoice_items rii ON rii.id = ils.receiving_invoice_item_id
            JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
            WHERE ri.receiving_order_id = ro.id
              AND a.qty > 0
              AND po.status IN ('pending', 'picking')
```

- [ ] **Step 4: Update `getReceivingOrder` allocated result query**

Replace:
```sql
                SELECT rii.id AS receiving_invoice_item_id, COALESCE(SUM(a.qty), 0) AS allocated_qty
                FROM receiving_invoice_items rii
                JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
                JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
                LEFT JOIN allocations a ON a.receiving_invoice_item_id = rii.id
                WHERE ro.id = ${id}
                GROUP BY rii.id
```

With:
```sql
                SELECT rii.id AS receiving_invoice_item_id, COALESCE(SUM(a.qty), 0) AS allocated_qty
                FROM receiving_invoice_items rii
                JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
                JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
                LEFT JOIN allocations a ON a.receiving_order_id = ro.id
                  AND EXISTS (
                    SELECT 1 FROM picking_items pi
                    WHERE pi.id = a.picking_item_id AND pi.part_id = rii.part_id
                  )
                WHERE ro.id = ${id}
                GROUP BY rii.id
```

- [ ] **Step 5: Update `apiWarehouse.ts` stub signature**

`applyOcrPick: notImplemented` is already stubbed; no change needed because the signature is still `ApplyOcrPickInput`.

- [ ] **Step 6: Commit**

```bash
git add services/warehouse.ts services/adapters/pgliteWarehouse.ts services/adapters/apiWarehouse.ts
git commit -m "services: adapt receiving-order-level allocations"
```

---

### Task 9: Update `composables/useScanMatchers.ts`

**Files:**
- Modify: `composables/useScanMatchers.ts:46-51`
- Modify: `composables/useScanMatchers.ts:158-184`
- Modify: `composables/useScanMatchers.ts:190-235`

- [ ] **Step 1: Update `PickingAllocation` local interface**

Replace:
```typescript
interface PickingAllocation {
  id: string;
  qty: number;
  receivingInvoiceItem?: unknown;
  pickingItem?: { part?: { partNo: string | null } | null } | null;
}
```

With:
```typescript
interface PickingAllocation {
  id: string;
  qty: number;
  receivingOrder?: { id: string } | null;
  pickingItem?: { part?: { partNo: string | null } | null } | null;
}
```

- [ ] **Step 2: Update `matchReceiving` apply call**

Replace:
```typescript
        await warehouse.applyOcrPick({
          receivingInvoiceItemId: receiving.receivingInvoiceItemId,
          pickingItemId: picking.pickingItemId,
          qty,
          dateCode: receiving.dateCode,
          lotCode: receiving.lotCode,
          coo: receiving.coo,
          cow: receiving.cow,
        });
```

With:
```typescript
        await warehouse.applyOcrPick({
          receivingOrderId: receivingOrderId,
          pickingItemId: picking.pickingItemId,
          qty,
          dateCode: receiving.dateCode,
          lotCode: receiving.lotCode,
          coo: receiving.coo,
          cow: receiving.cow,
        });
```

- [ ] **Step 3: Update `matchPicking` receiving-allocation detection**

Replace:
```typescript
      const isReceivingAllocation = !!allocation?.receivingInvoiceItem;
```

With:
```typescript
      const isReceivingAllocation = !!allocation?.receivingOrder;
```

- [ ] **Step 4: Commit**

```bash
git add composables/useScanMatchers.ts
git commit -m "scanMatchers: use receivingOrderId for picking allocations"
```

---

### Task 10: Update seed generation

**Files:**
- Modify: `scripts/generate-wcl-seed.mjs`
- Modify: `scripts/picking-seed-output.ts`
- Modify: `db/seed-precalc.ts`
- Modify: `db/seed.ts`

- [ ] **Step 1: Add allocation generation to `scripts/generate-wcl-seed.mjs`**

After the receiving invoice item records, add:

```javascript
// Group picking items by receiving order + part and emit one allocation per group.
// All demo picking items are for the single WCL receiving order.
const allocationRecords = pickingItemRecords.map((pi) => ({
  id: uuid(),
  pickingItemId: pi.id,
  receivingOrderId: "__CODE__:wclReceivingOrder.id",
  inventoryLotId: null,
  qty: pi.qty,
}));

console.log("// WCL allocations");
console.log(`const wclAllocationRecords = ${serialize(allocationRecords)};`);
```

Note: `pickingItemRecords` here refers to the variable you build for output. If the script currently only prints parts/receiving/invoices/items, you may need to compute allocations from a local map. Since the seed output file already contains `pickingItemRecords`, the simplest approach is to compute allocations from the same data structure in the seed script.

- [ ] **Step 2: Run the seed generator**

Run: `node scripts/generate-wcl-seed.mjs > /tmp/seed-output.txt`

- [ ] **Step 3: Copy allocation records into seed files**

Copy the `wclAllocationRecords` section from `/tmp/seed-output.txt` into:
- `scripts/picking-seed-output.ts` (append at end)
- `db/seed-precalc.ts` (after the picking item section)
- `db/seed.ts` (after the picking item section)

In `db/seed-precalc.ts` and `db/seed.ts`, ensure the allocations are inserted with the other WCL records, e.g.:
```typescript
  await db.insert(schema.allocations).values(wclAllocationRecords);
```

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-wcl-seed.mjs scripts/picking-seed-output.ts db/seed-precalc.ts db/seed.ts
git commit -m "seed: allocations at receiving-order level"
```

---

### Task 11: Update tests

**Files:**
- Modify: `tests/picking.test.ts`
- Modify: `tests/scanMatchers.test.ts`
- Modify: `tests/putAway.test.ts`
- Modify: `tests/goodsVerify.test.ts`
- Modify: `tests/mismatch.test.ts`
- Modify: `tests/seed-precalc.test.ts`

- [ ] **Step 1: Replace allocation inserts in existing tests**

For every test that inserts into `schema.allocations` with `receivingInvoiceItemId`, replace the column with `receivingOrderId` and set the value to the receiving order id used in that test.

- [ ] **Step 2: Add regression test in `tests/picking.test.ts`**

Add a new describe block after the existing ones:

```typescript
describe('applyOcrPick split across invoice items', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let actorId: string;
  let receivingOrderId: string;
  let pickingOrderId: string;
  let pickingItemId: string;
  let invoiceItem1Id: string;
  let invoiceItem2Id: string;

  beforeEach(async () => {
    db = await createTestDb();
    const now = new Date();

    actorId = uuid();
    await db.insert(schema.users).values({
      id: actorId,
      username: 'operator',
      passwordHash: 'pw',
      displayName: 'Operator',
      role: 'operator',
      createdAt: now,
    });

    const supplierId = uuid();
    await db.insert(schema.suppliers).values({ id: supplierId, code: 'KOA', name: 'KOA' });

    const partId = uuid();
    await db.insert(schema.parts).values({
      id: partId,
      partNo: 'RK73B1JTTD181G',
      internalCode: '',
      description: '',
      defaultCoo: 'CN',
    });

    receivingOrderId = uuid();
    await db.insert(schema.receivingOrders).values({
      id: receivingOrderId,
      refNo: 'RO-001',
      supplierId,
      deliveryDate: now,
      status: 'in_hand',
      arrivedAt: now,
      arrivedBy: actorId,
      createdAt: now,
      updatedAt: now,
    });

    const invoiceId = uuid();
    await db.insert(schema.receivingInvoices).values({
      id: invoiceId,
      receivingOrderId,
      invoiceNo: 'INV-001',
      supplierId,
    });

    invoiceItem1Id = uuid();
    invoiceItem2Id = uuid();
    await db.insert(schema.receivingInvoiceItems).values([
      {
        id: invoiceItem1Id,
        receivingInvoiceId: invoiceId,
        partId,
        poNo: 'PO-001',
        poLine: '1',
        qty: 10000,
        receivedQty: 10000,
        pickedQty: 0,
        putAwayQty: 0,
        dateCode: '',
        lotCode: '',
        coo: 'CN',
        cow: 'USA',
      },
      {
        id: invoiceItem2Id,
        receivingInvoiceId: invoiceId,
        partId,
        poNo: 'PO-001',
        poLine: '2',
        qty: 190000,
        receivedQty: 190000,
        pickedQty: 0,
        putAwayQty: 0,
        dateCode: '',
        lotCode: '',
        coo: 'CN',
        cow: 'USA',
      },
    ]);

    pickingOrderId = uuid();
    await db.insert(schema.pickingOrders).values({
      id: pickingOrderId,
      refNo: 'PICK-001',
      supplierId,
      deliveryDate: now,
      poNo: 'PO-PICK',
      requiredDateCodeNotice: null,
      shipTo: 'US',
      destinationCountry: 'USA',
      status: 'picking',
      createdAt: now,
      updatedAt: now,
    });

    pickingItemId = uuid();
    await db.insert(schema.pickingItems).values({
      id: pickingItemId,
      pickingOrderId,
      partId,
      qty: 200000,
      pickedQty: 0,
      allocatedQty: 0,
    });

    await db.insert(schema.allocations).values({
      id: uuid(),
      pickingItemId,
      receivingOrderId,
      inventoryLotId: null,
      qty: 200000,
    });
    await db.update(schema.pickingItems)
      .set({ allocatedQty: 200000 })
      .where(eq(schema.pickingItems.id, pickingItemId));
  });

  it('consumes 20k scan across two invoice items in FIFO order', async () => {
    const { applyOcrPick } = await import('../db/ocrPicking');
    await applyOcrPick(db, receivingOrderId, pickingItemId, 20000, null, null, 'CN', 'USA', actorId);

    const item1 = await db.query.receivingInvoiceItems.findFirst({
      where: eq(schema.receivingInvoiceItems.id, invoiceItem1Id),
    });
    const item2 = await db.query.receivingInvoiceItems.findFirst({
      where: eq(schema.receivingInvoiceItems.id, invoiceItem2Id),
    });

    expect(item1?.pickedQty).toBe(10000);
    expect(item2?.pickedQty).toBe(10000);
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add tests/
git commit -m "tests: update allocations to receiving-order level and add split scan regression"
```

---

### Task 12: Verification

- [ ] **Step 1: Type generation**

Run: `pnpm nuxt prepare`
Expected: completes without errors.

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 3: Manual browser check**

1. Clear IndexedDB in the browser.
2. Log in as `operator` / `DocPal2026!`.
3. Navigate to picking order `GZ-26070045`.
4. Scan or paste QR value `:RK73H1ETTP1000F::24:X:9827002:602:KOA+RK73H1ETTP1000F::::`.
5. Verify the scan succeeds and quantity is deducted.

- [ ] **Step 4: Commit**

```bash
git commit -m "verify: receiving-order allocation refactor passes tests and manual check"
```

---

## Self-review

**Spec coverage:**
- Schema change: Task 1
- Picking candidate lookup: Task 4
- Scan application with split consumption: Task 4
- Receiving allocated qty: Tasks 2, 6, 8
- Seed data: Task 10
- Tests: Task 11
- Service/matcher layer: Tasks 7, 8, 9

**Placeholder scan:** No TBD/TODO/fill-in details found.

**Type consistency:** `receivingOrderId` is used consistently across schema, types, services, adapters, and matchers. `materializeReceivingAllocation` signature includes explicit `receivingInvoiceItemId` in all call sites.
