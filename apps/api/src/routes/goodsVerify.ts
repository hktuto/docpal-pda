import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import type { VerifyShelfBoxItemRequest } from "@warehouse/shared";
import { db } from "../db.js";
import { verifyShelfBoxItem } from "../db/putAway.js";

export const goodsVerifyRoute = new Hono();

async function readJson<T>(c: Context): Promise<T> {
  try { return await c.req.json<T>(); } catch { throw new HTTPException(400, { message: "invalid JSON body" }); }
}

// Note: the API `shelves` table has no `zone` column (unlike the web app), so
// shelf responses expose `code` only (zone: null where a nested shelf object is built).
goodsVerifyRoute.get("/shelves", (c) => {
  const rows = db.all<Record<string, unknown>>(sql`SELECT code FROM shelves ORDER BY code`);
  return c.json(rows, 200);
});

// Static segment registered before "/shelves/:code/boxes" (different path depth
// anyway, but keep the explicit routes ahead of the parameterized one).
goodsVerifyRoute.get("/shelves/with-box-counts", (c) => {
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT s.code, COALESCE(COUNT(sb.id), 0) AS box_count
    FROM shelves s
    LEFT JOIN shelf_boxes sb ON sb.shelf_code = s.code
    GROUP BY s.code
    ORDER BY s.code`);
  return c.json(rows, 200);
});

goodsVerifyRoute.get("/shelves/:code/boxes", (c) => {
  const shelfCode = c.req.param("code");
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT sb.id, sb.shelf_code, sb.status, sb.created_at,
           COUNT(bi.part_id) AS item_count,
           COUNT(CASE WHEN bi.fully_verified = 1 THEN 1 END) AS verified_count,
           lc.last_check_at
    FROM shelf_boxes sb
    LEFT JOIN (
      SELECT pas.shelf_box_id, rii.part_id, MIN(pas.verified) AS fully_verified
      FROM put_away_scans pas
      JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
      GROUP BY pas.shelf_box_id, rii.part_id
    ) bi ON bi.shelf_box_id = sb.id
    LEFT JOIN (
      SELECT shelf_box_id, MAX(verified_at) AS last_check_at
      FROM put_away_scans GROUP BY shelf_box_id
    ) lc ON lc.shelf_box_id = sb.id
    WHERE sb.shelf_code = ${shelfCode}
    GROUP BY sb.id
    ORDER BY sb.created_at DESC`);
  // checked_today compares against the server's UTC date (ISO date prefix).
  const today = new Date().toISOString().slice(0, 10);
  const withChecked = rows.map(({ last_check_at, ...rest }) => ({
    ...rest,
    last_check_at,
    checked_today: typeof last_check_at === "string" && last_check_at.startsWith(today),
  }));
  return c.json(withChecked, 200);
});

goodsVerifyRoute.get("/shelf-boxes/:id", (c) => {
  const shelfBoxId = c.req.param("id");
  const box = db.get<Record<string, unknown>>(sql`
    SELECT sb.id, sb.receiving_order_id, sb.shelf_code, sb.status, sb.created_at,
           s.code AS shelf_code_joined, ro.ref_no AS receiving_order_ref_no
    FROM shelf_boxes sb
    LEFT JOIN shelves s ON s.code = sb.shelf_code
    LEFT JOIN receiving_orders ro ON ro.id = sb.receiving_order_id
    WHERE sb.id = ${shelfBoxId}`);
  if (!box) throw new HTTPException(404, { message: "shelf box not found" });
  const items = db.all<Record<string, unknown>>(sql`
    SELECT rii.part_id AS part_id, p.part_no, p.description,
           SUM(pas.qty) AS qty, MIN(pas.verified) AS verified,
           MAX(pas.verified_at) AS verified_at
    FROM put_away_scans pas
    JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
    JOIN parts p ON p.id = rii.part_id
    WHERE pas.shelf_box_id = ${shelfBoxId}
    GROUP BY rii.part_id, p.part_no, p.description`);
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
  const result = db.transaction((tx) => verifyShelfBoxItem(tx, { shelfBoxId, partId: body.part_id, actorId: body.actor_id ?? null }));
  return c.json({ ok: true, verified_count: result.verifiedCount }, 200);
});
