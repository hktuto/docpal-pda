> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

# Put-away Scan-First Flow Implementation Plan

**Goal:** Change put-away so operators scan individual physical pieces into a receiving item first, then manually move whole scanned pieces into shelf boxes.

**Architecture:** Add a `put_away_scans` detail table to track each scanned piece (nullable `shelf_box_id` while unboxed). Keep `shelf_box_items` as a box-level summary aggregated from scans. Update the scan matcher, the put-away detail page, and the lots panel to match the receiving-picking pattern.

**Tech Stack:** Nuxt 3, Vue 3, PGlite, Drizzle ORM, TypeScript, Vitest.

---

## File map

| File | Responsibility |
|------|----------------|
| `db/schema.ts` | Add `putAwayScans` table and Drizzle relations. |
| `db/init.ts` | Add raw SQL for `put_away_scans` table and indexes. |
| `db/helpers.ts` | Update `availableReceivingQtySql` to subtract unboxed scans; extend `allocationsCte` to provide unboxed scan qty. |
| `db/putAway.ts` | Add scan CRUD helpers; update `getPutAwayLots` and `cancelShelfBox`; export new types. |
| `composables/useScanMatchers.ts` | Change `matchPutAway` to record scans without a target box. |
| `i18n/locales/en-US.ts` | Add English labels/error keys. |
| `i18n/locales/zh-CN.ts` | Add Simplified Chinese labels/error keys. |
| `i18n/locales/zh-HK.ts` | Add Traditional Chinese labels/error keys. |
| `components/put-away/PutAwayLotsPanel.vue` | Redesign to show items with total/scanned/boxed qty and per-scan actions. |
| `components/put-away/ShelfBoxesPanel.vue` | No functional change; verify it still renders `box.items`. |
| `pages/put-away/[id].vue` | Replace target-box selection with scan/assign/remove handlers and bind new panel. |
| `public/ocr-labels.html` | Change the put-away example label qty to a fraction of the item total. |
| `tests/scanMatchers.test.ts` | Update put-away matcher tests for the new flow. |
| `tests/putAway.test.ts` | New tests for `recordPutAwayScan`, `assignScanToBox`, `removeScanFromBox`, `removeScannedPiece`, `cancelShelfBox`. |
| `docs/app-docs/flows/put-away/*.md` | Update operator and AI docs. |

---

## Task 1: Add `put_away_scans` table to schema and init SQL

**Files:**
- Modify: `db/schema.ts`
- Modify: `db/init.ts`

- [ ] **Step 1: Add the `putAwayScans` table definition to `db/schema.ts`**

Insert after the `shelfBoxItems` block (around line 284):

```typescript
export const putAwayScans = pgTable("put_away_scans", {
  id: text("id").primaryKey(),
  receivingInvoiceItemId: text("receiving_invoice_item_id")
    .notNull()
    .references(() => receivingInvoiceItems.id, { onDelete: "cascade" }),
  partId: text("part_id")
    .notNull()
    .references(() => parts.id),
  qty: integer("qty").notNull(),
  dateCode: text("date_code"),
  lotCode: text("lot_code"),
  coo: text("coo"),
  cow: text("cow"),
  shelfBoxId: text("shelf_box_id").references(() => shelfBoxes.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull(),
});
```

- [ ] **Step 2: Add Drizzle relations for `putAwayScans`**

In `receivingInvoiceItemsRelations`, add:

```typescript
putAwayScans: many(putAwayScans),
```

In `shelfBoxesRelations`, add:

```typescript
putAwayScans: many(putAwayScans),
```

Add a new relation block at the end of the relations section:

```typescript
export const putAwayScansRelations = relations(putAwayScans, ({ one }) => ({
  receivingInvoiceItem: one(receivingInvoiceItems, { fields: [putAwayScans.receivingInvoiceItemId], references: [receivingInvoiceItems.id] }),
  shelfBox: one(shelfBoxes, { fields: [putAwayScans.shelfBoxId], references: [shelfBoxes.id] }),
  part: one(parts, { fields: [putAwayScans.partId], references: [parts.id] }),
}));
```

- [ ] **Step 3: Add raw SQL table and indexes to `db/init.ts`**

Insert before the `transition_logs` block (around line 234):

```sql
CREATE TABLE IF NOT EXISTS put_away_scans (
  id TEXT PRIMARY KEY,
  receiving_invoice_item_id TEXT NOT NULL REFERENCES receiving_invoice_items(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES parts(id),
  qty INTEGER NOT NULL,
  date_code TEXT,
  lot_code TEXT,
  coo TEXT,
  cow TEXT,
  shelf_box_id TEXT REFERENCES shelf_boxes(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_put_away_scans_item ON put_away_scans(receiving_invoice_item_id);
CREATE INDEX IF NOT EXISTS idx_put_away_scans_box ON put_away_scans(shelf_box_id);
```

- [ ] **Step 4: Run type generation**

