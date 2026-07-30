import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../../db.js";
import { queryAll, queryGet, queryRun } from "../../db/query.js";
import { mapDbError, optStr } from "./crud.js";

// ---------------------------------------------------------------------------
// Sub-inventory share groups (sub_inventory_share_members): members of the
// same share_group may serve each other's picking demands (see allocate.ts).
// Rows are addressed as `:orgId::code` like the sub-inventory groups. PUT
// upserts a membership; an empty shareGroup (or DELETE) removes it.
// ---------------------------------------------------------------------------

export const adminSubInventoryShareGroupsRoute = new Hono();

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

function parseMemberId(id: string): { orgId: number; code: string } {
  const sep = id.indexOf(":");
  if (sep <= 0 || !Number.isInteger(Number(id.slice(0, sep)))) {
    throw new HTTPException(400, { message: "id must be orgId:code" });
  }
  return { orgId: Number(id.slice(0, sep)), code: id.slice(sep + 1) };
}

adminSubInventoryShareGroupsRoute.get("/", async (c) => {
  const rows = await queryAll(
    db,
    sql`SELECT m.share_group AS "shareGroup", m.org_id AS "orgId", m.code,
               si.name AS "subInventoryName", si.customer_code AS "customerCode",
               m.created_date AS "createdDate", m.last_update_date AS "lastUpdateDate"
        FROM sub_inventory_share_members m
        JOIN sub_inventories si ON si.org_id = m.org_id AND si.code = m.code
        ORDER BY m.share_group, m.org_id, m.code`
  );
  return c.json(rows);
});

// Upsert a membership; body.shareGroup empty/null removes it instead.
adminSubInventoryShareGroupsRoute.put("/:id", async (c) => {
  const m = parseMemberId(c.req.param("id"));
  const b = await readJson(c);
  const shareGroup = optStr(b, "shareGroup");
  try {
    if (!shareGroup) {
      await queryRun(
        db,
        sql`DELETE FROM sub_inventory_share_members WHERE org_id = ${m.orgId} AND code = ${m.code}`
      );
      return c.json({ ok: true });
    }
    await queryRun(
      db,
      sql`INSERT INTO sub_inventory_share_members (org_id, code, share_group, created_date, last_update_date)
          VALUES (${m.orgId}, ${m.code}, ${shareGroup}, now(), now())
          ON CONFLICT (org_id, code)
          DO UPDATE SET share_group = ${shareGroup}, last_update_date = now()`
    );
    const row = await queryGet(
      db,
      sql`SELECT share_group AS "shareGroup", org_id AS "orgId", code
          FROM sub_inventory_share_members WHERE org_id = ${m.orgId} AND code = ${m.code}`
    );
    return c.json(row);
  } catch (e) {
    mapDbError(e);
  }
});

adminSubInventoryShareGroupsRoute.delete("/:id", async (c) => {
  const m = parseMemberId(c.req.param("id"));
  await queryRun(
    db,
    sql`DELETE FROM sub_inventory_share_members WHERE org_id = ${m.orgId} AND code = ${m.code}`
  );
  return c.json({ ok: true });
});
