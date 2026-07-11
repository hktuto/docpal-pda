import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { type DbOrTx } from "./invariants.js";
import { now } from "./now.js";
import { logTransition } from "../ingest/transition.js";

interface BoxRow { id: string; pickingOrderId: string; status: string; boxSize: string | null; netWeightG: number | null; grossWeightG: number | null; destinationCountry: string | null }

function loadBox(tx: DbOrTx, boxId: string): BoxRow {
  const box = tx.get<BoxRow>(
    sql`SELECT id, picking_order_id AS pickingOrderId, status, box_size AS boxSize,
               net_weight_g AS netWeightG, gross_weight_g AS grossWeightG, destination_country AS destinationCountry
        FROM shipping_boxes WHERE id = ${boxId}`
  );
  if (!box) throw new HTTPException(404, { message: "shipping box not found" });
  return box;
}

/** undefined = leave unchanged; null = clear; otherwise parsed/trimmed value. */
function parseGrams(v: number | string | null | undefined, field: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HTTPException(400, { message: `${field} must be a non-negative integer (grams)` });
  return n;
}

function cleanText(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function updateShippingBoxMeasurements(
  tx: DbOrTx,
  a: { shippingBoxId: string; fields: { boxSize?: string | null; netWeightG?: number | string | null; grossWeightG?: number | string | null; destinationCountry?: string | null } }
): void {
  const box = loadBox(tx, a.shippingBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  const size = cleanText(a.fields.boxSize);
  const net = parseGrams(a.fields.netWeightG, "net_weight_g");
  const gross = parseGrams(a.fields.grossWeightG, "gross_weight_g");
  const dest = cleanText(a.fields.destinationCountry);
  tx.run(
    sql`UPDATE shipping_boxes SET
          box_size = ${size === undefined ? box.boxSize : size},
          net_weight_g = ${net === undefined ? box.netWeightG : net},
          gross_weight_g = ${gross === undefined ? box.grossWeightG : gross},
          destination_country = ${dest === undefined ? box.destinationCountry : dest},
          updated_at = ${now()}
        WHERE id = ${box.id}`
  );
}

export function verifyPackage(tx: DbOrTx, a: { packageId: string; actorId?: string | null }): void {
  const pkg = tx.get<{ id: string; shippingBoxId: string | null; verified: number; qty: number; pickingOrderId: string }>(
    sql`SELECT pp.id, pp.shipping_box_id AS shippingBoxId, pp.verified, pp.qty, pi.picking_order_id AS pickingOrderId
        FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id WHERE pp.id = ${a.packageId}`
  );
  if (!pkg) throw new HTTPException(404, { message: "package not found" });
  if (pkg.shippingBoxId === null) throw new HTTPException(409, { message: "package is not in a box" });
  const box = loadBox(tx, pkg.shippingBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  const task = tx.get<{ status: string }>(sql`SELECT status FROM measuring_tasks WHERE picking_order_id = ${pkg.pickingOrderId}`);
  if (!task || task.status !== "pending") throw new HTTPException(409, { message: "measuring task is not pending" });
  if (pkg.verified) throw new HTTPException(409, { message: "package already verified" });

  tx.run(sql`UPDATE picking_packages SET verified = 1, updated_at = ${now()} WHERE id = ${pkg.id}`);
  logTransition(tx, { entityType: "picking_package", entityId: pkg.id, fromStatus: "unverified", toStatus: "verified",
    actorId: a.actorId ?? null, note: `qty=${pkg.qty} box=${box.id}` });
}

export function closeShippingBox(tx: DbOrTx, a: { shippingBoxId: string; actorId?: string | null }): void {
  const box = loadBox(tx, a.shippingBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  const pkgs = tx.all<{ id: string; verified: number }>(
    sql`SELECT id, verified FROM picking_packages WHERE shipping_box_id = ${box.id}`
  );
  if (pkgs.length === 0) throw new HTTPException(409, { message: "cannot close an empty box" });
  if (pkgs.some((p) => !p.verified)) throw new HTTPException(409, { message: "all packages must be verified" });

  let dest = box.destinationCountry;
  if (dest === null || dest.trim() === "") {
    const order = tx.get<{ dc: string | null; st: string | null }>(
      sql`SELECT destination_country AS dc, ship_to AS st FROM picking_orders WHERE id = ${box.pickingOrderId}`
    );
    dest = order?.dc && order.dc.trim() !== "" ? order.dc : order?.st ?? null;
  }
  if (dest === null || dest.trim() === "") throw new HTTPException(409, { message: "destination is required" });
  if (box.boxSize === null || box.boxSize.trim() === "") throw new HTTPException(409, { message: "box_size is required" });
  if (box.netWeightG === null || box.grossWeightG === null) throw new HTTPException(409, { message: "weights are required" });
  if (box.netWeightG <= 0 || box.grossWeightG <= 0) throw new HTTPException(409, { message: "weights must be greater than zero" });
  if (box.grossWeightG < box.netWeightG) throw new HTTPException(409, { message: "gross weight must be >= net weight" });

  tx.run(sql`UPDATE shipping_boxes SET status = 'closed', destination_country = ${dest}, updated_at = ${now()} WHERE id = ${box.id}`);
  logTransition(tx, { entityType: "shipping_box", entityId: box.id, fromStatus: "open", toStatus: "closed", actorId: a.actorId ?? null });
}