Run:

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm nuxt prepare
```

Expected: `Types generated in .nuxt.` with no errors.

- [ ] **Step 5: Commit**

```bash
git add db/schema.ts db/init.ts
git commit -m "feat(put-away): add put_away_scans table"
```

---

## Task 2: Update availability helper to account for unboxed scans

**Files:**
- Modify: `db/helpers.ts`

- [ ] **Step 1: Extend `allocationsCte` to include unboxed scan qty**

Replace the current `allocationsCte` implementation in `db/helpers.ts`:

```typescript
export function allocationsCte() {
  return sql`
    SELECT
      receiving_invoice_item_id,
      SUM(qty) AS allocated_qty,
      0 AS unboxed_scanned_qty
    FROM allocations
    WHERE receiving_invoice_item_id IS NOT NULL
    GROUP BY receiving_invoice_item_id
    UNION ALL
    SELECT
      receiving_invoice_item_id,
      0 AS allocated_qty,
      SUM(qty) AS unboxed_scanned_qty
    FROM put_away_scans
    WHERE shelf_box_id IS NULL
    GROUP BY receiving_invoice_item_id
  `;
}
```

- [ ] **Step 2: Update `availableReceivingQtySql` to subtract unboxed scans**

Replace:

```typescript
export const availableReceivingQtySql = sql`
  rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0)
`;
```

with:

```typescript
export const availableReceivingQtySql = sql`
  rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0) - COALESCE(alloc.unboxed_scanned_qty, 0)
`;
```

- [ ] **Step 3: Commit**

```bash
git add db/helpers.ts
git commit -m "feat(put-away): subtract unboxed scans from available receiving qty"
```

---

## Task 3: Add put-away scan DB helpers

**Files:**
- Modify: `db/putAway.ts`

- [ ] **Step 1: Add imports for `and` and `isNull`**

At the top of `db/putAway.ts`, change the Drizzle import from:

```typescript
import { eq, sql, isNull, desc } from "drizzle-orm";
```

to:

```typescript
import { eq, sql, isNull, desc, and } from "drizzle-orm";
```

- [ ] **Step 2: Add `recordPutAwayScan` helper**

Insert after the `PutAwayLot` interface:

```typescript
export interface PutAwayScan = typeof schema.putAwayScans.$inferSelect;

