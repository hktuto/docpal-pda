# Web Demo Seed and Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the `apps/web-demo` warehouse demo so receiving-area stock is allocated by invoice item before lot details are known, add richer seed data, and default the receiving list to *In hand*.

**Architecture:** Extend `allocations` to reference `receiving_invoice_items` (nullable `inventory_lot_id`). Allocation consumes shelved `inventory_lots` first, then in-hand invoice items, using FIFO date-code comparison rules. Picking and put-away materialize real `inventory_lots` only when the worker enters the discovered date/lot/origin.

**Tech Stack:** Nuxt 3 (`ssr: false`), Vue 3, PGlite, Drizzle ORM, TypeScript.

---

## File structure

| File | Responsibility |
|------|----------------|
| `apps/web-demo/db/schema.ts` | Drizzle table definitions: nullable `allocations.inventory_lot_id`, new `receiving_invoice_item_id`, new qty columns, new `ship_to` |
| `apps/web-demo/db/init.ts` | Raw SQL DDL matching the schema changes |
| `apps/web-demo/db/allocate.ts` | Date-code rule parser; allocation engine against lots + invoice items |
| `apps/web-demo/db/receiving.ts` | Confirm arrival without creating inventory lots |
| `apps/web-demo/db/picking.ts` | Materialize receiving-area allocations; fix pick to reduce inventory; union query for picking-by-receiving |
| `apps/web-demo/db/putAway.ts` | Put-away from invoice items instead of receiving-area lots |
| `apps/web-demo/db/seed.ts` | Richer demo data: suppliers, parts, future orders, shelf stock, split picking orders |
| `apps/web-demo/pages/receiving/index.vue` | Default filter `in_hand`; remaining qty from invoice items |
| `apps/web-demo/pages/receiving/[id].vue` | Show invoice-line state; updated remaining-qty query |
| `apps/web-demo/pages/picking/index.vue` | Show `ship_to` in the list |
| `apps/web-demo/pages/picking/[id].vue` | Show `ship_to`; pick from receiving-area allocations with date/lot/origin form |
| `apps/web-demo/pages/put-away/index.vue` | Candidate list from invoice-item availability |
| `apps/web-demo/pages/put-away/[id].vue` | Enter date/lot/origin when moving from invoice item to shelf box |
| `apps/web-demo/pages/picking-by-receiving/[id].vue` | Render allocations from both lots and invoice items |

---

## Task 1: Update schema and DDL

**Files:**
- Modify: `apps/web-demo/db/schema.ts`
- Modify: `apps/web-demo/db/init.ts`

- [ ] **Step 1: Change `allocations` in `schema.ts`**

```ts
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

- [ ] **Step 2: Add qty columns and `ship_to` in `schema.ts`**

```ts
export const receivingInvoiceItems = pgTable("receiving_invoice_items", {
  // ... existing columns ...
  pickedQty: integer("picked_qty").notNull().default(0),
  putAwayQty: integer("put_away_qty").notNull().default(0),
});

export const pickingItems = pgTable("picking_items", {
  // ... existing columns ...
  allocatedQty: integer("allocated_qty").notNull().default(0),
});

export const pickingOrders = pgTable("picking_orders", {
  // ... existing columns ...
  shipTo: text("ship_to"),
});
```

- [ ] **Step 3: Update `allocationsRelations` in `schema.ts`**

```ts
export const allocationsRelations = relations(allocations, ({ one }) => ({
  pickingItem: one(pickingItems, { fields: [allocations.pickingItemId], references: [pickingItems.id] }),
  inventoryLot: one(inventoryLots, { fields: [allocations.inventoryLotId], references: [inventoryLots.id] }),
  receivingInvoiceItem: one(receivingInvoiceItems, { fields: [allocations.receivingInvoiceItemId], references: [receivingInvoiceItems.id] }),
}));
```

- [ ] **Step 4: Add the reverse relation on `receivingInvoiceItemsRelations`**

```ts
export const receivingInvoiceItemsRelations = relations(receivingInvoiceItems, ({ one, many }) => ({
  invoice: one(receivingInvoices, { fields: [receivingInvoiceItems.receivingInvoiceId], references: [receivingInvoices.id] }),
  part: one(parts, { fields: [receivingInvoiceItems.partId], references: [parts.id] }),
  inventoryLotSources: many(inventoryLotSources),
  shelfBoxItems: many(shelfBoxItems),
  allocations: many(allocations),
}));
```

- [ ] **Step 5: Mirror the changes in `db/init.ts` raw SQL**

Update these table definitions:

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
  origin_country TEXT,
  reported_mismatch BOOLEAN DEFAULT FALSE,
  mismatch_note TEXT
);

CREATE TABLE IF NOT EXISTS picking_orders (
  id TEXT PRIMARY KEY,
  ref_no TEXT NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id),
  delivery_date TIMESTAMP,
  po_no TEXT,
  required_date_code_notice TEXT,
  ship_to TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS picking_items (
  id TEXT PRIMARY KEY,
  picking_order_id TEXT NOT NULL REFERENCES picking_orders(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES parts(id),
  qty INTEGER NOT NULL,
  picked_qty INTEGER NOT NULL DEFAULT 0,
  allocated_qty INTEGER NOT NULL DEFAULT 0,
  required_date_code TEXT,
  source_shelf_code TEXT
);

CREATE TABLE IF NOT EXISTS allocations (
  id TEXT PRIMARY KEY,
  picking_item_id TEXT NOT NULL REFERENCES picking_items(id) ON DELETE CASCADE,
  inventory_lot_id TEXT REFERENCES inventory_lots(id) ON DELETE CASCADE,
  receiving_invoice_item_id TEXT REFERENCES receiving_invoice_items(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL
);
```

