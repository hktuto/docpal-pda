import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../../db.js";
import { queryAll, queryGet, queryRun } from "../../db/query.js";
import { mapDbError, optStr, reqInt, reqStr } from "./crud.js";

// ---------------------------------------------------------------------------
// Sub-inventories (3-level model: org_id → code group → tag). Custom router
// (not createCrudRouter): the list aggregates the group's tags, group create
// makes its default tag, and tags are managed per group. Rows are addressed
// as `:orgId::code`; tags as `:orgId::code::tag`.
// ---------------------------------------------------------------------------

export const adminSubInventoriesRoute = new Hono();

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

function parseGroupId(id: string): { orgId: number; code: string } {
  const sep = id.indexOf(":");
  if (sep <= 0 || !Number.isInteger(Number(id.slice(0, sep)))) {
    throw new HTTPException(400, { message: "id must be orgId:code" });
  }
  return { orgId: Number(id.slice(0, sep)), code: id.slice(sep + 1) };
}

const GROUP_COLS = sql`si.org_id AS "orgId", si.code, si.name, si.customer_code AS "customerCode",
       si.created_at AS "createdAt", si.updated_at AS "updatedAt",
       COALESCE(array_agg(t.tag ORDER BY t.tag) FILTER (WHERE t.tag IS NOT NULL), '{}') AS "tags"`;

adminSubInventoriesRoute.get("/", async (c) => {
  const rows = await queryAll(
    db,
    sql`SELECT ${GROUP_COLS}
        FROM sub_inventories si
        LEFT JOIN sub_inventory_tags t ON t.org_id = si.org_id AND t.code = si.code
        GROUP BY si.org_id, si.code, si.name, si.customer_code, si.created_at, si.updated_at
        ORDER BY si.org_id, si.code`
  );
  return c.json(rows);
});

adminSubInventoriesRoute.get("/:id", async (c) => {
  const g = parseGroupId(c.req.param("id"));
  const row = await queryGet(
    db,
    sql`SELECT ${GROUP_COLS}
        FROM sub_inventories si
        LEFT JOIN sub_inventory_tags t ON t.org_id = si.org_id AND t.code = si.code
        WHERE si.org_id = ${g.orgId} AND si.code = ${g.code}
        GROUP BY si.org_id, si.code, si.name, si.customer_code, si.created_at, si.updated_at`
  );
  if (!row) throw new HTTPException(404, { message: "not found" });
  return c.json(row);
});

// Create a group; its default tag (body.tag, default = code) is created with it.
adminSubInventoriesRoute.post("/", async (c) => {
  const b = await readJson(c);
  const orgId = reqInt(b, "orgId");
  const code = reqStr(b, "code");
  const tag = optStr(b, "tag") ?? code;
  try {
    const row = await db.transaction(async (tx) => {
      await queryRun(
        tx,
        sql`INSERT INTO sub_inventories (org_id, code, name, customer_code, created_at, updated_at)
            VALUES (${orgId}, ${code}, ${optStr(b, "name")}, ${optStr(b, "customerCode")}, now(), now())`
      );
      await queryRun(
        tx,
        sql`INSERT INTO sub_inventory_tags (org_id, code, tag, created_at, updated_at)
            VALUES (${orgId}, ${code}, ${tag}, now(), now())`
      );
      return queryGet<{ orgId: number; code: string }>(
        tx,
        sql`SELECT org_id AS "orgId", code FROM sub_inventories WHERE org_id = ${orgId} AND code = ${code}`
      );
    });
    return c.json({ ...row, tag }, 201);
  } catch (e) {
    mapDbError(e);
  }
});

adminSubInventoriesRoute.patch("/:id", async (c) => {
  const g = parseGroupId(c.req.param("id"));
  const b = await readJson(c);
  const hasName = b.name !== undefined;
  const hasCustomer = b.customerCode !== undefined;
  if (!hasName && !hasCustomer) throw new HTTPException(400, { message: "no fields to update" });
  try {
    const row = await queryGet(
      db,
      sql`UPDATE sub_inventories
          SET name = CASE WHEN ${hasName} THEN ${optStr(b, "name")} ELSE name END,
              customer_code = CASE WHEN ${hasCustomer} THEN ${optStr(b, "customerCode")} ELSE customer_code END,
              updated_at = now()
          WHERE org_id = ${g.orgId} AND code = ${g.code}
          RETURNING org_id AS "orgId", code, name, customer_code AS "customerCode"`
    );
    if (!row) throw new HTTPException(404, { message: "not found" });
    return c.json(row);
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    mapDbError(e);
  }
});

// Tags of a group.
adminSubInventoriesRoute.post("/:id/tags", async (c) => {
  const g = parseGroupId(c.req.param("id"));
  const b = await readJson(c);
  const tag = reqStr(b, "tag");
  try {
    await queryRun(
      db,
      sql`INSERT INTO sub_inventory_tags (org_id, code, tag, name, description, created_at, updated_at)
          VALUES (${g.orgId}, ${g.code}, ${tag}, ${optStr(b, "name")}, ${optStr(b, "description")}, now(), now())`
    );
    return c.json({ orgId: g.orgId, code: g.code, tag }, 201);
  } catch (e) {
    mapDbError(e);
  }
});

adminSubInventoriesRoute.delete("/:id/tags/:tag", async (c) => {
  const g = parseGroupId(c.req.param("id"));
  const row = await queryGet(
    db,
    sql`DELETE FROM sub_inventory_tags WHERE org_id = ${g.orgId} AND code = ${g.code} AND tag = ${c.req.param("tag")}
        RETURNING tag`
  );
  if (!row) throw new HTTPException(404, { message: "not found" });
  return c.json({ ok: true });
});

adminSubInventoriesRoute.delete("/:id", async (c) => {
  const g = parseGroupId(c.req.param("id"));
  try {
    const row = await db.transaction(async (tx) => {
      await queryRun(
        tx,
        sql`DELETE FROM sub_inventory_tags WHERE org_id = ${g.orgId} AND code = ${g.code}`
      );
      return queryGet(tx, sql`DELETE FROM sub_inventories WHERE org_id = ${g.orgId} AND code = ${g.code} RETURNING code`);
    });
    if (!row) throw new HTTPException(404, { message: "not found" });
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    mapDbError(e);
  }
});