export async function recordPutAwayScan(
  db: PgliteDatabase<typeof schema>,
  receivingInvoiceItemId: string,
  qty: number,
  dateCode: string | null,
  lotCode: string | null,
  coo: string | null,
  cow: string | null,
  actorId: string
): Promise<typeof schema.putAwayScans.$inferSelect> {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new I18nError("qty_must_be_positive_integer");
  }

  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(schema.receivingInvoiceItems)
      .where(eq(schema.receivingInvoiceItems.id, receivingInvoiceItemId));
    if (!item) throw new I18nError("invoice_item_not_found");

    const allocatedResult = await tx
      .select({ total: sql<number>`coalesce(sum(${schema.allocations.qty}), 0)`.mapWith(Number) })
      .from(schema.allocations)
      .where(eq(schema.allocations.receivingInvoiceItemId, receivingInvoiceItemId));
    const allocated = allocatedResult[0]?.total ?? 0;

    const unboxedResult = await tx
      .select({ total: sql<number>`coalesce(sum(${schema.putAwayScans.qty}), 0)`.mapWith(Number) })
      .from(schema.putAwayScans)
      .where(
        and(
          eq(schema.putAwayScans.receivingInvoiceItemId, receivingInvoiceItemId),
          isNull(schema.putAwayScans.shelfBoxId)
        )
      );
    const unboxed = unboxedResult[0]?.total ?? 0;

    const remaining = item.receivedQty - item.pickedQty - allocated - item.putAwayQty - unboxed;
    if (qty > remaining) throw new I18nError("scanned_qty_exceeds_total");

    const [scan] = await tx
      .insert(schema.putAwayScans)
      .values({
        id: uuid(),
        receivingInvoiceItemId,
        partId: item.partId,
        qty,
        dateCode,
        lotCode,
        coo,
        cow,
        shelfBoxId: null,
        createdAt: new Date(),
      })
      .returning();

    return scan;
  });
}
```

- [ ] **Step 3: Add `assignScanToBox` helper**

Insert after `recordPutAwayScan`:

```typescript
export async function assignScanToBox(
  db: PgliteDatabase<typeof schema>,
  scanId: string,
  shelfBoxId: string,
  actorId: string
): Promise<void> {
  return db.transaction(async (tx) => {
    const [scan] = await tx
      .select()
      .from(schema.putAwayScans)
      .where(eq(schema.putAwayScans.id, scanId));
    if (!scan) throw new I18nError("put_away_scan_not_found");
    if (scan.shelfBoxId) throw new I18nError("put_away_scan_already_boxed");

    const [box] = await tx
      .select()
      .from(schema.shelfBoxes)
      .where(eq(schema.shelfBoxes.id, shelfBoxId));
    if (!box) throw new I18nError("shelf_box_not_found");
    if (box.status !== "open") throw new I18nError("shelf_box_is_not_open");

    const [item] = await tx
      .select()
      .from(schema.receivingInvoiceItems)
      .where(eq(schema.receivingInvoiceItems.id, scan.receivingInvoiceItemId));
    if (!item) throw new I18nError("invoice_item_not_found");

    const [invoice] = await tx
      .select()
      .from(schema.receivingInvoices)
      .where(eq(schema.receivingInvoices.id, item.receivingInvoiceId));
    if (!invoice) throw new I18nError("invoice_not_found");
    if (invoice.receivingOrderId !== box.receivingOrderId) {
      throw new I18nError("item_does_not_belong_to_receiving_order");
    }

    await tx
      .update(schema.putAwayScans)
      .set({ shelfBoxId })
      .where(eq(schema.putAwayScans.id, scanId));

    const existing = await tx.query.inventoryLots.findFirst({
      where: (il, { and, eq }) =>
        and(
          eq(il.partId, item.partId),
          eq(il.shelfCode, box.shelfCode),
          eq(il.boxId, shelfBoxId),
          scan.dateCode != null ? eq(il.dateCode, scan.dateCode) : isNull(il.dateCode),
          scan.lotCode != null ? eq(il.lotCode, scan.lotCode) : isNull(il.lotCode),
          scan.coo != null ? eq(il.coo, scan.coo) : isNull(il.coo),
          scan.cow != null ? eq(il.cow, scan.cow) : isNull(il.cow)
        ),
    });

    let targetLotId: string;
    if (existing) {
      targetLotId = existing.id;
      await tx
        .update(schema.inventoryLots)
        .set({ totalQty: sql`${schema.inventoryLots.totalQty} + ${scan.qty}` })
        .where(eq(schema.inventoryLots.id, targetLotId));
    } else {
      targetLotId = uuid();
      await tx.insert(schema.inventoryLots).values({
        id: targetLotId,
        partId: item.partId,
        dateCode: scan.dateCode,
        lotCode: scan.lotCode,
        coo: scan.coo,
        cow: scan.cow,
        shelfCode: box.shelfCode,
        boxId: shelfBoxId,
        totalQty: scan.qty,
        allocatedQty: 0,
      });
    }

    const sourceLink = await tx.query.inventoryLotSources.findFirst({
      where: (ils, { and }) =>
        and(
          eq(ils.inventoryLotId, targetLotId),
          eq(ils.receivingInvoiceItemId, scan.receivingInvoiceItemId)
        ),
    });

    if (sourceLink) {
      await tx
        .update(schema.inventoryLotSources)
        .set({ qty: sql`${schema.inventoryLotSources.qty} + ${scan.qty}` })
        .where(eq(schema.inventoryLotSources.id, sourceLink.id));
    } else {
      await tx.insert(schema.inventoryLotSources).values({
        id: uuid(),
        inventoryLotId: targetLotId,
        receivingInvoiceItemId: scan.receivingInvoiceItemId,
        qty: scan.qty,
      });
    }

    await tx
      .update(schema.receivingInvoiceItems)
      .set({ putAwayQty: sql`${schema.receivingInvoiceItems.putAwayQty} + ${scan.qty}` })
      .where(eq(schema.receivingInvoiceItems.id, scan.receivingInvoiceItemId));

    const summary = await tx.query.shelfBoxItems.findFirst({
      where: (sbi, { and, eq }) =>
        and(
          eq(sbi.shelfBoxId, shelfBoxId),
          eq(sbi.receivingInvoiceItemId, scan.receivingInvoiceItemId),
          eq(sbi.partId, item.partId)
        ),
    });

    if (summary) {
      await tx
        .update(schema.shelfBoxItems)
        .set({ qty: sql`${schema.shelfBoxItems.qty} + ${scan.qty}` })
        .where(eq(schema.shelfBoxItems.id, summary.id));
    } else {
      await tx.insert(schema.shelfBoxItems).values({
        id: uuid(),
        shelfBoxId,
        receivingInvoiceItemId: scan.receivingInvoiceItemId,
        partId: item.partId,
        qty: scan.qty,
        verified: false,
      });
    }

    if (invoice.receivingOrderId) {
      await tryMarkReceivingOrderClear(tx, invoice.receivingOrderId, actorId);
    }
  });
}
```

- [ ] **Step 4: Add `removeScanFromBox` helper**

Insert after `assignScanToBox`:

```typescript
export async function removeScanFromBox(
  db: PgliteDatabase<typeof schema>,
  scanId: string,
  actorId: string
): Promise<void> {
  return db.transaction(async (tx) => {
    const [scan] = await tx
      .select()
      .from(schema.putAwayScans)
      .where(eq(schema.putAwayScans.id, scanId));
    if (!scan) throw new I18nError("put_away_scan_not_found");
    if (!scan.shelfBoxId) throw new I18nError("put_away_scan_not_boxed");

    const shelfBoxId = scan.shelfBoxId;

    const [box] = await tx
      .select()
      .from(schema.shelfBoxes)
      .where(eq(schema.shelfBoxes.id, shelfBoxId));
    if (!box) throw new I18nError("shelf_box_not_found");
    if (box.status !== "open") throw new I18nError("shelf_box_is_not_open");

    await tx
      .update(schema.putAwayScans)
      .set({ shelfBoxId: null })
      .where(eq(schema.putAwayScans.id, scanId));

    const existing = await tx.query.inventoryLots.findFirst({
      where: (il, { and, eq }) =>
        and(
          eq(il.partId, scan.partId),
          eq(il.shelfCode, box.shelfCode),
          eq(il.boxId, shelfBoxId),
          scan.dateCode != null ? eq(il.dateCode, scan.dateCode) : isNull(il.dateCode),
          scan.lotCode != null ? eq(il.lotCode, scan.lotCode) : isNull(il.lotCode),
          scan.coo != null ? eq(il.coo, scan.coo) : isNull(il.coo),
          scan.cow != null ? eq(il.cow, scan.cow) : isNull(il.cow)
        ),
    });
    if (!existing) throw new I18nError("inventory_lot_not_found");

    await tx
      .update(schema.inventoryLots)
      .set({ totalQty: sql`${schema.inventoryLots.totalQty} - ${scan.qty}` })
      .where(eq(schema.inventoryLots.id, existing.id));

    if (existing.totalQty - scan.qty <= 0) {
      await tx.delete(schema.inventoryLots).where(eq(schema.inventoryLots.id, existing.id));
    }

    const sourceLink = await tx.query.inventoryLotSources.findFirst({
      where: (ils, { and }) =>
        and(
          eq(ils.inventoryLotId, existing.id),
          eq(ils.receivingInvoiceItemId, scan.receivingInvoiceItemId)
        ),
    });
    if (sourceLink) {
      if (sourceLink.qty - scan.qty <= 0) {
        await tx.delete(schema.inventoryLotSources).where(eq(schema.inventoryLotSources.id, sourceLink.id));
      } else {
        await tx
          .update(schema.inventoryLotSources)
          .set({ qty: sql`${schema.inventoryLotSources.qty} - ${scan.qty}` })
          .where(eq(schema.inventoryLotSources.id, sourceLink.id));
      }
    }

    await tx
      .update(schema.receivingInvoiceItems)
      .set({ putAwayQty: sql`${schema.receivingInvoiceItems.putAwayQty} - ${scan.qty}` })
      .where(eq(schema.receivingInvoiceItems.id, scan.receivingInvoiceItemId));

    const summary = await tx.query.shelfBoxItems.findFirst({
      where: (sbi, { and, eq }) =>
        and(
          eq(sbi.shelfBoxId, shelfBoxId),
          eq(sbi.receivingInvoiceItemId, scan.receivingInvoiceItemId),
          eq(sbi.partId, scan.partId)
        ),
    });
    if (!summary) throw new I18nError("shelf_box_item_not_found");

    if (summary.qty - scan.qty <= 0) {
      await tx.delete(schema.shelfBoxItems).where(eq(schema.shelfBoxItems.id, summary.id));
    } else {
      await tx
        .update(schema.shelfBoxItems)
        .set({ qty: sql`${schema.shelfBoxItems.qty} - ${scan.qty}` })
        .where(eq(schema.shelfBoxItems.id, summary.id));
    }

    if (box.receivingOrderId) {
      await tryMarkReceivingOrderClear(tx, box.receivingOrderId, actorId);
    }
  });
}
```

- [ ] **Step 5: Add `removeScannedPiece` helper**

Insert after `removeScanFromBox`:

```typescript
export async function removeScannedPiece(
  db: PgliteDatabase<typeof schema>,
  scanId: string
): Promise<void> {
  return db.transaction(async (tx) => {
    const [scan] = await tx
      .select()
      .from(schema.putAwayScans)
      .where(eq(schema.putAwayScans.id, scanId));
    if (!scan) throw new I18nError("put_away_scan_not_found");
    if (scan.shelfBoxId) throw new I18nError("put_away_scan_already_boxed");

    await tx.delete(schema.putAwayScans).where(eq(schema.putAwayScans.id, scanId));
  });
}
```

- [ ] **Step 6: Update `getPutAwayLots` to include scanned/boxed totals and show items with unboxed scans**

Replace the SQL inside `getPutAwayLots` with:

```typescript
export interface PutAwayLot {
  receiving_invoice_item_id: string;
  part_id: string;
  part_no: string | null;
  date_code: string | null;
  lot_code: string | null;
  coo: string | null;
  cow: string | null;
  total_qty: number;
  available_qty: number;
  scanned_qty: number;
  boxed_qty: number;
}

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
      rii.coo,
      rii.cow,
      rii.qty AS total_qty,
      (${availableReceivingQtySql}) AS available_qty,
      COALESCE(SUM(pas.qty), 0) AS scanned_qty,
      COALESCE(SUM(CASE WHEN pas.shelf_box_id IS NOT NULL THEN pas.qty ELSE 0 END), 0) AS boxed_qty
    FROM receiving_orders ro
    JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    JOIN parts p ON p.id = rii.part_id
    LEFT JOIN put_away_scans pas ON pas.receiving_invoice_item_id = rii.id
    LEFT JOIN (${allocationsCte()}) alloc ON alloc.receiving_invoice_item_id = rii.id
    WHERE ro.id = ${receivingOrderId}
      AND ro.status = 'in_hand'
      AND (
        (${availableReceivingQtySql}) > 0
        OR COALESCE(SUM(CASE WHEN pas.shelf_box_id IS NULL THEN pas.qty ELSE 0 END), 0) > 0
      )
    GROUP BY rii.id, p.id, p.part_no, rii.date_code, rii.lot_code, rii.coo, rii.cow, rii.qty
    ORDER BY p.part_no, rii.date_code;
  `).then((r) =>
    (r.rows ?? []).map((row) => ({
      ...row,
      total_qty: Number(row.total_qty ?? 0),
      available_qty: Number(row.available_qty ?? 0),
      scanned_qty: Number(row.scanned_qty ?? 0),
      boxed_qty: Number(row.boxed_qty ?? 0),
    })) as PutAwayLot[]
  );
}
```