- [ ] **Step 5: Commit**

- [ ] **Step 6: Commit**

```bash
git add apps/web-demo/db/schema.ts apps/web-demo/db/init.ts
git commit -m "schema: support receiving-area allocations and ship_to"
```

---

## Task 2: Update the allocation engine

**Files:**
- Modify: `apps/web-demo/db/allocate.ts`

- [ ] **Step 1: Add the date-code rule parser**

```ts
interface DateCodeRule {
  op: "eq" | ">=" | "<=" | ">" | "<";
  value: string;
}

export function parseDateCodeRule(input: string | null | undefined): DateCodeRule | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  const match = trimmed.match(/^(>=|<=|>|<)?(.*)$/);
  if (!match) return undefined;
  const op = (match[1] as DateCodeRule["op"]) || "eq";
  const value = match[2].trim();
  return { op, value };
}

function dateCodeMatches(lotDate: string | null | undefined, rule: DateCodeRule | undefined): boolean {
  if (!rule) return true;
  if (lotDate == null) return true; // wildcard, but sorted after known codes
  switch (rule.op) {
    case "eq": return lotDate === rule.value;
    case ">=": return lotDate >= rule.value;
    case "<=": return lotDate <= rule.value;
    case ">": return lotDate > rule.value;
    case "<": return lotDate < rule.value;
  }
}
```

- [ ] **Step 2: Rewrite `allocatePickingOrder` to use both lots and invoice items**

Remove the old code that increments `pickedQty` during allocation. Allocation now increments `allocatedQty` only.

```ts
export async function allocatePickingOrder(
  db: PgliteDatabase<typeof schema>,
  pickingOrderId: string
) {
  const items = await db.query.pickingItems.findMany({
    where: eq(schema.pickingItems.pickingOrderId, pickingOrderId),
    with: { pickingOrder: true },
  });

  for (const item of items) {
    let needed = item.qty - item.pickedQty - item.allocatedQty;
    if (needed <= 0) continue;

    const rule = parseDateCodeRule(item.requiredDateCode);

    // Phase 1: shelved / shelf-box lots
    const shelvedLots = await db.query.inventoryLots.findMany({
      where: (il, { and, eq, gt, or, isNotNull }) =>
        and(
          eq(il.partId, item.partId),
          gt(il.availableQty, 0),
          or(isNotNull(il.shelfCode), isNotNull(il.boxId))
        ),
    });

    const matchingShelved = shelvedLots
      .filter((lot) => dateCodeMatches(lot.dateCode, rule))
      .sort((a, b) => (a.dateCode ?? "9999").localeCompare(b.dateCode ?? "9999"));

    for (const lot of matchingShelved) {
      if (needed <= 0) break;
      const take = Math.min(needed, lot.availableQty);
      await createAllocation(db, item.id, lot.id, take);
      await db.update(schema.pickingItems)
        .set({ allocatedQty: sql`${schema.pickingItems.allocatedQty} + ${take}` })
        .where(eq(schema.pickingItems.id, item.id));
      needed -= take;
    }

    // Phase 2: receiving-area invoice items
    if (needed > 0) {
      const receivingItems = await db.execute(sql`
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
      `);

      for (const row of receivingItems.rows) {
        if (needed <= 0) break;
        if (!dateCodeMatches(row.date_code as string | null, rule)) continue;
        const received = Number(row.received_qty);
        const picked = Number(row.picked_qty);
        const putAway = Number(row.put_away_qty);
        const allocated = Number(row.allocated_qty);
        const available = received - picked - putAway - allocated;
        if (available <= 0) continue;
        const take = Math.min(needed, available);
        await db.insert(schema.allocations).values({
          id: uuid(),
          pickingItemId: item.id,
          receivingInvoiceItemId: row.id as string,
          qty: take,
        });
        await db.update(schema.pickingItems)
          .set({ allocatedQty: sql`${schema.pickingItems.allocatedQty} + ${take}` })
          .where(eq(schema.pickingItems.id, item.id));
        needed -= take;
      }
    }
  }
}
```

