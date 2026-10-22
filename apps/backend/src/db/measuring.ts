import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet } from "./query.js";

// ---------------------------------------------------------------------------
// Measuring reads (box-scoped, 2026-08-11 design). measuring_tasks is gone:
// closing a box IS the measuring completion. The measuring page therefore
// lists OPEN shipping boxes that contain packages; box measurement itself
// reuses the picking routes (PATCH /shipping-boxes/:id weights/size,
// POST /packages/:id/verify, POST /shipping-boxes/:id/close). A box may hold
// packages from several picking orders (cross-order packing) — order numbers
// are aggregated per box.
// 2026-10-20: the work list is a POST-PICKING queue — a box appears only once
// every picking order it holds packages for is picking-complete (the order's
// explicit Finish → status picking_finished/measuring_finished/shipped), and
// the response is grouped by picking order (a cross-order box appears under
// each of its orders).
// ---------------------------------------------------------------------------

export interface MeasuringBoxListRow {
  boxId: string;
  status: string;
  orderNos: string[];
  packageCount: number;
  verifiedCount: number;
  createdDate: Date;
}

export interface MeasuringOrderGroup {
  orderId: string;
  orderNo: string;
  boxes: MeasuringBoxListRow[];
}

/** Open boxes with at least one package whose orders are all picking-complete,
 *  grouped by picking order. */
export async function listMeasuringBoxes(db: AppDb): Promise<MeasuringOrderGroup[]> {
  const boxes = await queryAll<MeasuringBoxListRow>(
    db,
    sql`
      SELECT
        sb.id AS "boxId", sb.status,
        COALESCE(array_agg(DISTINCT po.order_no) FILTER (WHERE po.order_no IS NOT NULL), '{}') AS "orderNos",
        COUNT(pp.id)::int AS "packageCount",
        COUNT(pp.id) FILTER (WHERE pp.verified)::int AS "verifiedCount",
        sb.created_date AS "createdDate"
      FROM shipping_boxes sb
      JOIN picking_packages pp ON pp.shipping_box_id = sb.id
      JOIN picking_items pi ON pi.id = pp.picking_item_id
      JOIN picking_orders po ON po.id = pi.picking_order_id
      WHERE sb.status = 'open'
        AND NOT EXISTS (
          SELECT 1
          FROM picking_packages pp2
          JOIN picking_items pi2 ON pi2.id = pp2.picking_item_id
          JOIN picking_orders po2 ON po2.id = pi2.picking_order_id
          WHERE pp2.shipping_box_id = sb.id
            AND po2.status NOT IN ('picking_finished', 'measuring_finished', 'shipped')
        )
      GROUP BY sb.id
      ORDER BY sb.created_date DESC, sb.id DESC
    `
  );
  if (boxes.length === 0) return [];

  const memberships = await queryAll<{ orderId: string; orderNo: string; boxId: string }>(
    db,
    sql`
      SELECT DISTINCT po.id AS "orderId", po.order_no AS "orderNo", pp.shipping_box_id AS "boxId"
      FROM picking_packages pp
      JOIN picking_items pi ON pi.id = pp.picking_item_id
      JOIN picking_orders po ON po.id = pi.picking_order_id
      WHERE pp.shipping_box_id = ANY(ARRAY[${sql.join(boxes.map((b) => sql`${b.boxId}`), sql`, `)}])
      ORDER BY po.order_no
    `
  );

  const byBoxId = new Map(boxes.map((b) => [b.boxId, b]));
  const groups = new Map<string, MeasuringOrderGroup>();
  for (const m of memberships) {
    const box = byBoxId.get(m.boxId);
    if (!box) continue;
    const group = groups.get(m.orderId) ?? { orderId: m.orderId, orderNo: m.orderNo, boxes: [] };
    group.boxes.push(box);
    groups.set(m.orderId, group);
  }
  // Newest work first: groups by their latest box, then by order no.
  return [...groups.values()].sort((a, b) => {
    const latest = (g: MeasuringOrderGroup) =>
      Math.max(...g.boxes.map((box) => new Date(box.createdDate).getTime()));
    return latest(b) - latest(a) || a.orderNo.localeCompare(b.orderNo);
  });
}

