import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { type DbOrTx } from "./invariants.js";
import { queryAll, queryGet, queryRun } from "./query.js";
import { now } from "./now.js";
import { logTransition } from "../ingest/transition.js";

interface BoxRow { id: string; pickingOrderId: string; status: string; boxSize: string | null; netWeightG: number | null; grossWeightG: number | null; destinationCountry: string | null }

async function loadBox(tx: DbOrTx, boxId: string): Promise<BoxRow> {
  const box = await queryGet<BoxRow>(
    tx,
    sql`SELECT id, picking_order_id AS "pickingOrderId", status, box_size AS "boxSize",
               net_weight_g AS "netWeightG", gross_weight_g AS "grossWeightG", destination_country AS "destinationCountry"
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

export async function updateShippingBoxMeasurements(
  tx: DbOrTx,
  a: { shippingBoxId: string; fields: { boxSize?: string | null; netWeightG?: number | string | null; grossWeightG?: number | string | null; destinationCountry?: string | null } }
): Promise<void> {
  const box = await loadBox(tx, a.shippingBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  const size = cleanText(a.fields.boxSize);
  const net = parseGrams(a.fields.netWeightG, "net_weight_g");
  const gross = parseGrams(a.fields.grossWeightG, "gross_weight_g");
  const dest = cleanText(a.fields.destinationCountry);
  await queryRun(
    tx,
    sql`UPDATE shipping_boxes SET
          box_size = ${size === undefined ? box.boxSize : size},
          net_weight_g = ${net === undefined ? box.netWeightG : net},
          gross_weight_g = ${gross === undefined ? box.grossWeightG : gross},
          destination_country = ${dest === undefined ? box.destinationCountry : dest},
          updated_at = ${now()}
        WHERE id = ${box.id}`
  );
}

export async function verifyPackage(tx: DbOrTx, a: { packageId: string; actorId?: string | null }): Promise<void> {
  const pkg = await queryGet<{ id: string; shippingBoxId: string | null; verified: boolean; qty: number; pickingOrderId: string }>(
    tx,
    sql`SELECT pp.id, pp.shipping_box_id AS "shippingBoxId", pp.verified, pp.qty, pi.picking_order_id AS "pickingOrderId"
        FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id WHERE pp.id = ${a.packageId}`
  );
  if (!pkg) throw new HTTPException(404, { message: "package not found" });
  if (pkg.shippingBoxId === null) throw new HTTPException(409, { message: "package is not in a box" });
  const box = await loadBox(tx, pkg.shippingBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  const task = await queryGet<{ status: string }>(tx, sql`SELECT status FROM measuring_tasks WHERE picking_order_id = ${pkg.pickingOrderId}`);
  if (!task || task.status !== "pending") throw new HTTPException(409, { message: "measuring task is not pending" });
  if (pkg.verified) throw new HTTPException(409, { message: "package already verified" });

  await queryRun(tx, sql`UPDATE picking_packages SET verified = true, updated_at = ${now()} WHERE id = ${pkg.id}`);
  await logTransition(tx, { entityType: "picking_package", entityId: pkg.id, fromState: "unverified", toState: "verified",
    actorId: a.actorId ?? null, metadata: { qty: pkg.qty, box: box.id } });
}

export async function closeShippingBox(tx: DbOrTx, a: { shippingBoxId: string; actorId?: string | null }): Promise<void> {
  const box = await loadBox(tx, a.shippingBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  const pkgs = await queryAll<{ id: string; verified: boolean }>(
    tx,
    sql`SELECT id, verified FROM picking_packages WHERE shipping_box_id = ${box.id}`
  );
  if (pkgs.length === 0) throw new HTTPException(409, { message: "cannot close an empty box" });
  if (pkgs.some((p) => !p.verified)) throw new HTTPException(409, { message: "all packages must be verified" });

  let dest = box.destinationCountry;
  if (dest === null || dest.trim() === "") {
    const order = await queryGet<{ dc: string | null; st: string | null }>(
      tx,
      sql`SELECT destination_country AS dc, ship_to AS st FROM picking_orders WHERE id = ${box.pickingOrderId}`
    );
    dest = order?.dc && order.dc.trim() !== "" ? order.dc : order?.st ?? null;
  }
  if (dest === null || dest.trim() === "") throw new HTTPException(409, { message: "destination is required" });
  if (box.boxSize === null || box.boxSize.trim() === "") throw new HTTPException(409, { message: "box_size is required" });
  if (box.netWeightG === null || box.grossWeightG === null) throw new HTTPException(409, { message: "weights are required" });
  if (box.netWeightG <= 0 || box.grossWeightG <= 0) throw new HTTPException(409, { message: "weights must be greater than zero" });
  if (box.grossWeightG < box.netWeightG) throw new HTTPException(409, { message: "gross weight must be >= net weight" });

  await queryRun(tx, sql`UPDATE shipping_boxes SET status = 'closed', destination_country = ${dest}, updated_at = ${now()} WHERE id = ${box.id}`);
  await logTransition(tx, { entityType: "shipping_box", entityId: box.id, fromState: "open", toState: "closed", actorId: a.actorId ?? null });
}

export async function completeMeasuringTask(tx: DbOrTx, a: { measuringTaskId: string; actorId?: string | null }): Promise<void> {
  const task = await queryGet<{ id: string; pickingOrderId: string; status: string }>(
    tx,
    sql`SELECT id, picking_order_id AS "pickingOrderId", status FROM measuring_tasks WHERE id = ${a.measuringTaskId}`
  );
  if (!task) throw new HTTPException(404, { message: "measuring task not found" });
  if (task.status !== "pending") throw new HTTPException(409, { message: "measuring task is not pending" });

  const openBox = await queryGet<{ id: string }>(
    tx,
    sql`SELECT id FROM shipping_boxes WHERE picking_order_id = ${task.pickingOrderId} AND status != 'closed' LIMIT 1`
  );
  if (openBox) throw new HTTPException(409, { message: "all shipping boxes must be closed" });

  const perItem = await queryAll<{ picked: number; packed: number }>(
    tx,
    sql`SELECT pi.picked_qty AS picked,
               COALESCE((SELECT SUM(pp.qty)::int FROM picking_packages pp
                         WHERE pp.picking_item_id = pi.id AND pp.shipping_box_id IS NOT NULL), 0) AS packed
        FROM picking_items pi WHERE pi.picking_order_id = ${task.pickingOrderId}`
  );
  if (perItem.some((r) => r.packed !== r.picked)) throw new HTTPException(409, { message: "picking item not fully packed" });

  await queryRun(tx, sql`UPDATE measuring_tasks SET status = 'completed' WHERE id = ${task.id}`);
  await logTransition(tx, { entityType: "measuring_task", entityId: task.id, fromState: "pending", toState: "completed", actorId: a.actorId ?? null });
}

export async function verifyShippingBox(tx: DbOrTx, a: { shippingBoxId: string; actorId?: string | null }): Promise<void> {
  const box = await loadBox(tx, a.shippingBoxId);
  if (box.status !== "closed") throw new HTTPException(409, { message: "box is not closed" });
  const unverified = (await queryGet<{ c: number }>(
    tx,
    sql`SELECT COUNT(*)::int AS c FROM picking_packages WHERE shipping_box_id = ${box.id} AND verified = false`
  ))!;
  if (unverified.c > 0) throw new HTTPException(409, { message: "all packages must be verified" });

  await queryRun(tx, sql`UPDATE shipping_boxes SET status = 'verified', updated_at = ${now()} WHERE id = ${box.id}`);
  await logTransition(tx, { entityType: "shipping_box", entityId: box.id, fromState: "closed", toState: "verified", actorId: a.actorId ?? null });
}
