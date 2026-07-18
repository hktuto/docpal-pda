import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db/invariants.js";
import { now } from "../db/now.js";
import { queryAll, queryGet, queryRun } from "../db/query.js";
import { resolveOrCreatePart } from "./parts.js";
import type { PickingPutBody } from "@warehouse/shared";

export interface PickingUpsertResult { orderId: string; created: boolean; changed: boolean; }

function validate(body: PickingPutBody): void {
  if (!body?.order?.ref_no) throw new HTTPException(400, { message: "order.ref_no is required" });
  if (!Array.isArray(body.items) || body.items.length === 0)
    throw new HTTPException(400, { message: "items[] is required" });
  for (const it of body.items) {
    if (!it.line_id) throw new HTTPException(400, { message: "line_id is required" });
    if (!it.part_no) throw new HTTPException(400, { message: "part_no is required" });
    if (!Number.isInteger(it.qty) || it.qty < 0) throw new HTTPException(400, { message: "qty must be a non-negative integer" });
  }
}

interface ExistingPickingItem {
  id: string; lineId: string; partId: string; qty: number; pickedQty: number;
  scannedNotBoxedQty: number; requiredDateCode: string | null; sourceShelfCode: string | null; allocCount: number;
}

async function loadExisting(tx: DbOrTx, orderId: string): Promise<ExistingPickingItem[]> {
  return queryAll<ExistingPickingItem>(tx, sql`
    SELECT pi.id, pi.line_id AS "lineId", pi.part_id AS "partId", pi.qty, pi.picked_qty AS "pickedQty",
           pi.scanned_not_boxed_qty AS "scannedNotBoxedQty", pi.required_date_code AS "requiredDateCode",
           pi.source_shelf_code AS "sourceShelfCode",
           (SELECT COUNT(*)::int FROM allocations a WHERE a.picking_item_id = pi.id) AS "allocCount"
    FROM picking_items pi WHERE pi.picking_order_id = ${orderId}`);
}

export async function upsertPickingOrder(tx: DbOrTx, externalId: string, body: PickingPutBody): Promise<PickingUpsertResult> {
  validate(body);
  const existing = await queryGet<{ id: string; status: string }>(
    tx,
    sql`SELECT id, status FROM picking_orders WHERE external_id = ${externalId}`
  );

  if (!existing) {
    const orderId = crypto.randomUUID();
    await queryRun(
      tx,
      sql`INSERT INTO picking_orders (id, external_id, ref_no, status, ship_to, destination_country, created_at, updated_at)
          VALUES (${orderId}, ${externalId}, ${body.order.ref_no}, 'pending', ${body.order.ship_to ?? null},
                  ${body.order.destination_country ?? null}, ${now()}, ${now()})`
    );
    for (const it of body.items) {
      const partId = await resolveOrCreatePart(tx, it.part_no);
      await queryRun(
        tx,
        sql`INSERT INTO picking_items (id, picking_order_id, part_id, qty, required_date_code, source_shelf_code, line_id, created_at, updated_at)
            VALUES (${crypto.randomUUID()}, ${orderId}, ${partId}, ${it.qty}, ${it.required_date_code ?? null},
                    ${it.source_shelf_code ?? null}, ${it.line_id}, ${now()}, ${now()})`
      );
    }
    return { orderId, created: true, changed: true };
  }

  let changed = false;
  const po = (await queryGet<{ refNo: string; shipTo: string | null; dest: string | null }>(
    tx,
    sql`SELECT ref_no AS "refNo", ship_to AS "shipTo", destination_country AS dest FROM picking_orders WHERE id = ${existing.id}`
  ))!;
  const shipTo = body.order.ship_to ?? null;
  const dest = body.order.destination_country ?? null;
  if (po.refNo !== body.order.ref_no || po.shipTo !== shipTo || po.dest !== dest) {
    await queryRun(tx, sql`UPDATE picking_orders SET ref_no = ${body.order.ref_no}, ship_to = ${shipTo},
                   destination_country = ${dest}, updated_at = ${now()} WHERE id = ${existing.id}`);
    changed = true;
  }

  const existingItems = await loadExisting(tx, existing.id);
  const seen = new Set<string>();

  for (const it of body.items) {
    seen.add(it.line_id);
    const partId = await resolveOrCreatePart(tx, it.part_no);
    const ex = existingItems.find((e) => e.lineId === it.line_id);

    if (!ex) {
      await queryRun(
        tx,
        sql`INSERT INTO picking_items (id, picking_order_id, part_id, qty, required_date_code, source_shelf_code, line_id, created_at, updated_at)
            VALUES (${crypto.randomUUID()}, ${existing.id}, ${partId}, ${it.qty}, ${it.required_date_code ?? null},
                    ${it.source_shelf_code ?? null}, ${it.line_id}, ${now()}, ${now()})`
      );
      changed = true;
      continue;
    }

    if (it.qty < ex.qty) {
      const floor = ex.pickedQty + ex.scannedNotBoxedQty;
      if (it.qty < floor)
        throw new HTTPException(409, { message: `line ${it.line_id}: qty ${it.qty} below picked+scanned ${floor}` });
    }
    const reqDc = it.required_date_code ?? null;
    const srcShelf = it.source_shelf_code ?? null;
    const same = ex.partId === partId && ex.qty === it.qty && ex.requiredDateCode === reqDc && ex.sourceShelfCode === srcShelf;
    if (!same) {
      await queryRun(
        tx,
        sql`UPDATE picking_items SET part_id = ${partId}, qty = ${it.qty}, required_date_code = ${reqDc},
            source_shelf_code = ${srcShelf}, updated_at = ${now()} WHERE id = ${ex.id}`
      );
      changed = true;
    }
  }

  for (const ex of existingItems) {
    if (seen.has(ex.lineId)) continue;
    if (ex.allocCount > 0 || ex.scannedNotBoxedQty > 0 || ex.pickedQty > 0)
      throw new HTTPException(409, { message: `line ${ex.lineId}: cannot remove after work started` });
    await queryRun(tx, sql`DELETE FROM picking_items WHERE id = ${ex.id}`);
    changed = true;
  }

  if (changed) await queryRun(tx, sql`UPDATE picking_orders SET updated_at = ${now()} WHERE id = ${existing.id}`);
  return { orderId: existing.id, created: false, changed };
}