export interface MeasuringPackageRow {
  id: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  verified: boolean;
  verifyVerified: boolean;
  /** Re-scan credit (mode-agnostic): completion when rescannedQty >= qty. */
  rescannedQty: number;
  /** Raw scan string of the source label (traceability/display only). */
  labelBarcode: string | null;
  /** Pick-time scanned batch fields (2026-10-14) — the re-scan comparison
   *  anchor; NULL on legacy rows → consumers fall back to the source snapshot
   *  (dateCode/lotCode/coo/cow above). */
  scannedDateCode: string | null;
  scannedLotCode: string | null;
  scannedCoo: string | null;
  scannedCow: string | null;
  partNo: string;
  wclItemNo: string | null;
}

export interface MeasuringBoxDetail {
  boxId: string;
  pickingOrderId: string | null;
  status: string;
  boxSize: string | null;
  grossWeight: number | null;
  netWeight: number | null;
  destinationCountry: string | null;
  shippedAt: Date | null;
  createdDate: Date;
  suggestedNetWeightKg: number | null;
  packages: MeasuringPackageRow[];
}

/** Box + packages with part identity + the formula-driven suggested net weight. */
export async function getMeasuringBoxDetail(db: AppDb, boxId: string): Promise<MeasuringBoxDetail> {
  const box = await queryGet<Omit<MeasuringBoxDetail, "packages" | "suggestedNetWeightKg">>(
    db,
    sql`SELECT id AS "boxId", picking_order_id AS "pickingOrderId", status,
               box_size AS "boxSize", gross_weight AS "grossWeight", net_weight AS "netWeight",
               destination_country AS "destinationCountry",
               shipped_at AS "shippedAt", created_date AS "createdDate"
        FROM shipping_boxes WHERE id = ${boxId}`
  );
  if (!box) throw new HTTPException(404, { message: "shipping_box_not_found" });

  const packages = await queryAll<MeasuringPackageRow & { formulaWeight: number | null; formulaQty: number | null }>(
    db,
    sql`
      SELECT
        pp.id, pp.qty,
        pp.date_code AS "dateCode", pp.lot_code AS "lotCode", pp.coo, pp.cow, pp.verified,
        pp.verify_verified AS "verifyVerified",
        pp.rescanned_qty AS "rescannedQty",
        pp.label_barcode AS "labelBarcode",
        pp.scanned_date_code AS "scannedDateCode", pp.scanned_lot_code AS "scannedLotCode",
        pp.scanned_coo AS "scannedCoo", pp.scanned_cow AS "scannedCow",
        COALESCE(pp.scanned_part_no, pi.part_no) AS "partNo",
        COALESCE(pp.scanned_wcl_item_no, p.wcl_item_no) AS "wclItemNo",
        nwf.weight AS "formulaWeight", nwf.qty AS "formulaQty"
      FROM picking_packages pp
      JOIN picking_items pi ON pi.id = pp.picking_item_id
      JOIN parts p ON p.wcl_item_no = pi.part_no
      LEFT JOIN net_weight_formula nwf ON nwf.part_no = pi.part_no
      WHERE pp.shipping_box_id = ${boxId}
      ORDER BY pp.created_date, pp.id
    `
  );

  return {
    ...box,
    suggestedNetWeightKg: suggestedNetWeightKg(packages),
    packages: packages.map(({ formulaWeight: _fw, formulaQty: _fq, ...rest }) => rest),
  };
}

/**
 * Suggested net weight from the net_weight_formula master: Σ over the box's
 * packages of (formula.weight / formula.qty) × pkg.qty grams, converted to kg
 * and rounded to 3 dp. Parts without a formula row contribute 0; null when no
 * package has a formula at all.
 */
function suggestedNetWeightKg(
  packages: { qty: number; formulaWeight: number | null; formulaQty: number | null }[]
): number | null {
  let grams = 0;
  let any = false;
  for (const p of packages) {
    if (p.formulaWeight === null || p.formulaQty === null) continue;
    any = true;
    grams += (p.formulaWeight / p.formulaQty) * p.qty;
  }
  if (!any) return null;
  return Math.round((grams / 1000) * 1000) / 1000;
}
