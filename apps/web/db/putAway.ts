import { eq, sql, isNull, desc, and } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";
import { tryMarkReceivingOrderClear } from "./receiving";
import { I18nError } from "~/composables/i18nError";
import { generateLocationBoxId, getLocationBoxIdPrefix } from "~/utils/ids";
import { availableReceivingQtySql, allocationsCte } from "./helpers";

async function generateShelfBoxId(tx: PgliteDatabase<typeof schema>): Promise<string> {
  const locationCode = "HK1";
  const prefix = getLocationBoxIdPrefix("SBOX", locationCode);

  const existing = await tx
    .select({ id: schema.shelfBoxes.id })
    .from(schema.shelfBoxes)
    .where(sql`${schema.shelfBoxes.id} LIKE ${prefix + "%"}`);

  return generateLocationBoxId("SBOX", locationCode, existing.map((r) => r.id));
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
  total_qty: number;
  available_qty: number;
  scanned_qty: number;
  boxed_qty: number;
}

export type PutAwayScan = typeof schema.putAwayScans.$inferSelect;

export async function recordPutAwayScan(
  db: PgliteDatabase<typeof schema>,
  receivingInvoiceItemId: string,
  qty: number,
  dateCode: string | null,
  lotCode: string | null,
  coo: string | null,
  cow: string | null
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

    const allocatedResult = await tx.execute(sql`
      SELECT COALESCE(alloc.allocated_qty, 0) AS allocated_qty
      FROM receiving_invoice_items rii
      LEFT JOIN (${allocationsCte()}) alloc ON alloc.receiving_invoice_item_id = rii.id
      WHERE rii.id = ${receivingInvoiceItemId}
    `);
    const allocated = Number((allocatedResult.rows[0] as any)?.allocated_qty ?? 0);

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

export async function getPutAwayCandidates(
  db: PgliteDatabase<typeof schema>
): Promise<PutAwayCandidate[]> {
  return db.execute(sql`
    SELECT
      ro.id,
      ro.ref_no,
      ro.status,
      s.name AS supplier_name,
      SUM(${availableReceivingQtySql}) AS available_qty,
      COALESCE(SUM(unboxed.unboxed_qty), 0) AS unboxed_qty
    FROM receiving_orders ro
    JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    LEFT JOIN suppliers s ON s.id = ro.supplier_id
    LEFT JOIN (${allocationsCte()}) alloc ON alloc.receiving_invoice_item_id = rii.id
    LEFT JOIN (
      SELECT receiving_invoice_item_id, SUM(qty) AS unboxed_qty
      FROM put_away_scans
      WHERE shelf_box_id IS NULL
      GROUP BY receiving_invoice_item_id
    ) unboxed ON unboxed.receiving_invoice_item_id = rii.id
    WHERE ro.status = 'in_hand'
    GROUP BY ro.id, ro.ref_no, ro.status, s.name
    HAVING SUM(${availableReceivingQtySql}) > 0 OR COALESCE(SUM(unboxed.unboxed_qty), 0) > 0
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
    GROUP BY rii.id, p.id, p.part_no, rii.date_code, rii.lot_code, rii.coo, rii.cow, rii.qty,
             alloc.allocated_qty, alloc.unboxed_scanned_qty
    HAVING (${availableReceivingQtySql}) > 0
       OR COALESCE(SUM(CASE WHEN pas.shelf_box_id IS NULL THEN pas.qty ELSE 0 END), 0) > 0
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

export async function getPutAwayScansForReceivingOrder(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string
): Promise<PutAwayScan[]> {
  const result = await db.execute(sql`
    SELECT
      pas.id,
      pas.receiving_invoice_item_id AS "receivingInvoiceItemId",
      pas.part_id AS "partId",
      pas.qty,
      pas.date_code AS "dateCode",
      pas.lot_code AS "lotCode",
      pas.coo,
      pas.cow,
      pas.shelf_box_id AS "shelfBoxId",
      pas.verified,
      pas.verified_at AS "verifiedAt",
      pas.created_at AS "createdAt"
    FROM put_away_scans pas
    JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    WHERE ri.receiving_order_id = ${receivingOrderId}
    ORDER BY pas.created_at DESC
  `);
  return (result.rows ?? []).map((row) => ({
    id: String(row.id),
    receivingInvoiceItemId: String(row.receivingInvoiceItemId),
    partId: String(row.partId),
    qty: Number(row.qty),
    dateCode: row.dateCode as string | null,
    lotCode: row.lotCode as string | null,
    coo: row.coo as string | null,
    cow: row.cow as string | null,
    shelfBoxId: row.shelfBoxId as string | null,
    verified: Boolean(row.verified),
    verifiedAt: row.verifiedAt ? new Date(String(row.verifiedAt)) : null,
    createdAt: new Date(String(row.createdAt)),
  })) as PutAwayScan[];
}

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

    if (invoice.receivingOrderId) {
      await tryMarkReceivingOrderClear(tx, invoice.receivingOrderId, actorId);
    }
  });
}

export async function addAllUnboxedScansToBox(
  db: PgliteDatabase<typeof schema>,
  shelfBoxId: string,
  actorId: string
): Promise<number> {
  if (!actorId) throw new I18nError("actor_required");
  return db.transaction(async (tx) => {
    const [box] = await tx
      .select()
      .from(schema.shelfBoxes)
      .where(eq(schema.shelfBoxes.id, shelfBoxId));
    if (!box) throw new I18nError("shelf_box_not_found");
    if (box.status !== "open") throw new I18nError("shelf_box_is_not_open");

    const scansResult = await tx.execute(sql`
      SELECT pas.id
      FROM put_away_scans pas
      JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      WHERE ri.receiving_order_id = ${box.receivingOrderId}
        AND pas.shelf_box_id IS NULL
      ORDER BY pas.created_at ASC
    `);

    const scanIds = (scansResult.rows ?? []).map((row) => String(row.id));
    for (const scanId of scanIds) {
      await assignScanToBox(tx, scanId, shelfBoxId, actorId);
    }

    return scanIds.length;
  });
}

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
      .update(schema.putAwayScans)
      .set({ verified: false, verifiedAt: null })
      .where(eq(schema.putAwayScans.id, scanId));

    await tx
      .update(schema.receivingInvoiceItems)
      .set({ putAwayQty: sql`${schema.receivingInvoiceItems.putAwayQty} - ${scan.qty}` })
      .where(eq(schema.receivingInvoiceItems.id, scan.receivingInvoiceItemId));

    if (box.receivingOrderId) {
      await tryMarkReceivingOrderClear(tx, box.receivingOrderId, actorId);
    }
  });
}

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

export async function createShelfBox(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string,
  shelfCode: string,
  actorId: string
): Promise<typeof schema.shelfBoxes.$inferSelect> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const boxId = await generateShelfBoxId(tx);

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

export async function cancelShelfBox(
  db: PgliteDatabase<typeof schema>,
  boxId: string,
  actorId: string
): Promise<void> {
  return db.transaction(async (tx) => {
    const box = await tx.query.shelfBoxes.findFirst({
      where: eq(schema.shelfBoxes.id, boxId),
    });
    if (!box) throw new I18nError("shelf_box_not_found");
    if (box.status !== "open") throw new I18nError("shelf_box_is_not_open");

    const [itemsCount] = await tx
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.putAwayScans)
      .where(eq(schema.putAwayScans.shelfBoxId, boxId));
    if ((itemsCount?.count ?? 0) > 0) throw new I18nError("shelf_box_is_not_empty");

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "shelf_box",
      entityId: boxId,
      fromState: box.status,
      toState: "cancelled",
      actorId,
      metadata: JSON.stringify({ receivingOrderId: box.receivingOrderId, shelfCode: box.shelfCode }),
      createdAt: new Date(),
    });

    await tx.delete(schema.shelfBoxes).where(eq(schema.shelfBoxes.id, boxId));
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
    if (!box) throw new I18nError("shelf_box_not_found");
    if (box.status !== "open") throw new I18nError("shelf_box_is_not_open");

    const [itemsCount] = await tx
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.putAwayScans)
      .where(eq(schema.putAwayScans.shelfBoxId, shelfBoxId));
    if ((itemsCount?.count ?? 0) === 0) {
      throw new I18nError("cannot_close_empty_shelf_box");
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

export type ShelfBox = Awaited<ReturnType<typeof getShelfBoxesForReceivingOrder>>[number];

export async function getShelfBoxesForReceivingOrder(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string
) {
  const boxes = await db.query.shelfBoxes.findMany({
    where: eq(schema.shelfBoxes.receivingOrderId, receivingOrderId),
    orderBy: (sb, { sql }) => [
      sql`case when ${sb.status} = 'open' then 0 else 1 end`,
      desc(sb.createdAt),
    ],
  });

  if (boxes.length === 0) return [];

  const boxIds = boxes.map((b) => b.id);
  const idList = boxIds.map((id) => `'${id}'`).join(", ");

  const itemsResult = await db.execute(sql`
    SELECT
      pas.shelf_box_id AS shelf_box_id,
      pas.part_id AS part_id,
      p.part_no,
      SUM(pas.qty) AS qty,
      bool_and(pas.verified) AS verified
    FROM put_away_scans pas
    JOIN parts p ON p.id = pas.part_id
    WHERE pas.shelf_box_id IN (${sql.raw(idList)})
    GROUP BY pas.shelf_box_id, pas.part_id, p.part_no
  `);

  const itemsByBox = new Map<
    string,
    { id: string; partId: string; part: { partNo: string | null }; qty: number; verified: boolean }[]
  >();

  for (const row of (itemsResult.rows ?? []) as any[]) {
    const boxId = String(row.shelf_box_id);
    const list = itemsByBox.get(boxId) ?? [];
    list.push({
      id: `${boxId}-${row.part_id}`,
      partId: String(row.part_id),
      part: { partNo: row.part_no as string | null },
      qty: Number(row.qty ?? 0),
      verified: Boolean(row.verified),
    });
    itemsByBox.set(boxId, list);
  }

  return boxes.map((box) => ({
    ...box,
    items: itemsByBox.get(box.id) ?? [],
  }));
}
