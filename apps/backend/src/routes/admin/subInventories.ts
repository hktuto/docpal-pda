import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../../db.js";
import { queryAll, queryGet } from "../../db/query.js";
import { mapDbError, optStr, reqInt, reqStr } from "./crud.js";

// ---------------------------------------------------------------------------
// Sub-inventories: the (org_id, code) group level all stock/doc tables
// reference. Custom router (not createCrudRouter): rows are addressed as
// `:orgId::code` (composite PK).
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
       si.created_at AS "createdAt", si.updated_at AS "updatedAt"`;

adminSubInventoriesRoute.get("/", async (c) => {
  const rows = await queryAll(
    db,
    sql`SELECT ${GROUP_COLS}
        FROM sub_inventories si
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
        WHERE si.org_id = ${g.orgId} AND si.code = ${g.code}`
  );
  if (!row) throw new HTTPException(404, { message: "not found" });
  return c.json(row);
});

adminSubInventoriesRoute.post("/", async (c) => {
  const b = await readJson(c);
  const orgId = reqInt(b, "orgId");
  const code = reqStr(b, "code");
  try {
    const row = await queryGet(
      db,
      sql`INSERT INTO sub_inventories (org_id, code, name, customer_code, created_at, updated_at)
          VALUES (${orgId}, ${code}, ${optStr(b, "name")}, ${optStr(b, "customerCode")}, now(), now())
          RETURNING org_id AS "orgId", code`
    );
    return c.json(row, 201);
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

adminSubInventoriesRoute.delete("/:id", async (c) => {
  const g = parseGroupId(c.req.param("id"));
  try {
    const row = await queryGet(
      db,
      sql`DELETE FROM sub_inventories WHERE org_id = ${g.orgId} AND code = ${g.code} RETURNING code`
    );
    if (!row) throw new HTTPException(404, { message: "not found" });
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    mapDbError(e);
  }
});
