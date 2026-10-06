import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet } from "./query.js";

// Per-lot audit history (spec 2026-10-06-admin-audit-trail-enrichment):
// joins the inventory_transactions ledger with lot sources (origin receiving
// lines) and resolves movement references to human-readable orders/boxes so
// the admin stock-search drill-down can answer "where did this lot come from,
// who moved it, where did it go".

export interface LotSummary {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfCode: string | null;
  boxId: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  totalQty: number;
  allocatedQty: number;
  createdDate: Date;
}

export interface LotSourceRow {
  receivingInvoiceItemId: string;
  receivingOrderId: string;
  batchNo: string;
  partNo: string;
  qty: number;
  createdDate: Date;
}

export interface LotMovementRow {
  id: string;
  txnType: string;
  qtyType: string;
  qtyDelta: number;
  shelfCode: string | null;
  boxId: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  referenceType: string | null;
  referenceId: string | null;
  receivingInvoiceItemId: string | null;
  actorId: string | null;
  actorName: string | null;
  txnReason: string | null;
  metadata: Record<string, unknown>;
  txnAt: Date;
  // Reference enrichment (read-side joins; see spec §1).
  pickingOrderId: string | null;
  pickingOrderNo: string | null;
  shippingBoxId: string | null;
  receivingBatchNo: string | null;
}

export interface LotHistory {
  lot: LotSummary;
  sources: LotSourceRow[];
  movements: LotMovementRow[];
}

/** Full audit history for one inventory lot. 404 lot_not_found when the id is
 *  unknown. Movements are oldest-first. Note: ledger rows nulled by a lot
 *  merge are only visible under the surviving lot's id. */
export async function listLotHistory(db: AppDb, lotId: string): Promise<LotHistory> {
  const lot = await queryGet<LotSummary>(
    db,
    sql`SELECT il.id, il.part_no AS "partNo", il.wcl_item_no AS "wclItemNo",
               il.date_code AS "dateCode", il.lot_code AS "lotCode",
               il.coo, il.cow, il.shelf_code AS "shelfCode", il.box_id AS "boxId",
               il.org_id AS "orgId", il.sub_inventory_code AS "subInventoryCode",
               il.total_qty AS "totalQty", il.allocated_qty AS "allocatedQty",
               il.created_date AS "createdDate"
        FROM inventory_lots il WHERE il.id = ${lotId}`
  );
  if (!lot) throw new HTTPException(404, { message: "lot_not_found" });

  const sources = await queryAll<LotSourceRow>(
    db,
    sql`SELECT ils.receiving_invoice_item_id AS "receivingInvoiceItemId",
               ils.qty, ils.created_date AS "createdDate",
               ro.id AS "receivingOrderId", ro.batch_no AS "batchNo",
               rii.part_no AS "partNo"
        FROM inventory_lot_sources ils
        JOIN receiving_invoice_items rii ON rii.id = ils.receiving_invoice_item_id
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
        WHERE ils.inventory_lot_id = ${lotId}
        ORDER BY ils.created_date ASC, ils.id ASC`
  );

  // Reference resolution: picking_item rows join straight to the item;
  // 'allocation' rows (admin/manual/recompute ledger entries) resolve through
  // the allocations table. The destination shipping box comes from
  // picking_packages on the same lot + item (packages may be boxed after the
  // pick, so this is the box they ended up in — answered at read time).
  const movements = await queryAll<LotMovementRow>(
    db,
    sql`SELECT it.id, it.txn_type AS "txnType", it.qty_type AS "qtyType", it.qty_delta AS "qtyDelta",
               it.shelf_code AS "shelfCode", it.box_id AS "boxId",
               it.date_code AS "dateCode", it.lot_code AS "lotCode",
               it.coo, it.cow,
               it.reference_type AS "referenceType", it.reference_id AS "referenceId",
               it.receiving_invoice_item_id AS "receivingInvoiceItemId",
               it.actor_id AS "actorId", u.display_name AS "actorName",
               it.txn_reason AS "txnReason", it.metadata, it.txn_at AS "txnAt",
               pi.picking_order_id AS "pickingOrderId", po.order_no AS "pickingOrderNo",
               pp.shipping_box_id AS "shippingBoxId",
               ro.batch_no AS "receivingBatchNo"
        FROM inventory_transactions it
        LEFT JOIN users u ON u.id = it.actor_id
        LEFT JOIN allocations al ON it.reference_type = 'allocation' AND al.id = it.reference_id
        LEFT JOIN picking_items pi
               ON (it.reference_type = 'picking_item' AND pi.id = it.reference_id)
               OR (it.reference_type = 'allocation' AND pi.id = al.picking_item_id)
        LEFT JOIN picking_orders po ON po.id = pi.picking_order_id
        LEFT JOIN LATERAL (
          SELECT pk.shipping_box_id FROM picking_packages pk
          WHERE pk.picking_item_id = pi.id
            AND pk.source_type = 'inventory_lot'
            AND pk.source_id = it.inventory_lot_id
            AND pk.shipping_box_id IS NOT NULL
          ORDER BY pk.created_date ASC
          LIMIT 1
        ) pp ON pi.id IS NOT NULL
        LEFT JOIN receiving_orders ro ON it.reference_type = 'receiving_order' AND ro.id = it.reference_id
        WHERE it.inventory_lot_id = ${lotId}
        ORDER BY it.txn_at ASC, it.id ASC`
  );

  return { lot, sources, movements };
}