- [ ] **Step 3: Update `createAllocation` helper**

```ts
async function createAllocation(
  db: PgliteDatabase<typeof schema>,
  pickingItemId: string,
  inventoryLotId: string,
  qty: number
) {
  await db.transaction(async (tx) => {
    await tx.insert(schema.allocations).values({
      id: uuid(),
      pickingItemId,
      inventoryLotId,
      qty,
    });
    await tx
      .update(schema.inventoryLots)
      .set({ allocatedQty: sql`${schema.inventoryLots.allocatedQty} + ${qty}` })
      .where(eq(schema.inventoryLots.id, inventoryLotId));
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web-demo/db/allocate.ts
git commit -m "feat: allocate from receiving invoice items with date-code rules"
```

---

## Task 3: Update receiving confirmation

**Files:**
- Modify: `apps/web-demo/db/receiving.ts`

- [x] **Step 1: Remove inventory-lot creation from `confirmReceivingOrderArrived`**

The function should now only set `received_qty` and trigger allocation.

```ts
export async function confirmReceivingOrderArrived(
  db: PgliteDatabase<typeof schema>,
  orderId: string,
  actorId: string
) {
  await db.transaction(async (tx) => {
    const now = new Date();

    await tx
      .update(schema.receivingOrders)
      .set({
        status: "in_hand",
        arrivedAt: now,
        arrivedBy: actorId,
      })
      .where(eq(schema.receivingOrders.id, orderId));

    const order = await tx.query.receivingOrders.findFirst({
      where: eq(schema.receivingOrders.id, orderId),
      with: { invoices: { with: { items: true } } },
    });

    if (!order) throw new Error("Receiving order not found");

    for (const invoice of order.invoices) {
      for (const item of invoice.items) {
        const qtyToReceive = item.reportedMismatch ? item.receivedQty : item.qty;
        if (qtyToReceive <= 0) continue;

        await tx
          .update(schema.receivingInvoiceItems)
          .set({ receivedQty: qtyToReceive })
          .where(eq(schema.receivingInvoiceItems.id, item.id));
      }
    }

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "receiving_order",
      entityId: orderId,
      fromState: "pending",
      toState: "in_hand",
      actorId,
      metadata: null,
      createdAt: now,
    });
  });

  await allocatePendingPickingOrders(db);
}
```

- [x] **Step 2: Commit**

```bash
git add apps/web-demo/db/receiving.ts
git commit -m "feat: confirm receiving arrival without creating inventory lots"
```

---

## Task 4: Update picking helpers

**Files:**
- Modify: `apps/web-demo/db/picking.ts`

- [x] **Step 1: Add `materializeReceivingAllocation`**

