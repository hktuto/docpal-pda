import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet } from "./query.js";

// Per-part ledger for the admin item-ledger page ("item angel" view): the
// part's current stock lots + totals and its full in/out movement history,
// matched exactly by part_no OR wcl_item_no. Only dock + on_hand rows are
// real item movements — reserved/expected ledger churn (allocation engine) is
// excluded. Reference resolution mirrors lotHistory.ts: picking_item rows
// join straight to the item, 'allocation' rows resolve through allocations,
// and the receiving batch comes from the receiving_order reference or, for
// rows that only carry receiving_invoice_item_id (e.g. the PUT_AWAY pair),
// through the invoice item's order.

export interface PartLedgerPart {
  partNo: string;
  wclItemNo: string;
  description: string | null;
  brand: string;
}

export interface PartLedgerStockRow {
  lotId: string;
  orgId: number | null;
  subInventoryCode: string | null;
  shelfCode: string | null;
  shelfDisplayName: string | null;
  boxId: string | null;
  partNo: string;
  wclItemNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
}

export interface PartLedgerTotals {
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
}

export interface PartLedgerTransaction {
  id: string;
  txnType: string;
  qtyType: string;
  qtyDelta: number;
  shelfCode: string | null;
  shelfDisplayName: string | null;
  boxId: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  referenceType: string | null;
  referenceId: string | null;
  actorName: string | null;
  txnReason: string | null;
  txnAt: Date;
  pickingOrderId: string | null;
  pickingOrderNo: string | null;
  receivingOrderId: string | null;
  receivingBatchNo: string | null;
}

export interface PartLedger {
  part: PartLedgerPart | null;
  stock: PartLedgerStockRow[];
  totals: PartLedgerTotals;
  /** Newest first, capped at 1000 rows. */
  transactions: PartLedgerTransaction[];
}

const TXN_LIMIT = 1000;

export async function getPartLedger(db: AppDb, partNo: string, wclItemNo: string): Promise<PartLedger> {
  if (partNo === "" && wclItemNo === "") throw new HTTPException(400, { message: "part_no_required" });

  const part =
    (await queryGet<PartLedgerPart>(
    db,
    sql`SELECT p.part_no AS "partNo", p.wcl_item_no AS "wclItemNo", p.description, p.brand
        FROM parts p
        WHERE (${wclItemNo} <> '' AND p.wcl_item_no = ${wclItemNo})
           OR (${partNo} <> '' AND p.part_no = ${partNo})
        ORDER BY CASE WHEN ${wclItemNo} <> '' AND p.wcl_item_no = ${wclItemNo} THEN 0 ELSE 1 END
        LIMIT 1`
    )) ?? null;

  const stock = await queryAll<PartLedgerStockRow>(
    db,
    sql`SELECT il.id AS "lotId", il.org_id AS "orgId", il.sub_inventory_code AS "subInventoryCode",
               il.shelf_code AS "shelfCode", s.display_name AS "shelfDisplayName", il.box_id AS "boxId",
               il.part_no AS "partNo", il.wcl_item_no AS "wclItemNo",
               il.date_code AS "dateCode", il.lot_code AS "lotCode", il.coo, il.cow,
               il.total_qty AS "totalQty", il.allocated_qty AS "allocatedQty", il.available_qty AS "availableQty"
        FROM inventory_lots il
        LEFT JOIN shelves s ON s.code = il.shelf_code
        WHERE (${partNo} <> '' AND il.part_no = ${partNo})
           OR (${wclItemNo} <> '' AND il.wcl_item_no = ${wclItemNo})
        ORDER BY il.date_code NULLS LAST, il.shelf_code, il.box_id`
  );

  const totals: PartLedgerTotals = { totalQty: 0, allocatedQty: 0, availableQty: 0 };
  for (const row of stock) {
    totals.totalQty += row.totalQty;
    totals.allocatedQty += row.allocatedQty;
    totals.availableQty += row.availableQty;
  }

  const transactions = await queryAll<PartLedgerTransaction>(
    db,
    sql`SELECT it.id, it.txn_type AS "txnType", it.qty_type AS "qtyType", it.qty_delta AS "qtyDelta",
               it.shelf_code AS "shelfCode", s.display_name AS "shelfDisplayName", it.box_id AS "boxId",
               it.date_code AS "dateCode", it.lot_code AS "lotCode", it.coo, it.cow,
               it.reference_type AS "referenceType", it.reference_id AS "referenceId",
               u.display_name AS "actorName", it.txn_reason AS "txnReason", it.txn_at AS "txnAt",
               po.id AS "pickingOrderId", po.order_no AS "pickingOrderNo",
               COALESCE(ro_ref.id, ro_item.id) AS "receivingOrderId",
               COALESCE(ro_ref.batch_no, ro_item.batch_no) AS "receivingBatchNo"
        FROM inventory_transactions it
        LEFT JOIN users u ON u.id = it.actor_id
        LEFT JOIN shelves s ON s.code = it.shelf_code
        LEFT JOIN allocations al ON it.reference_type = 'allocation' AND al.id = it.reference_id
        LEFT JOIN picking_items pi
               ON (it.reference_type = 'picking_item' AND pi.id = it.reference_id)
               OR (it.reference_type = 'allocation' AND pi.id = al.picking_item_id)
        LEFT JOIN picking_orders po ON po.id = pi.picking_order_id
        LEFT JOIN receiving_orders ro_ref ON it.reference_type = 'receiving_order' AND ro_ref.id = it.reference_id
        LEFT JOIN receiving_invoice_items rii ON rii.id = it.receiving_invoice_item_id
        LEFT JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        LEFT JOIN receiving_orders ro_item ON ro_item.id = ri.receiving_order_id
        WHERE it.qty_type IN ('dock', 'on_hand')
          AND ((${partNo} <> '' AND it.part_no = ${partNo})
               OR (${wclItemNo} <> '' AND it.part_no IN (SELECT p.part_no FROM parts p WHERE p.wcl_item_no = ${wclItemNo})))
        ORDER BY it.txn_at DESC, it.id DESC
        LIMIT ${TXN_LIMIT}`
  );

  return { part, stock, totals, transactions };
}