- [ ] **Step 7: Update `cancelShelfBox` emptiness check**

Replace the `shelf_box_items` count check in `cancelShelfBox` with:

```typescript
const scanResult = await tx
  .select({ count: sql<number>`count(*)`.mapWith(Number) })
  .from(schema.putAwayScans)
  .where(eq(schema.putAwayScans.shelfBoxId, boxId));
if ((scanResult[0]?.count ?? 0) > 0) throw new I18nError("shelf_box_is_not_empty");
```

Remove the old `shelf_box_items` count check.

- [ ] **Step 8: Commit**

```bash
git add db/putAway.ts db/helpers.ts
git commit -m "feat(put-away): add scan helpers and update lot query"
```

---

## Task 4: Update the put-away scan matcher

**Files:**
- Modify: `composables/useScanMatchers.ts`

- [ ] **Step 1: Update `runScanMatcher` put-away branch**

Remove `targetBoxId` from the put-away branch:

```typescript
case 'put-away':
  if (!ctx.receivingItem) return m.error('missing_receiving_item');
  return m.matchPutAway(ctx.receivingItem, parsed);
```

- [ ] **Step 2: Update `ScanTaskContext` interface**

Remove `targetBoxId` from the put-away comment block in `ScanTaskContext`.

- [ ] **Step 3: Update `matchPutAway` signature and logic**

Replace the entire `matchPutAway` function:

```typescript
async function matchPutAway(receivingItem: PutAwayLot, parsed: OcrInput): Promise<ScanMatchResult> {
  try {
    const user = currentUser.value;
    if (!user?.id) return error('operator_not_signed_in');

    const scannedPartNo = normalize(parsed.partNo ?? '');
    const expectedPartNo = normalize(receivingItem.part_no ?? '');
    if (!scannedPartNo) return { type: 'none' };
    if (scannedPartNo !== expectedPartNo) return error('scanned_part_does_not_match_item');

    const qty = typeof parsed.qty === 'number' ? parsed.qty : Number(parsed.qty);
    if (!Number.isInteger(qty) || qty <= 0) return error('qty_must_be_positive_integer');
    if (!receivingItem?.receiving_invoice_item_id) return error('invalid_receiving_item');
    if (qty > (receivingItem.available_qty ?? 0)) return error('quantity_exceeds_available');

    const dateCode = rawCode(parsed.dateCode);
    const lotCode = rawCode(parsed.lotCode);
    const coo = rawCode(parsed.coo);
    const cow = rawCode(parsed.cow);

    return {
      type: 'single',
      record: receivingItem,
      apply: async () => {
        const actorId = currentUser.value?.id;
        if (!actorId) throw new I18nError('operator_not_signed_in');
        await recordPutAwayScan(
          db,
          receivingItem.receiving_invoice_item_id,
          qty,
          dateCode,
          lotCode,
          coo,
          cow,
          actorId
        );
      },
    };
  } catch (e: any) {
    return e instanceof I18nError ? error(e) : error(new I18nError('unknown_match_failed', { task: 'put-away' }));
  }
}
```