```ts
export async function materializeReceivingAllocation(
  db: PgliteDatabase<typeof schema>,
  allocationId: string,
  qty: number,
  dateCode: string | null,
  lotCode: string | null,
  originCountry: string | null
) {
  return db.transaction(async (tx) => {
    const allocation = await tx.query.allocations.findFirst({
      where: eq(schema.allocations.id, allocationId),
      with: { pickingItem: true, receivingInvoiceItem: { with: { invoice: true } } },
    });

    if (!allocation) throw new Error("Allocation not found");
    if (!allocation.receivingInvoiceItemId) throw new Error("Allocation is not against a receiving item");
    if (qty <= 0 || qty > allocation.qty) throw new Error("Invalid materialize quantity");

    const invoiceItem = allocation.receivingInvoiceItem!;

    // Create the real receiving-area lot
    const lotId = uuid();
    await tx.insert(schema.inventoryLots).values({
      id: lotId,
      partId: invoiceItem.partId,
      dateCode,
      lotCode,
      originCountry,
      shelfCode: null,
      boxId: null,
      totalQty: qty,
      allocatedQty: qty,
    });

    await tx.insert(schema.inventoryLotSources).values({
      id: uuid(),
      inventoryLotId: lotId,
      receivingInvoiceItemId: invoiceItem.id,
      qty,
    });

    if (qty < allocation.qty) {
      // Reduce the original allocation to the remainder, then create a new lot allocation
      await tx
        .update(schema.allocations)
        .set({ qty: sql`${schema.allocations.qty} - ${qty}` })
        .where(eq(schema.allocations.id, allocationId));
      await tx.insert(schema.allocations).values({
        id: uuid(),
        pickingItemId: allocation.pickingItemId,
        inventoryLotId: lotId,
        qty,
      });
    } else {
      // Move the whole allocation to the new lot
      await tx
        .update(schema.allocations)
        .set({ inventoryLotId: lotId, receivingInvoiceItemId: null })
        .where(eq(schema.allocations.id, allocationId));
    }

    return lotId;
  });
}
```

- [x] **Step 2: Update `confirmAllocationPicked` to reduce the inventory lot and allocated qty**

```ts
export async function confirmAllocationPicked(
  db: PgliteDatabase<typeof schema>,
  allocationId: string,
  qty: number,
  actorId: string
) {
  await db.transaction(async (tx) => {
    const allocation = await tx.query.allocations.findFirst({
      where: eq(schema.allocations.id, allocationId),
      with: { pickingItem: true, inventoryLot: true, receivingInvoiceItem: true },
    });

    if (!allocation) throw new Error("Allocation not found");
    if (qty <= 0 || qty > allocation.qty) throw new Error("Invalid picked quantity");

    const item = allocation.pickingItem;
    const lot = allocation.inventoryLot;

    if (lot) {
      if (lot.totalQty < qty) throw new Error("Insufficient lot quantity");
      await tx
        .update(schema.inventoryLots)
        .set({
          totalQty: sql`${schema.inventoryLots.totalQty} - ${qty}`,
          allocatedQty: sql`${schema.inventoryLots.allocatedQty} - ${qty}`,
        })
        .where(eq(schema.inventoryLots.id, lot.id));
    }

    if (allocation.receivingInvoiceItem) {
      await tx
        .update(schema.receivingInvoiceItems)
        .set({ pickedQty: sql`${schema.receivingInvoiceItems.pickedQty} + ${qty}` })
        .where(eq(schema.receivingInvoiceItems.id, allocation.receivingInvoiceItem.id));
    }

    const newPicked = Math.min(item.qty, item.pickedQty + qty);
    await tx
      .update(schema.pickingItems)
      .set({
        pickedQty: newPicked,
        allocatedQty: sql`${schema.pickingItems.allocatedQty} - ${qty}`,
      })
      .where(eq(schema.pickingItems.id, item.id));

    if (qty < allocation.qty) {
      await tx
        .update(schema.allocations)
        .set({ qty: sql`${schema.allocations.qty} - ${qty}` })
        .where(eq(schema.allocations.id, allocationId));
    } else {
      await tx.delete(schema.allocations).where(eq(schema.allocations.id, allocationId));
    }

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "picking_item",
      entityId: item.id,
      fromState: "picking",
      toState: "picked",
      actorId,
      metadata: JSON.stringify({ allocationId, qty }),
      createdAt: new Date(),
    });
  });
}
```

- [x] **Step 3: Update `PickingByReceivingRow` to include `ship_to`**

```ts
export interface PickingByReceivingRow {
  picking_order_id: string;
  picking_order_ref: string;
  picking_order_status: string;
  picking_order_ship_to: string | null;
  picking_item_id: string;
  required_qty: number;
  picked_qty: number;
  part_id: string;
  part_no: string;
  shelf_code: string | null;
  box_id: string | null;
  date_code: string | null;
  lot_code: string | null;
  origin_country: string | null;
  allocated_qty: number;
}
```

- [x] **Step 4: Update `getPickingOrdersByReceivingOrder` to include invoice-item allocations**

