import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../../db.js";
import { nextBoxId } from "../../db/boxes.js";
import { queryAll, queryGet } from "../../db/query.js";

export const shelfBoxesRoute = new Hono();

const BOX_STATUSES = ["open", "closed", "verified"] as const;

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

function optStr(b: Record<string, unknown>, field: string): string | null {
  const v = b[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HTTPException(400, { message: `${field} must be a string` });
  return v.trim() === "" ? null : v.trim();
}

function optStatus(b: Record<string, unknown>): string | undefined {
  const v = b.status;
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !BOX_STATUSES.includes(v as (typeof BOX_STATUSES)[number])) {
    throw new HTTPException(400, { message: `status must be one of ${BOX_STATUSES.join("/")}` });
  }
  return v;
}

shelfBoxesRoute.get("/", async (c) => {
  const rows = await queryAll(
    db,
    sql`SELECT sb.id,
               sb.shelf_code          AS "shelfCode",
               sb.status,
               sb.created_at          AS "createdAt",
               COUNT(sbi.id)::int          AS "itemCount",
               COALESCE(SUM(sbi.qty), 0)::int AS "totalQty"
        FROM shelf_boxes sb
        LEFT JOIN shelf_box_items sbi ON sbi.shelf_box_id = sb.id
        GROUP BY sb.id
        ORDER BY sb.created_at DESC`
  );
  return c.json(rows);
});

shelfBoxesRoute.post("/", async (c) => {
  const b = await readJson(c);
  const id = await nextBoxId(db, "H");
  try {
    const row = await queryGet(
      db,
      sql`INSERT INTO shelf_boxes (id, shelf_code, status, created_at)
          VALUES (${id}, ${optStr(b, "shelfCode")}, ${optStatus(b) ?? "open"}, ${new Date()})
          RETURNING id, shelf_code AS "shelfCode", status, created_at AS "createdAt"`
    );
    return c.json(row, 201);
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    if ((err?.code ?? err?.cause?.code) === "23503") {
      throw new HTTPException(409, { message: "invalid shelf_code" });
    }
    throw e;
  }
});

shelfBoxesRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const box = await queryGet(
    db,
    sql`SELECT sb.id,
               sb.shelf_code          AS "shelfCode",
               sb.status,
               sb.created_at          AS "createdAt"
        FROM shelf_boxes sb
        WHERE sb.id = ${id}`
  );
  if (!box) throw new HTTPException(404, { message: "not found" });
  const items = await queryAll(
    db,
    sql`SELECT sbi.id,
               sbi.part_no                 AS "partNo",
               sbi.qty,
               sbi.verified,
               sbi.verified_at             AS "verifiedAt",
               sbi.receiving_invoice_item_id AS "receivingInvoiceItemId"
        FROM shelf_box_items sbi
        WHERE sbi.shelf_box_id = ${id}
        ORDER BY sbi.part_no`
  );
  return c.json({ ...box, items });
});

shelfBoxesRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const b = await readJson(c);
  const status = optStatus(b);
  const hasShelf = b.shelfCode !== undefined;
  if (status === undefined && !hasShelf) {
    throw new HTTPException(400, { message: "no fields to update" });
  }
  const shelfCode = optStr(b, "shelfCode"); // null clears the assignment
  try {
    const row = await queryGet(
      db,
      sql`UPDATE shelf_boxes
          SET shelf_code = CASE WHEN ${hasShelf} THEN ${shelfCode} ELSE shelf_code END,
              status     = COALESCE(${status ?? null}, status)
          WHERE id = ${id}
          RETURNING id, shelf_code AS "shelfCode", status, created_at AS "createdAt"`
    );
    if (!row) throw new HTTPException(404, { message: "not found" });
    return c.json(row);
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    if ((err?.code ?? err?.cause?.code) === "23503") {
      throw new HTTPException(409, { message: "invalid shelf_code" });
    }
    throw e;
  }
});

shelfBoxesRoute.delete("/:id", async (c) => {
  const row = await queryGet(
    db,
    sql`DELETE FROM shelf_boxes WHERE id = ${c.req.param("id")} RETURNING id`
  );
  if (!row) throw new HTTPException(404, { message: "not found" });
  return c.json({ ok: true });
});