Add the import for `recordPutAwayScan` at the top of `composables/useScanMatchers.ts`:

```typescript
import { recordPutAwayScan } from '~/db/putAway';
```

- [ ] **Step 4: Commit**

```bash
git add composables/useScanMatchers.ts
git commit -m "feat(put-away): scan matcher records pieces without target box"
```

---

## Task 5: Add i18n keys

**Files:**
- Modify: `i18n/locales/en-US.ts`
- Modify: `i18n/locales/zh-CN.ts`
- Modify: `i18n/locales/zh-HK.ts`

- [ ] **Step 1: Add English error keys**

Under `errors` in `en-US.ts`, add:

```typescript
scanned_qty_exceeds_total: "Scanned quantity exceeds remaining quantity for this item",
put_away_scan_not_found: "Scanned piece not found",
put_away_scan_already_boxed: "Scanned piece is already in a box",
put_away_scan_not_boxed: "Scanned piece is not in a box",
```

- [ ] **Step 2: Add English UI keys**

Under `putAway.lotsPanel` in `en-US.ts`, add or replace with:

```typescript
lotsPanel: {
  title: "Items to put away",
  part: "Part",
  totalQty: "Total",
  scannedQty: "Scanned",
  boxedQty: "Boxed",
  dateLot: "Date / Lot",
  cooCow: "COO / COW",
  scans: "Scanned pieces",
  noScans: "No scanned pieces yet",
  selectBox: "Select box",
  addToBox: "Add to box",
  addingToBox: "Adding...",
  removeFromBox: "Remove from box",
  removingFromBox: "Removing...",
  removeScan: "Remove scan",
  removingScan: "Removing...",
  scan: "Scan piece",
  expandScans: "Show pieces",
  collapseScans: "Hide pieces",
},
```

Remove obsolete keys like `selectTargetBox` and `availableQty` if no longer used.

- [ ] **Step 3: Add Chinese (Simplified) translations**

Add corresponding keys in `zh-CN.ts`:

```typescript
scanned_qty_exceeds_total: "扫描数量超过该物品的剩余数量",
put_away_scan_not_found: "未找到已扫描的物品",
put_away_scan_already_boxed: "已扫描的物品已在箱子中",
put_away_scan_not_boxed: "已扫描的物品不在箱子中",
```

And UI keys:

```typescript
lotsPanel: {
  title: "待上架物品",
  part: "料号",
  totalQty: "总数",
  scannedQty: "已扫描",
  boxedQty: "已装箱",
  dateLot: "日期 / 批次",
  cooCow: "产地 / 保修地",
  scans: "已扫描件",
  noScans: "尚未扫描任何件",
  selectBox: "选择箱子",
  addToBox: "加入箱子",
  addingToBox: "加入中...",
  removeFromBox: "从箱子移除",
  removingFromBox: "移除中...",
  removeScan: "移除扫描",
  removingScan: "移除中...",
  scan: "扫描件",
  expandScans: "显示件",
  collapseScans: "隐藏件",
},
```

- [ ] **Step 4: Add Chinese (Traditional) translations**

Add corresponding keys in `zh-HK.ts`:

```typescript
scanned_qty_exceeds_total: "掃描數量超過該物品的剩餘數量",
put_away_scan_not_found: "未找到已掃描的物品",
put_away_scan_already_boxed: "已掃描的物品已在箱子中",
put_away_scan_not_boxed: "已掃描的物品不在箱子中",
```

And UI keys:

```typescript
lotsPanel: {
  title: "待上架物品",
  part: "料號",
  totalQty: "總數",
  scannedQty: "已掃描",
  boxedQty: "已裝箱",
  dateLot: "日期 / 批次",
  cooCow: "產地 / 保修地",
  scans: "已掃描件",
  noScans: "尚未掃描任何件",
  selectBox: "選擇箱子",
  addToBox: "加入箱子",
  addingToBox: "加入中...",
  removeFromBox: "從箱子移除",
  removingFromBox: "移除中...",
  removeScan: "移除掃描",
  removingScan: "移除中...",
  scan: "掃描件",
  expandScans: "顯示件",
  collapseScans: "隱藏件",
},
```

- [ ] **Step 5: Commit**

```bash
git add i18n/locales
git commit -m "feat(put-away): add i18n keys for scan-first flow"
```

---

## Task 6: Redesign `PutAwayLotsPanel.vue`

**Files:**
- Modify: `components/put-away/PutAwayLotsPanel.vue`

- [ ] **Step 1: Replace the template with the scan-first layout**

Replace the entire `<template>` block:

