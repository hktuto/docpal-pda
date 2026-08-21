// ---------------------------------------------------------------------------
// Printable-label data for the web /print-labels page: every barcode the demo
// flow can ask the operator to scan, in one payload — shelf box ids, shelf
// codes, receiving cartons, and part labels (raw value built per the
// supplier's QR template so the scan gun parses them like real reels).
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm";
import { queryAll, type DbOrTx } from "./query.js";
import { buildKoaLabelRaw } from "./scanParse.js";

export interface LabelPartRow {
  partNo: string;
  /** NULL on receiving items whose line_qty is unknown upstream (print blank). */
  qty: number | null;
  lotCode: string | null;
  dateCode: string | null;
  /** Raw scan value per the supplier QR template; null when unbuildable. */
  qrValue: string | null;
  /** Open picking orders demanding this part (for page filtering). */
  pickingOrderRefs: string[];
}

export interface LabelsData {
  generatedAt: string;
  shelfBoxes: {
    id: string;
    shelfCode: string | null;
    status: string;
    items: { partNo: string; qty: number }[];
  }[];
  shelfCodes: string[];
  receivingOrders: {
    batchNo: string;
    supplierCode: string | null;
    status: string;
    invoices: {
      invoiceNo: string;
      items: (LabelPartRow & {
        id: string;
        ctnNo: string | null;
        poNo: string | null;
        poLine: string | null;
      })[];
    }[];
  }[];
  /** Current shelf stock (boxed lots) — labels for picking from a shelf box. */
  shelfLots: (LabelPartRow & { boxId: string; shelfCode: string | null })[];
  /** One label per open-order allocation — the "pick ticket" with the exact
   *  qty the order takes from that source (a lot/carton split across orders
   *  gets one label per share). */
  pickLabels: (LabelPartRow & {
    orderNo: string;
    /** CTN <ctn_no> / <box> @ <shelf> / <shelf> / "receiving" display hint. */
    source: string;
  })[];
}

/**
 * Aggregate everything the print page needs. Part-label raw values use the
 * KOA layout (the demo suppliers all share it — see seed.ts); items whose
 * supplier has no qr_template get qrValue null and are printed text-only.
 */
