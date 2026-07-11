import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { type DbOrTx } from "./invariants.js";
import { now } from "./now.js";
import { logTransition } from "../ingest/transition.js";

interface ShelfBoxRow { id: string; receivingOrderId: string | null; shelfCode: string; status: string }

function loadShelfBox(tx: DbOrTx, boxId: string): ShelfBoxRow {
  const box = tx.get<ShelfBoxRow>(
    sql`SELECT id, receiving_order_id AS receivingOrderId, shelf_code AS shelfCode, status FROM shelf_boxes WHERE id = ${boxId}`
  );
  if (!box) throw new HTTPException(404, { message: "shelf box not found" });
  return box;
}

function nextShelfBoxId(tx: DbOrTx): string {
  const rows = tx.all<{ id: string }>(sql`SELECT id FROM shelf_boxes WHERE id LIKE 'SBOX-%'`);
  let max = 0;
  for (const r of rows) { const n = Number(r.id.slice(5)); if (Number.isInteger(n) && n > max) max = n; }
  return `SBOX-${String(max + 1).padStart(4, "0")}`;
}

export function createShelfBox(tx: DbOrTx, a: { receivingOrderId: string; shelfCode: string; actorId?: string | null }): { id: string } {
  const order = tx.get<{ id: string }>(sql`SELECT id FROM receiving_orders WHERE id = ${a.receivingOrderId}`);
  if (!order) throw new HTTPException(404, { message: "receiving order not found" });
  const shelf = tx.get<{ code: string }>(sql`SELECT code FROM shelves WHERE code = ${a.shelfCode}`);
  if (!shelf) throw new HTTPException(404, { message: "shelf not found" });
  const id = nextShelfBoxId(tx);
  tx.run(
    sql`INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at, updated_at)
        VALUES (${id}, ${a.receivingOrderId}, ${a.shelfCode}, 'open', ${now()}, ${now()})`
  );
  logTransition(tx, { entityType: "shelf_box", entityId: id, toStatus: "open", actorId: a.actorId ?? null, note: `order=${a.receivingOrderId} shelf=${a.shelfCode}` });
  return { id };
}

export function cancelShelfBox(tx: DbOrTx, a: { shelfBoxId: string; actorId?: string | null }): void {
  const box = loadShelfBox(tx, a.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  const cnt = tx.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM put_away_scans WHERE shelf_box_id = ${box.id}`)!.c;
  if (cnt > 0) throw new HTTPException(409, { message: "shelf box is not empty" });
  logTransition(tx, { entityType: "shelf_box", entityId: box.id, fromStatus: "open", toStatus: "cancelled", actorId: a.actorId ?? null });
  tx.run(sql`DELETE FROM shelf_boxes WHERE id = ${box.id}`);
}