```vue
<template>
  <div class="lots-panel">
    <h2 class="section-title">{{ $t('putAway.lotsPanel.title') }}</h2>
    <p v-if="lots.length === 0" class="empty">{{ $t('common.noLots') }}</p>

    <div
      v-for="lot in lots"
      :key="lot.receiving_invoice_item_id"
      class="card"
    >
      <DetailRow :label="$t('putAway.lotsPanel.part')">
        <span class="card__title">{{ lot.part_no || $t('common.noData') }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.dateLot')">
        <span>{{ lot.date_code || $t('common.noData') }} / {{ lot.lot_code || $t('common.noData') }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.cooCow')">
        <span>{{ lot.coo || $t('common.noData') }} / {{ lot.cow || $t('common.noData') }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.totalQty')">
        <span>{{ lot.total_qty }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.scannedQty')">
        <span>{{ lot.scanned_qty }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.boxedQty')">
        <span>{{ lot.boxed_qty }}</span>
      </DetailRow>

      <div class="lot-actions">
        <button
          class="btn btn--small"
          :disabled="scanning"
          @click="emit('scan', lot)"
        >
          {{ $t('putAway.lotsPanel.scan') }}
        </button>
        <button
          class="btn btn--small btn--ghost"
          @click="toggleExpand(lot.receiving_invoice_item_id)"
        >
          {{ expandedItems.has(lot.receiving_invoice_item_id) ? $t('putAway.lotsPanel.collapseScans') : $t('putAway.lotsPanel.expandScans') }}
        </button>
      </div>

      <div v-if="expandedItems.has(lot.receiving_invoice_item_id)" class="scans-list">
        <p v-if="!scansByItem[lot.receiving_invoice_item_id]?.length" class="empty">
          {{ $t('putAway.lotsPanel.noScans') }}
        </p>
        <div
          v-for="scan in scansByItem[lot.receiving_invoice_item_id]"
          :key="scan.id"
          class="scan-row"
        >
          <div class="scan-info">
            <span>{{ scan.qty }} {{ $t('common.pcs') }}</span>
            <span class="scan-meta">
              {{ scan.dateCode || $t('common.stateNone') }} / {{ scan.lotCode || $t('common.stateNone') }} / {{ scan.coo || $t('common.stateNone') }} / {{ scan.cow || $t('common.stateNone') }}
            </span>
            <span v-if="scan.shelfBoxId" class="scan-box">
              {{ $t('common.inBox', { id: scan.shelfBoxId }) }}
            </span>
            <span v-else class="scan-box scan-box--unboxed">{{ $t('common.unboxed') }}</span>
          </div>
          <div class="scan-actions">
            <template v-if="!scan.shelfBoxId">
              <select
                :value="boxSelections[scan.id]"
                :disabled="addingScan[scan.id] || removingScan[scan.id]"
                @change="updateBoxSelection(scan.id, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">{{ $t('putAway.lotsPanel.selectBox') }}</option>
                <option v-for="box in openBoxes" :key="box.id" :value="box.id">
                  {{ box.id }} · {{ box.shelfCode || $t('common.noData') }}
                </option>
              </select>
              <button
                class="btn btn--small"
                :disabled="addingScan[scan.id] || removingScan[scan.id] || !boxSelections[scan.id]"
                @click="emit('add-to-box', scan.id)"
              >
                <template v-if="addingScan[scan.id]">
                  <InlineSpinner /> {{ $t('putAway.lotsPanel.addingToBox') }}
                </template>
                <template v-else>
                  {{ $t('putAway.lotsPanel.addToBox') }}
                </template>
              </button>
              <button
                class="btn btn--small btn--secondary"
                :disabled="addingScan[scan.id] || removingScan[scan.id]"
                @click="emit('remove-scan', scan.id)"
              >
                <template v-if="removingScan[scan.id]">
                  <InlineSpinner /> {{ $t('putAway.lotsPanel.removingScan') }}
                </template>
                <template v-else>
                  {{ $t('putAway.lotsPanel.removeScan') }}
                </template>
              </button>
            </template>
            <button
              v-else-if="boxById(scan.shelfBoxId)?.status === 'open'"
              class="btn btn--small"
              :disabled="removingScan[scan.id]"
              @click="emit('remove-from-box', scan.id)"
            >
              <template v-if="removingScan[scan.id]">
                <InlineSpinner /> {{ $t('putAway.lotsPanel.removingFromBox') }}
              </template>
              <template v-else>
                {{ $t('putAway.lotsPanel.removeFromBox') }}
              </template>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Replace the `<script setup>` block**

Replace the entire `<script setup>` block:

```vue
<script setup lang="ts">
import type { PutAwayLot, ShelfBox } from "~/db/putAway";
import type { PutAwayScan } from "~/db/putAway";
import InlineSpinner from "~/components/InlineSpinner.vue";

interface Props {
  lots: PutAwayLot[];
  scans: PutAwayScan[];
  boxes: ShelfBox[];
  scanning: boolean;
  addingScan: Record<string, boolean>;
  removingScan: Record<string, boolean>;
  boxSelections: Record<string, string>;
  expandedItems: Set<string>;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  scan: [lot: PutAwayLot];
  "add-to-box": [scanId: string];
  "remove-from-box": [scanId: string];
  "remove-scan": [scanId: string];
  "update:boxSelections": [value: Record<string, string>];
  "update:expandedItems": [value: Set<string>];
}>();

const openBoxes = computed(() => props.boxes.filter((b) => b.status === "open"));

const scansByItem = computed(() => {
  const map: Record<string, PutAwayScan[]> = {};
  for (const scan of props.scans) {
    if (!map[scan.receivingInvoiceItemId]) map[scan.receivingInvoiceItemId] = [];
    map[scan.receivingInvoiceItemId].push(scan);
  }
  return map;
});

function boxById(boxId: string | null) {
  return props.boxes.find((b) => b.id === boxId);
}

function updateBoxSelection(scanId: string, value: string) {
  emit("update:boxSelections", { ...props.boxSelections, [scanId]: value });
}

function toggleExpand(itemId: string) {
  const next = new Set(props.expandedItems);
  if (next.has(itemId)) {
    next.delete(itemId);
  } else {
    next.add(itemId);
  }
  emit("update:expandedItems", next);
}
</script>
```

- [ ] **Step 3: Update `<style scoped>`**

Append to the existing style block or replace it with:

```vue
<style scoped>
.lots-panel {
  margin-top: 1.5rem;
}

.section-title {
  margin: 0 0 1rem;
  font-size: 1rem;
}

.lot-actions {
  margin-top: 0.75rem;
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.scans-list {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}

.scan-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border);
}

.scan-row:last-child {
  border-bottom: none;
}

.scan-info {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  font-size: 0.875rem;
  align-items: center;
}