export async function getLabelsData(db: DbOrTx): Promise<LabelsData> {
  // part_no → open picking order numbers (for the page's order filter)
  const demandRows = await queryAll<{ partNo: string; orderNo: string }>(
    db,
    sql`SELECT DISTINCT pi.part_no AS "partNo", po.order_no AS "orderNo"
        FROM picking_items pi
        JOIN picking_orders po ON po.id = pi.picking_order_id
        WHERE po.status IN ('pending', 'picking')
        ORDER BY po.order_no`
  );
  const refsByPart = new Map<string, string[]>();
  for (const r of demandRows) {
    refsByPart.set(r.partNo, [...(refsByPart.get(r.partNo) ?? []), r.orderNo]);
  }
  const refs = (partNo: string) => refsByPart.get(partNo) ?? [];

  // supplier_code → has a QR template (demo suppliers all use the KOA layout)
  const templateRows = await queryAll<{ supplierCode: string; hasTemplate: boolean }>(
    db,
    sql`SELECT supplier_code AS "supplierCode", (qr_template IS NOT NULL) AS "hasTemplate"
        FROM supplier_profiles`
  );
  const hasTemplate = new Map(templateRows.map((r) => [r.supplierCode, r.hasTemplate]));

  let serial = 900001;
  const nextSerial = () => String(serial++);
  const partLabel = (
    supplierCode: string | null,
    partNo: string,
    qty: number,
    lotCode: string | null
  ): string | null => {
    if (!supplierCode || !hasTemplate.get(supplierCode)) return null;
    return buildKoaLabelRaw({ partNo, qty, lotCode, serialNo: nextSerial() }) ?? null;
  };

  const boxes = await queryAll<{
    id: string;
    shelfCode: string | null;
    status: string;
    partNo: string | null;
    qty: number | null;
  }>(
    db,
    sql`SELECT sb.id, sb.shelf_code AS "shelfCode", sb.status,
               il.part_no AS "partNo", il.total_qty AS "qty"
        FROM shelf_boxes sb
        LEFT JOIN inventory_lots il ON il.box_id = sb.id AND il.total_qty > 0
        ORDER BY sb.id, il.part_no`
  );
  const shelfBoxes: LabelsData["shelfBoxes"] = [];
  for (const b of boxes) {
    let box = shelfBoxes.find((x) => x.id === b.id);
    if (!box) {
      box = { id: b.id, shelfCode: b.shelfCode, status: b.status, items: [] };
      shelfBoxes.push(box);
    }
    if (b.partNo && b.qty) box.items.push({ partNo: b.partNo, qty: b.qty });
  }

  const shelfCodes = [
    ...new Set(shelfBoxes.map((b) => b.shelfCode).filter((s): s is string => !!s)),
  ].sort();

  const lots = await queryAll<{
    partNo: string;
    qty: number;
    lotCode: string | null;
    dateCode: string | null;
    boxId: string;
    shelfCode: string | null;
    brand: string | null;
  }>(
    db,
    sql`SELECT il.part_no AS "partNo", il.total_qty AS "qty",
               il.lot_code AS "lotCode", il.date_code AS "dateCode",
               il.box_id AS "boxId", il.shelf_code AS "shelfCode",
               p.brand
        FROM inventory_lots il
        LEFT JOIN parts p ON p.part_no = il.part_no
        WHERE il.box_id IS NOT NULL AND il.total_qty > 0
        ORDER BY il.box_id, il.part_no`
  );
  const shelfLots: LabelsData["shelfLots"] = lots.map((l) => ({
    partNo: l.partNo,
    qty: l.qty,
    lotCode: l.lotCode,
    dateCode: l.dateCode,
    boxId: l.boxId,
    shelfCode: l.shelfCode,
    qrValue: partLabel(l.brand, l.partNo, l.qty, l.lotCode),
    pickingOrderRefs: refs(l.partNo),
  }));

  const orders = await queryAll<{
    orderId: string;
    batchNo: string;
    supplierCode: string | null;
    status: string;
    invoiceId: string;
    invoiceNo: string;
    itemId: string;
    partNo: string;
    qty: number | null;
    ctnNo: string | null;
    poNo: string | null;
    poLine: string | null;
    lotCode: string | null;
    dateCode: string | null;
  }>(
    db,
    sql`SELECT ro.id AS "orderId", ro.batch_no AS "batchNo", ro.supplier_code AS "supplierCode",
               ro.status, ri.id AS "invoiceId", ri.invoice_no AS "invoiceNo",
               rii.id AS "itemId", rii.part_no AS "partNo", rii.line_qty AS "qty",
               rii.ctn_no AS "ctnNo", rii.po_no AS "poNo", rii.po_line AS "poLine",
               rii.lot_code AS "lotCode", rii.date_code AS "dateCode"
        FROM receiving_orders ro
        JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
        JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        WHERE ro.status <> 'clear'
        ORDER BY ro.batch_no, ri.invoice_no, rii.ctn_no, rii.po_line, rii.id`
  );
  const receivingOrders: LabelsData["receivingOrders"] = [];
  for (const r of orders) {
    let order = receivingOrders.find((o) => o.batchNo === r.batchNo);
    if (!order) {
      order = { batchNo: r.batchNo, supplierCode: r.supplierCode, status: r.status, invoices: [] };
      receivingOrders.push(order);
    }
    let invoice = order.invoices.find((i) => i.invoiceNo === r.invoiceNo);
    if (!invoice) {
      invoice = { invoiceNo: r.invoiceNo, items: [] };
      order.invoices.push(invoice);
    }
    invoice.items.push({
      id: r.itemId,
      partNo: r.partNo,
      qty: r.qty,
      ctnNo: r.ctnNo,
      poNo: r.poNo,
      poLine: r.poLine,
      lotCode: r.lotCode,
      dateCode: r.dateCode,
      qrValue: r.qty === null ? null : partLabel(r.supplierCode, r.partNo, r.qty, r.lotCode),
      pickingOrderRefs: refs(r.partNo),
    });
  }

  const allocs = await queryAll<{
    orderNo: string;
    partNo: string;
    qty: number;
    lotCode: string | null;
    dateCode: string | null;
    boxId: string | null;
    shelfCode: string | null;
    ctnNo: string | null;
    brand: string | null;
  }>(
    db,
    sql`SELECT po.order_no AS "orderNo", pi.part_no AS "partNo", a.qty,
               COALESCE(il.lot_code, rii.lot_code) AS "lotCode",
               COALESCE(il.date_code, rii.date_code) AS "dateCode",
               il.box_id AS "boxId", il.shelf_code AS "shelfCode",
               rii.ctn_no AS "ctnNo",
               p.brand
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        JOIN picking_orders po ON po.id = pi.picking_order_id
        LEFT JOIN inventory_lots il ON il.id = a.inventory_lot_id
        LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
        LEFT JOIN parts p ON p.wcl_item_no = pi.part_no
        WHERE po.status IN ('pending', 'picking') AND a.qty > 0
        ORDER BY po.priority_seq, po.order_no, pi.line_number NULLS LAST, a.id`
  );
  const pickLabels: LabelsData["pickLabels"] = allocs.map((a) => ({
    orderNo: a.orderNo,
    partNo: a.partNo,
    qty: a.qty,
    lotCode: a.lotCode,
    dateCode: a.dateCode,
    source: a.ctnNo
      ? `CTN ${a.ctnNo}`
      : a.boxId
        ? `${a.boxId}${a.shelfCode ? ` @ ${a.shelfCode}` : ""}`
        : (a.shelfCode ?? "receiving"),
    qrValue: partLabel(a.brand, a.partNo, a.qty, a.lotCode),
    pickingOrderRefs: [a.orderNo],
  }));

  return {
    generatedAt: new Date().toISOString(),
    shelfBoxes,
    shelfCodes,
    receivingOrders,
    shelfLots,
    pickLabels,
  };
}