```ts
export async function getPickingOrdersByReceivingOrder(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string
) {
  const result = await db.execute(sql`
    SELECT
      po.id AS picking_order_id,
      po.ref_no AS picking_order_ref,
      po.status AS picking_order_status,
      po.ship_to AS picking_order_ship_to,
      pi.id AS picking_item_id,
      pi.qty AS required_qty,
      pi.picked_qty,
      p.id AS part_id,
      p.part_no,
      il.shelf_code,
      il.box_id,
      il.date_code,
      il.lot_code,
      il.origin_country,
      a.qty AS allocated_qty
    FROM receiving_orders ro
    JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    LEFT JOIN inventory_lot_sources ils ON ils.receiving_invoice_item_id = rii.id
    LEFT JOIN inventory_lots il ON il.id = ils.inventory_lot_id
    JOIN allocations a ON (
      a.inventory_lot_id = il.id OR a.receiving_invoice_item_id = rii.id
    )
    JOIN picking_items pi ON pi.id = a.picking_item_id
    JOIN picking_orders po ON po.id = pi.picking_order_id
    JOIN parts p ON p.id = pi.part_id
    WHERE ro.id = ${receivingOrderId}
    ORDER BY po.ref_no, p.part_no;
  `);

  return (result.rows ?? []) as PickingByReceivingRow[];
}
```

- [x] **Step 4: Update `getPickingOrderDetail` relations to include `receivingInvoiceItem`**

```ts
export async function getPickingOrderDetail(
  db: PgliteDatabase<typeof schema>,
  id: string
) {
  return db.query.pickingOrders.findFirst({
    where: eq(schema.pickingOrders.id, id),
    with: {
      supplier: true,
      items: {
        with: {
          part: true,
          allocations: {
            with: {
              inventoryLot: { with: { part: true } },
              receivingInvoiceItem: { with: { invoice: { with: { receivingOrder: true } } } },
            },
          },
        },
      },
    },
  });
}
```

- [x] **Step 5: Commit**

```bash
git add apps/web-demo/db/picking.ts
git commit -m "feat: materialize receiving-area allocations during picking"
```

---

## Task 5: Update put-away helpers

**Files:**
- Modify: `apps/web-demo/db/putAway.ts`

- [ ] **Step 1: Replace `getPutAwayCandidates` to use invoice items**

```ts
export async function getPutAwayCandidates(
  db: PgliteDatabase<typeof schema>
): Promise<PutAwayCandidate[]> {
  return db.execute(sql`
    SELECT
      ro.id,
      ro.ref_no,
      ro.status,
      s.name AS supplier_name,
      SUM(rii.received_qty - rii.picked_qty - rii.put_away_qty -
          COALESCE(alloc.allocated_qty, 0)) AS available_qty
    FROM receiving_orders ro
    JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    LEFT JOIN suppliers s ON s.id = ro.supplier_id
    LEFT JOIN (
      SELECT receiving_invoice_item_id, SUM(qty) AS allocated_qty
      FROM allocations
      WHERE receiving_invoice_item_id IS NOT NULL
      GROUP BY receiving_invoice_item_id
    ) alloc ON alloc.receiving_invoice_item_id = rii.id
    WHERE ro.status = 'in_hand'
    GROUP BY ro.id, ro.ref_no, ro.status, s.name
    HAVING SUM(rii.received_qty - rii.picked_qty - rii.put_away_qty -
               COALESCE(alloc.allocated_qty, 0)) > 0
    ORDER BY ro.ref_no;
  `).then((r) => (r.rows ?? []) as PutAwayCandidate[]);
}
```

- [ ] **Step 2: Replace `getPutAwayLots` to use invoice items**

```ts
export async function getPutAwayLots(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string
): Promise<PutAwayLot[]> {
  return db.execute(sql`
    SELECT
      rii.id AS receiving_invoice_item_id,
      p.id AS part_id,
      p.part_no,
      rii.date_code,
      rii.lot_code,
      rii.origin_country,
      rii.received_qty - rii.picked_qty - rii.put_away_qty -
        COALESCE(alloc.allocated_qty, 0) AS available_qty
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
      AND rii.received_qty - rii.picked_qty - rii.put_away_qty -
          COALESCE(alloc.allocated_qty, 0) > 0
    ORDER BY p.part_no, rii.date_code;
  `).then((r) => (r.rows ?? []) as PutAwayLot[]);
}
```

- [ ] **Step 3: Update `addItemToShelfBox` to accept invoice item source**

Change the signature to accept date/lot/origin. Inside the transaction, when the source is an invoice item, create the shelf lot directly and update `put_away_qty`.

