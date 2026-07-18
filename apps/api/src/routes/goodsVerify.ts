import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { VerifyShelfBoxItemRequest } from "@warehouse/shared";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { queryAll, queryGet, queryRun } from "../db/query.js";
import { verifyShelfBoxItem } from "../db/putAway.js";

export const goodsVerifyRoute = new Hono();

async function readJson<T>(c: Context): Promise<T> {
  try { return await c.req.json<T>(); } catch { throw new HTTPException(400, { message: "invalid JSON body" }); }
}

goodsVerifyRoute.get("/shelves", async (c) => {
  const rows = await queryAll<Record<string, unknown>>(db, sql`SELECT code FROM shelves ORDER BY code`);
  return c.json(rows, 200);
});

goodsVerifyRoute.get("/shelves/with-box-counts", async (c) => {
  const rows = await queryAll<Record<string, unknown>>(db, sql`
    SELECT s.code, COALESCE(COUNT(sb.id)::int, 0) AS box_count
    FROM shelves s
    LEFT JOIN shelf_boxes sb ON sb.shelf_code = s.code
    GROUP BY s.code
    ORDER BY s.code`);
  return c.json(rows, 200);
});

goodsVerifyRoute.get("/shelves/:code/boxes", async (c) => {
  const shelfCode = c.req.param("code");
  const rows = await queryAll<Record<string, unknown>>(db, sql`
    SELECT sb.id, sb.shelf_code, sb.status, sb.created_at,
           COUNT(bi.part_id)::int AS item_count,
           COUNT(CASE WHEN bi.fully_verified = true THEN 1 END)::int AS verified_count,
           lc.last_check_at
    FROM shelf_boxes sb
    LEFT JOIN (
      SELECT sbi.shelf_box_id, sbi.part_id, BOOL_AND(sbi.verified) AS fully_verified
      FROM shelf_box_items sbi
      GROUP BY sbi.shelf_box_id, sbi.part_id
    ) bi ON bi.shelf_box_id = sb.id
    LEFT JOIN (
      SELECT shelf_box_id, MAX(verified_at) AS last_check_at
      FROM shelf_box_items GROUP BY shelf_box_id
    ) lc ON lc.shelf_box_id = sb.id
    WHERE sb.shelf_code = ${shelfCode}
    GROUP BY sb.id, lc.last_check_at
    ORDER BY sb.created_at DESC`);
  const today = new Date().toISOString().slice(0, 10);
  const withChecked = rows.map(({ last_check_at, ...rest }) => {
    const iso = last_check_at instanceof Date ? last_check_at.toISOString() : typeof last_check_at === "string" ? last_check_at : "";
    return { ...rest, last_check_at, checked_today: iso.startsWith(today) };
  });
  return c.json(withChecked, 200);
});

goodsVerifyRoute.get("/shelf-boxes/:id", async (c) => {
  const shelfBoxId = c.req.param("id");
  const box = await queryGet<Record<string, unknown>>(db, sql`
    SELECT sb.id, sb.receiving_order_id, sb.shelf_code, sb.status, sb.created_at,
           s.code AS shelf_code_joined, ro.ref_no AS receiving_order_ref_no
    FROM shelf_boxes sb
    LEFT JOIN shelves s ON s.code = sb.shelf_code
    LEFT JOIN receiving_orders ro ON ro.id = sb.receiving_order_id
    WHERE sb.id = ${shelfBoxId}`);
  if (!box) throw new HTTPException(404, { message: "shelf box not found" });
  const items = await queryAll<Record<string, unknown>>(db, sql`
    SELECT sbi.part_id AS part_id, p.part_no, p.description,
           SUM(sbi.qty)::int AS qty, BOOL_AND(sbi.verified) AS verified,
           MAX(sbi.verified_at) AS verified_at
    FROM shelf_box_items sbi
    JOIN parts p ON p.id = sbi.part_id
    WHERE sbi.shelf_box_id = ${shelfBoxId}
    GROUP BY sbi.part_id, p.part_no, p.description`);
  const { shelf_code_joined, receiving_order_ref_no, ...rest } = box;
  return c.json({
    ...rest,
    shelf: shelf_code_joined ? { code: rest.shelf_code, zone: null } : null,
    receiving_order: receiving_order_ref_no
      ? { id: rest.receiving_order_id, ref_no: receiving_order_ref_no }
      : null,
    items,
  }, 200);
});

goodsVerifyRoute.post("/shelf-boxes/:id/verify-item", async (c) => {
  const shelfBoxId = c.req.param("id");
  const body = await readJson<VerifyShelfBoxItemRequest>(c);
  if (!body.part_id) throw new HTTPException(400, { message: "part_id is required" });
  const result = await db.transaction(async (tx) => {
    return await verifyShelfBoxItem(tx, { shelfBoxId, partId: body.part_id, actorId: body.actor_id ?? null });
  });
  return c.json({ ok: true, verified_count: result.verifiedCount }, 200);
});
