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
// ---------------------------------------------------------------------------

export interface MeasuringBoxListRow {
  boxId: string;
  status: string;
  orderNos: string[];
  packageCount: number;
  verifiedCount: number;
  createdDate: Date;
}

/** Open boxes with at least one package (the measuring work list). */
export async function listMeasuringBoxes(db: AppDb): Promise<MeasuringBoxListRow[]> {
  return queryAll<MeasuringBoxListRow>(
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
      GROUP BY sb.id
      ORDER BY sb.created_date DESC, sb.id DESC
    `
  );
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
        pi.part_no AS "partNo", p.wcl_item_no AS "wclItemNo",
        nwf.weight AS "formulaWeight", nwf.qty AS "formulaQty"
      FROM picking_packages pp
      JOIN picking_items pi ON pi.id = pp.picking_item_id
      JOIN parts p ON p.part_no = pi.part_no
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