```ts
export async function addItemToShelfBox(
  db: PgliteDatabase<typeof schema>,
  shelfBoxId: string,
  receivingInvoiceItemId: string,
  qty: number,
  dateCode: string | null,
  lotCode: string | null,
  originCountry: string | null
) {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error("Qty must be a positive integer");
  }

  return db.transaction(async (tx) => {
    const [box] = await tx.select().from(schema.shelfBoxes).where(eq(schema.shelfBoxes.id, shelfBoxId));
    if (!box) throw new Error("Shelf box not found");
    if (box.status !== "open") throw new Error("Shelf box is not open");

    const [invoiceItem] = await tx
      .select()
      .from(schema.receivingInvoiceItems)
      .where(eq(schema.receivingInvoiceItems.id, receivingInvoiceItemId));
    if (!invoiceItem) throw new Error("Invoice item not found");

    const [invoice] = await tx
      .select()
      .from(schema.receivingInvoices)
      .where(eq(schema.receivingInvoices.id, invoiceItem.receivingInvoiceId));
    if (invoice.receivingOrderId !== box.receivingOrderId) {
      throw new Error("Item does not belong to this receiving order");
    }

    const allocatedResult = await tx
      .select({ total: sql<number>`coalesce(sum(${schema.allocations.qty}), 0)`.mapWith(Number) })
      .from(schema.allocations)
      .where(eq(schema.allocations.receivingInvoiceItemId, receivingInvoiceItemId));
    const allocated = allocatedResult[0]?.total ?? 0;
    const available = invoiceItem.receivedQty - invoiceItem.pickedQty - invoiceItem.putAwayQty - allocated;
    if (qty > available) throw new Error("Insufficient available quantity");

    const existing = await tx.query.inventoryLots.findFirst({
      where: (il, { and, eq }) =>
        and(
          eq(il.partId, invoiceItem.partId),
          eq(il.shelfCode, box.shelfCode),
          eq(il.boxId, shelfBoxId),
          dateCode ? eq(il.dateCode, dateCode) : sql`${il.dateCode} IS NULL`,
          lotCode ? eq(il.lotCode, lotCode) : sql`${il.lotCode} IS NULL`,
          originCountry ? eq(il.originCountry, originCountry) : sql`${il.originCountry} IS NULL`
        ),
    });

    let targetLotId: string;
    if (existing) {
      targetLotId = existing.id;
      await tx
        .update(schema.inventoryLots)
        .set({ totalQty: sql`${schema.inventoryLots.totalQty} + ${qty}` })
        .where(eq(schema.inventoryLots.id, targetLotId));
    } else {
      targetLotId = uuid();
      await tx.insert(schema.inventoryLots).values({
        id: targetLotId,
        partId: invoiceItem.partId,
        dateCode,
        lotCode,
        originCountry,
        shelfCode: box.shelfCode,
        boxId: shelfBoxId,
        totalQty: qty,
        allocatedQty: 0,
      });
    }

    const sourceLink = await tx.query.inventoryLotSources.findFirst({
      where: (ils, { and }) =>
        and(
          eq(ils.inventoryLotId, targetLotId),
          eq(ils.receivingInvoiceItemId, receivingInvoiceItemId)
        ),
    });

    if (sourceLink) {
      await tx
        .update(schema.inventoryLotSources)
        .set({ qty: sql`${schema.inventoryLotSources.qty} + ${qty}` })
        .where(eq(schema.inventoryLotSources.id, sourceLink.id));
    } else {
      await tx.insert(schema.inventoryLotSources).values({
        id: uuid(),
        inventoryLotId: targetLotId,
        receivingInvoiceItemId,
        qty,
      });
    }

    await tx
      .update(schema.receivingInvoiceItems)
      .set({ putAwayQty: sql`${schema.receivingInvoiceItems.putAwayQty} + ${qty}` })
      .where(eq(schema.receivingInvoiceItems.id, receivingInvoiceItemId));

    const [shelfBoxItem] = await tx
      .insert(schema.shelfBoxItems)
      .values({
        id: uuid(),
        shelfBoxId,
        receivingInvoiceItemId,
        partId: invoiceItem.partId,
        qty,
        verified: false,
      })
      .returning();

    return shelfBoxItem;
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web-demo/db/putAway.ts
git commit -m "feat: put-away from receiving invoice items"
```

---

## Task 6: Update receiving list

**Files:**
- Modify: `apps/web-demo/pages/receiving/index.vue`

- [ ] **Step 1: Change default filter and remaining-qty query**

```ts
const filter = ref<Filter>("in_hand");
```