.scan-meta {
  color: var(--muted);
}

.scan-box {
  font-size: 0.75rem;
  color: var(--muted);
}

.scan-box--unboxed {
  color: var(--warning);
}

.scan-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}

.scan-actions select {
  min-width: 8rem;
}
</style>
```

- [ ] **Step 4: Commit**

```bash
git add components/put-away/PutAwayLotsPanel.vue
git commit -m "feat(put-away): redesign lots panel for scan-first flow"
```

---

## Task 7: Update `pages/put-away/[id].vue`

**Files:**
- Modify: `pages/put-away/[id].vue`

- [ ] **Step 1: Update imports**

Replace the `db/putAway` import block with:

```typescript
import {
  getPutAwayLots,
  getPutAwayScansForReceivingOrder,
  recordPutAwayScan,
  assignScanToBox,
  removeScanFromBox,
  removeScannedPiece,
  createShelfBox,
  closeShelfBox,
  cancelShelfBox,
  getShelfBoxesForReceivingOrder,
  type ShelfBox,
  type PutAwayScan,
} from "~/db/putAway";
```

- [ ] **Step 2: Remove target-box selection state and add scan-related state**

Remove:

```typescript
const targetBoxSelections = ref<Record<string, string>>({});
```

Add after `boxes`:

```typescript
const scans = ref<PutAwayScan[]>([]);
const addingScan = ref<Record<string, boolean>>({});
const removingScan = ref<Record<string, boolean>>({});
const boxSelections = ref<Record<string, string>>({});
const expandedItems = ref<Set<string>>(new Set());
```

- [ ] **Step 3: Update `load()` to fetch scans**

Change the `Promise.all` in `load()` to:

```typescript
const [orderData, lotsData, shelvesData, boxesData, scansData] = await Promise.all([
  getReceivingOrderDetail(db, orderId),
  getPutAwayLots(db, orderId),
  db.query.shelves.findMany(),
  getShelfBoxesForReceivingOrder(db, orderId),
  getPutAwayScansForReceivingOrder(db, orderId),
]);
```

And add after `boxes.value = boxesData;`:

```typescript
scans.value = scansData;
```

Also remove the `targetBoxSelections` cleanup block inside `load()`.

- [ ] **Step 4: Update `openScan()` to remove target box logic**

Replace `openScan` with:

```typescript
async function openScan(lot: PutAwayLot) {
  error.value = null;
  scanLot.value = lot;
  const result = await scan({
    task: 'put-away',
    receivingItem: lot,
    targets: lot.part_no ? [lot.part_no] : [],
  });
  if (result.status === 'error') {
    error.value = result.message;
  }
}
```

- [ ] **Step 5: Add assignment and removal handlers**

Insert before `useVisibleReload(load);`:

```typescript
async function addScanToBox(scanId: string) {
  const boxId = boxSelections.value[scanId];
  if (!boxId) return;
  addingScan.value[scanId] = true;
  try {
    if (!currentUser.value?.id) throw new I18nError("operator_not_signed_in");
    await assignScanToBox(db, scanId, boxId, currentUser.value.id);
    await load();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    addingScan.value[scanId] = false;
  }
}

async function removeScanFromBoxHandler(scanId: string) {
  removingScan.value[scanId] = true;
  try {
    if (!currentUser.value?.id) throw new I18nError("operator_not_signed_in");
    await removeScanFromBox(db, scanId, currentUser.value.id);
    await load();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    removingScan.value[scanId] = false;
  }
}

async function removeScanHandler(scanId: string) {
  removingScan.value[scanId] = true;
  try {
    await removeScannedPiece(db, scanId);
    await load();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    removingScan.value[scanId] = false;
  }
}
```

- [ ] **Step 6: Update the template bindings**

Replace the `<PutAwayLotsPanel>` usage with:

```vue
<PutAwayLotsPanel
  v-model:box-selections="boxSelections"
  v-model:expanded-items="expandedItems"
  :lots="lots"
  :scans="scans"
  :boxes="boxes"
  :scanning="scanning"
  :adding-scan="addingScan"
  :removing-scan="removingScan"
  @scan="openScan"
  @add-to-box="addScanToBox"
  @remove-from-box="removeScanFromBoxHandler"
  @remove-scan="removeScanHandler"
/>
```

- [ ] **Step 7: Commit**

```bash
git add pages/put-away/[id].vue
git commit -m "feat(put-away): wire scan-first handlers on detail page"
```

---

## Task 8: Update test label HTML

**Files:**
- Modify: `public/ocr-labels.html`

- [ ] **Step 1: Find the put-away example label and reduce its qty**

Search for the put-away label section in `public/ocr-labels.html`. It likely contains a qty matching the full receiving item total. Change that qty to roughly half or one-third of the total so multiple scans are required to reach the total.

Example change:

```html
<!-- before -->
<div class="label-row"><span>QTY:</span><span>10000</span></div>

<!-- after -->
<div class="label-row"><span>QTY:</span><span>5000</span></div>
```

- [ ] **Step 2: Commit**

```bash
git add public/ocr-labels.html
git commit -m "chore(put-away): set test label qty to half of item total"
```

---

## Task 9: Update tests

**Files:**
- Modify: `tests/scanMatchers.test.ts`
- Create: `tests/putAway.test.ts`

- [ ] **Step 1: Update put-away matcher tests in `tests/scanMatchers.test.ts`**

Find existing put-away tests. Update them to pass a `PutAwayLot` without `targetBoxId` and assert that `recordPutAwayScan` is called.

Example test:

```typescript
test('put-away scan records a piece when part and qty match', async () => {
  const receivingItem: PutAwayLot = {
    receiving_invoice_item_id: 'rii-1',
    part_id: 'part-1',
    part_no: 'KOA123',
    date_code: null,
    lot_code: null,
    coo: null,
    cow: null,
    total_qty: 10000,
    available_qty: 10000,
    scanned_qty: 0,
    boxed_qty: 0,
  };

  const result = await matchers.matchPutAway(receivingItem, {
    partNo: 'KOA123',
    qty: '5000',
    dateCode: '',
    lotCode: '',
    coo: '',
    cow: '',
  });

  expect(result.type).toBe('single');
  if (result.type !== 'single') return;
  await result.apply();
  // assert scan was recorded (mock or integration)
});
```

- [ ] **Step 2: Create `tests/putAway.test.ts`**

Create the file with integration-style tests using the in-memory PGlite test setup (follow the pattern in `tests/useLabelScan.test.ts` or other DB tests if they exist).

```typescript
import { describe, test, expect, beforeEach } from 'vitest';
import { recordPutAwayScan, assignScanToBox, removeScanFromBox, removeScannedPiece, cancelShelfBox } from '~/db/putAway';

