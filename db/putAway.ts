import { eq, sql, isNull, desc } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";
import { tryMarkReceivingOrderClear } from "./receiving";
import { getIsoWeek } from "./date";

async function generateShelfBoxId(
  tx: PgliteDatabase<typeof schema>,
  locationCode = "HK1"
): Promise<string> {
  const now = new Date();
  const week = String(getIsoWeek(now)).padStart(2, "0");
  const year = String(now.getFullYear() % 100).padStart(2, "0");
  const prefix = `SBOX-${locationCode}-${week}${year}`;

  const existing = await tx
    .select({ id: schema.shelfBoxes.id })
    .from(schema.shelfBoxes)
    .where(sql`${schema.shelfBoxes.id} LIKE ${prefix + "%"}`);

  let maxSeq = 0;
  const regex = new RegExp(`^${prefix.replace(/[-]/g, "\\-")}([0-9]{6})$`);
  for (const row of existing) {
    const match = row.id.match(regex);
    if (match) maxSeq = Math.max(maxSeq, parseInt(match[1], 10));
  }

  return `${prefix}${String(maxSeq + 1).padStart(6, "0")}`;
}

export interface PutAwayCandidate {
  id: string;
  ref_no: string;
  status: string;
  supplier_name: string | null;
  available_qty: number;
}

export interface PutAwayLot {
  receiving_invoice_item_id: string;
  part_id: string;
  part_no: string | null;
  date_code: string | null;
  lot_code: string | null;
  coo: string | null;
  cow: string | null;
  available_qty: number;
}

export async function getPutAwayCandidates(
  db: PgliteDatabase<typeof schema>
): Promise<PutAwayCandidate[]> {
  return db.execute(sql`
    SELECT
      ro.id,
      ro.ref_no,
      ro.status,
      s.name AS supplier_name,
      SUM(rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0)) AS available_qty
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
  `).then((r) =>
    (r.rows ?? []).map((row) => ({
      ...row,
      available_qty: Number(row.available_qty ?? 0),
    })) as PutAwayCandidate[]
  );
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
      AND rii.received_qty - rii.picked_qty - rii.put_away_qty -
          COALESCE(alloc.allocated_qty, 0) > 0
    ORDER BY p.part_no, rii.date_code;
  `).then((r) =>
    (r.rows ?? []).map((row) => ({
      ...row,
      available_qty: Number(row.available_qty ?? 0),
    })) as PutAwayLot[]
  );
}

export async function createShelfBox(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string,
  shelfCode: string,
  actorId: string,
  locationCode = "HK1"
): Promise<typeof schema.shelfBoxes.$inferSelect> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const boxId = await generateShelfBoxId(tx, locationCode);

    const [box] = await tx
      .insert(schema.shelfBoxes)
      .values({
        id: boxId,
        receivingOrderId,
        shelfCode,
        status: "open",
        createdAt: now,
      })
      .returning();

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "shelf_box",
      entityId: boxId,
      fromState: null,
      toState: "open",
      actorId,
      metadata: JSON.stringify({ receivingOrderId, shelfCode }),
      createdAt: now,
    });

    return box;
  });
}

export async function addItemToShelfBox(
  db: PgliteDatabase<typeof schema>,
  shelfBoxId: string,
  receivingInvoiceItemId: string,
  qty: number,
  dateCode: string | null,
  lotCode: string | null,
  coo: string | null,
  cow: string | null,
  actorId: string
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
    if (!invoice) throw new Error("Invoice not found");
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
          dateCode != null ? eq(il.dateCode, dateCode) : isNull(il.dateCode),
          lotCode != null ? eq(il.lotCode, lotCode) : isNull(il.lotCode),
          coo != null ? eq(il.coo, coo) : isNull(il.coo),
          cow != null ? eq(il.cow, cow) : isNull(il.cow)
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
        coo,
        cow,
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

    if (invoice.receivingOrderId) {
      await tryMarkReceivingOrderClear(tx, invoice.receivingOrderId, actorId);
    }

    return shelfBoxItem;
  });
}

export async function closeShelfBox(
  db: PgliteDatabase<typeof schema>,
  shelfBoxId: string,
  actorId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const [box] = await tx
      .select()
      .from(schema.shelfBoxes)
      .where(eq(schema.shelfBoxes.id, shelfBoxId));
    if (!box) throw new Error("Shelf box not found");
    if (box.status !== "open") throw new Error("Shelf box is not open");

    const [itemsCount] = await tx
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.shelfBoxItems)
      .where(eq(schema.shelfBoxItems.shelfBoxId, shelfBoxId));
    if ((itemsCount?.count ?? 0) === 0) {
      throw new Error("Cannot close an empty shelf box");
    }

    await tx
      .update(schema.shelfBoxes)
      .set({ status: "closed" })
      .where(eq(schema.shelfBoxes.id, shelfBoxId));

    if (box.receivingOrderId) {
      await tryMarkReceivingOrderClear(tx, box.receivingOrderId, actorId);
    }

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "shelf_box",
      entityId: shelfBoxId,
      fromState: box.status,
      toState: "closed",
      actorId,
      metadata: null,
      createdAt: new Date(),
    });
  });
}

export async function getShelfBoxesForReceivingOrder(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string
) {
  return db.query.shelfBoxes.findMany({
    where: eq(schema.shelfBoxes.receivingOrderId, receivingOrderId),
    orderBy: (sb, { sql }) => [
      sql`case when ${sb.status} = 'open' then 0 else 1 end`,
      desc(sb.createdAt),
    ],
    with: {
      items: { with: { part: true } },
    },
  });
}