```ts
const query = computed(() => {
  let where = "1=1";
  if (filter.value === "pending") where = "ro.status = 'pending'";
  if (filter.value === "in_hand") where = "ro.status = 'in_hand'";

  return `SELECT
    ro.id,
    ro.ref_no,
    ro.status,
    ro.delivery_date,
    s.name AS supplier_name,
    COALESCE(SUM(
      CASE
        WHEN ro.status = 'in_hand'
        THEN rii.received_qty - rii.picked_qty - rii.put_away_qty -
             COALESCE(alloc.allocated_qty, 0)
        ELSE 0
      END
    ), 0) AS remaining_qty
  FROM receiving_orders ro
  LEFT JOIN suppliers s ON s.id = ro.supplier_id
  LEFT JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
  LEFT JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
  LEFT JOIN (
    SELECT receiving_invoice_item_id, SUM(qty) AS allocated_qty
    FROM allocations
    WHERE receiving_invoice_item_id IS NOT NULL
    GROUP BY receiving_invoice_item_id
  ) alloc ON alloc.receiving_invoice_item_id = rii.id
  WHERE ${where}
  GROUP BY ro.id, ro.ref_no, ro.status, ro.delivery_date, s.name
  ORDER BY ro.delivery_date;`;
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/web-demo/pages/receiving/index.vue
git commit -m "ui: default receiving filter to in_hand and compute remaining qty from invoice items"
```

---

## Task 7: Update receiving detail

**Files:**
- Modify: `apps/web-demo/pages/receiving/[id].vue`

- [ ] **Step 1: Update remaining-qty query**

Replace the `inventory_lot_sources` / `inventory_lots` join with the invoice-item availability calculation used in Task 6, filtered by `ro.id = orderId`.

- [ ] **Step 2: Update the receiving view to show line state**

Display `received / picked / put away / available` per invoice item.

- [ ] **Step 3: Commit**

```bash
git add apps/web-demo/pages/receiving/[id].vue
git commit -m "ui: receiving detail shows invoice-item availability"
```

---

## Task 8: Update picking detail

**Files:**
- Modify: `apps/web-demo/pages/picking/[id].vue`

- [ ] **Step 1: Show `ship_to` in the header**

```vue
<div class="detail-row">
  <span class="detail-label">Ship to</span>
  <span>{{ order.shipTo || "—" }}</span>
</div>
```

- [ ] **Step 2: Handle receiving-area allocations**

For allocations that have `receivingInvoiceItemId` instead of `inventoryLotId`, show a form to enter `dateCode`, `lotCode`, `originCountry`, and qty before calling `materializeReceivingAllocation`, then call `confirmAllocationPicked` on the resulting lot.

```ts
async function markPickedFromReceiving(
  allocationId: string,
  qty: number,
  dateCode: string,
  lotCode: string,
  originCountry: string
) {
  picking.value[allocationId] = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await materializeReceivingAllocation(db, allocationId, qty, dateCode, lotCode, originCountry);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    picking.value[allocationId] = false;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web-demo/pages/picking/[id].vue
git commit -m "ui: picking detail supports ship_to and receiving-area picks"
```

---

## Task 9: Update picking list

**Files:**
- Modify: `apps/web-demo/pages/picking/index.vue`

- [ ] **Step 1: Display `ship_to` in the list cards**

Add a row:

```vue
<p class="card__meta">Ship to: {{ po.shipTo || "—" }}</p>
```

- [ ] **Step 2: Commit**

```bash
git add apps/web-demo/pages/picking/index.vue
git commit -m "ui: show ship_to in picking list"
```

---

## Task 10: Update put-away pages

**Files:**
- Modify: `apps/web-demo/pages/put-away/index.vue`
- Modify: `apps/web-demo/pages/put-away/[id].vue`

- [ ] **Step 1: Update list query in `pages/put-away/index.vue`**

Use the `getPutAwayCandidates` helper instead of the raw inventory-lot query, or rewrite the raw query to match the new availability formula from Task 5.

- [ ] **Step 2: Update detail form in `pages/put-away/[id].vue`**

For each available invoice item, add inputs for `dateCode`, `lotCode`, and `originCountry`. Pass them to `addItemToShelfBox`.

```ts
await addItemToShelfBox(
  db,
  box.value.id,
  receivingInvoiceItemId,
  qty,
  dateCode,
  lotCode,
  originCountry
);
```

- [ ] **Step 3: Commit**