// Use the same test DB setup pattern as other tests

describe('put-away scan flow', () => {
  test('records a scan within remaining qty', async () => {
    // seed receiving item with qty 10000
    // record scan of 5000
    // assert scan exists and is unboxed
  });

  test('rejects scan that exceeds remaining qty', async () => {
    // seed item qty 10000
    // record scan 6000, then attempt scan 5000 -> throws scanned_qty_exceeds_total
  });

  test('assigns scan to box and updates inventory', async () => {
    // seed item, scan, shelf box
    // assign scan to box
    // assert putAwayQty increased, inventory lot created, shelfBoxItems row created
  });

  test('removes scan from box and reverses inventory', async () => {
    // seed item, scan, box, assign
    // remove from box
    // assert putAwayQty decreased, scan unboxed
  });

  test('removes unboxed scan', async () => {
    // seed item and scan
    // removeScannedPiece
    // assert scan deleted
  });

  test('cannot cancel box with assigned scans', async () => {
    // seed box and assigned scan
    // cancelShelfBox -> throws shelf_box_is_not_empty
  });
});
```

If the project does not have an existing PGlite test harness, use the `useDb()` composable inside a Nuxt test context, or mock the DB calls. Check existing tests for the pattern.

- [ ] **Step 3: Run tests**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests
git commit -m "test(put-away): add scan-first flow tests"
```

---

## Task 10: Update documentation

**Files:**
- Modify: `docs/app-docs/flows/put-away/overview.md`
- Modify: `docs/app-docs/flows/put-away/steps.md`
- Modify: `docs/app-docs/flows/put-away/ai-scope.md`
- Modify: `docs/app-docs/ai/feature-registry.md` if feature mapping changed.
- Modify: `docs/app-docs/ai/code-map.md` if file mapping changed.

- [ ] **Step 1: Update `overview.md`**

Replace the concept list with:

```markdown
1. The operator opens the Put-away list.
2. The operator selects a put-away task or receiving order.
3. The app shows items available to move.
4. The operator scans each physical piece of an item; scanned pieces accumulate under that item.
5. The operator creates a shelf box on a selected shelf.
6. The operator assigns whole scanned pieces to the shelf box.
7. The operator closes the box when done; the inventory lot is updated with the new shelf location.
```

- [ ] **Step 2: Update `steps.md`**

Rewrite steps 3–6 to match the scan-first flow:

```markdown
## 3. Review available items

The detail shows receiving-area items waiting to be put away, with total, scanned, and boxed quantities.

## 4. Scan physical pieces

For each item, tap **Scan piece** and scan a physical label. Each scan records one piece with its own quantity, date code, lot code, COO, and COW. Repeat until the scanned quantity reaches the item total.

## 5. Create a shelf box

Tap **New box**, select a shelf, and confirm. The box appears in the shelf boxes panel.

## 6. Assign pieces to boxes

Under each item, select an open box from the dropdown next to an unboxed scan and tap **Add to box**. You can also remove a scan or remove a piece from a box while the box is still open.

## 7. Close the box

Tap **Close box** when the box contains all the pieces you want to store. The inventory lot is updated with the shelf location.
```

- [ ] **Step 3: Update `ai-scope.md`**

Update key files and known limitations as needed. Add a note that `put_away_scans` tracks individual pieces and `shelf_box_items` is a box-level summary.

- [ ] **Step 4: Commit**

```bash
git add docs/app-docs
git commit -m "docs(put-away): update scan-first flow docs"
```

---

## Task 11: Final verification

- [ ] **Step 1: Run type generation and tests**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm nuxt prepare
pnpm test
```

Expected: `Types generated in .nuxt.` and all tests pass.

- [ ] **Step 2: Build web assets and sync Capacitor**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm generate
npx cap sync android
```

Expected: build succeeds, sync copies assets to `android/app/src/main/assets/public`.

- [ ] **Step 3: Build and install debug APK**

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:installDebug
```

Expected: `BUILD SUCCESSFUL` and `Installed on 1 device.`

- [ ] **Step 4: Clear IndexedDB on the device**

Because the schema changed, the demo database must be cleared. Use the instructions in `AGENTS.md` or tell the operator to clear app storage.

- [ ] **Step 5: Commit any remaining changes**

```bash
git add -A
git commit -m "feat(put-away): complete scan-first flow"
```

---

## Plan self-review

**Spec coverage:**
- New `put_away_scans` table → Task 1.
- Scan-first UI flow → Tasks 6 and 7.
- Scanning without target box → Task 4.
- Manual add/remove from box → Tasks 3 and 6.
- Update `ocr-labels.html` test label → Task 8.
- Tests → Task 9.
- Docs → Task 10.
- IndexedDB clear note → Task 11.

**Placeholder scan:** No placeholders, TODOs, or vague steps.

**Type consistency:**
- `PutAwayLot` gains `total_qty`, `available_qty`, `scanned_qty`, `boxed_qty` — used in matcher and UI.
- `PutAwayScan` type alias used across DB helpers and UI.
- `matchPutAway` signature updated consistently in `runScanMatcher` and `useScanMatchers`.

No gaps found.