```bash
git add apps/web-demo/pages/put-away/index.vue apps/web-demo/pages/put-away/[id].vue
git commit -m "ui: put-away from invoice items with discovered lot details"
```

---

## Task 11: Update picking-by-receiving detail

**Files:**
- Modify: `apps/web-demo/pages/picking-by-receiving/[id].vue`

- [ ] **Step 1: Include `ship_to` in the grouped order display**

Use the `picking_order_ship_to` field returned by the updated `getPickingOrdersByReceivingOrder` helper.

- [ ] **Step 2: Commit**

```bash
git add apps/web-demo/pages/picking-by-receiving/[id].vue
git commit -m "ui: picking-by-receiving shows ship_to and invoice-item allocations"
```

---

## Task 12: Rewrite seed data

**Files:**
- Modify: `apps/web-demo/db/seed.ts`

- [ ] **Step 1: Define suppliers, parts, and shelves**

Replace the existing arrays with the suppliers and parts from the design doc, plus a few more shelves.

- [ ] **Step 2: Create receiving orders and invoices**

Create:
- `RO-240701-001` ALP in_hand, 2 invoices, with `RES-0603-10K` 40,000 and a mixed/unknown date-code line.
- `RO-240701-002` BET in_hand, 3 invoices, one item each.
- `RO-240705-001` GAM pending, +4 days.
- `RO-240710-001` DEL pending, +9 days, 80,000 MCU with `date_code` null.
- `RO-240615-001` EPS in_hand, -15 days.

- [ ] **Step 3: Create existing shelf stock**

Insert a few `inventory_lots` directly on shelves with older date codes.

- [ ] **Step 4: Create picking orders**

Create picking orders that split the ALP resistor across `ZH`, `SH`, `BJ`, and others with date-code rules such as `>=2405`.

```ts
const pickingOrders = [
  { refNo: "TN-240701-002", supplierId: alpId, shipTo: "ZH", deliveryDate: now, items: [
    { partId: res10kId, qty: 20000, requiredDateCode: ">=2405" },
  ]},
  { refNo: "TN-240701-003", supplierId: alpId, shipTo: "SH", deliveryDate: now, items: [
    { partId: res10kId, qty: 1200, requiredDateCode: ">=2405" },
  ]},
  { refNo: "TN-240701-004", supplierId: alpId, shipTo: "BJ", deliveryDate: now, items: [
    { partId: res10kId, qty: 800, requiredDateCode: ">=2405" },
  ]},
  // ... other orders
];
```

- [ ] **Step 5: Run allocation for in-hand orders**

After inserting picking orders, call `allocatePickingOrder` for each one whose receiving order is already `in_hand`.

- [ ] **Step 6: Commit**

```bash
git add apps/web-demo/db/seed.ts
git commit -m "seed: richer demo data with suppliers, split picks, and future orders"
```

---

## Task 13: Verify with a clean build

- [ ] **Step 1: Reset the demo database**

Open the app, use **⋮ → Reset local DB**, then reload.

- [ ] **Step 2: Run the production build**

```bash
cd apps/web-demo
pnpm run build
```

Expected: build succeeds with no TypeScript or lint errors.

- [ ] **Step 3: Smoke-test the demo**

1. Log in as `operator` / `DocPal2026!`.
2. Receiving list defaults to *In hand*.
3. Open `RO-240701-001`; the ALP resistor line shows 40,000 received and availability after allocations.
4. Open picking order `TN-240701-002` (ZH); confirm the 20,000 allocation can be picked after entering date/lot/origin.
5. Open Put-away and move unallocated ALP stock to a shelf box with discovered date/lot/origin.
6. Confirm the build still passes.

- [ ] **Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "fix: demo build and smoke-test fixes"
```

---

## Spec coverage checklist

| Spec section | Task(s) |
|--------------|---------|
| Default receiving filter = In hand | Task 6 |
| Schema: nullable `inventory_lot_id`, `receiving_invoice_item_id` | Task 1 |
| Schema: `picked_qty`, `put_away_qty`, `allocated_qty`, `ship_to` | Task 1 |
| Date-code comparison rules | Task 2 |
| Allocation from shelved lots first, then invoice items | Task 2 |
| Receiving confirmation does not create lots | Task 3 |
| Picking materializes receiving-area lots | Task 4, Task 8 |
| Put-away from invoice items | Task 5, Task 10 |
| Richer seed data with split picking orders | Task 12 |
| UI updates for `ship_to` and availability | Tasks 6–11 |

No placeholders remain in this plan.
