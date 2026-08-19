import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../../db.js";
import { queryAll, queryGet } from "../../db/query.js";
import { mapDbError, optInt, optStr, reqInt, reqStr } from "./crud.js";

// ---------------------------------------------------------------------------
// Sub-inventories: the (org_id, secondary_inventory_name) group level all
// stock/doc tables reference. Custom router (not createCrudRouter): rows are
// addressed as `:orgId::code` (composite UNIQUE business key under the id PK).
// Column names mirror the upstream DocPal/Oracle subinventory schema.
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

const GROUP_COLS = sql`si.org_id AS "orgId", si.secondary_inventory_name AS "secondaryInventoryName",
       si.subinv_description AS "subinvDescription", si.office_code AS "officeCode",
       si.organization_id AS "organizationId",
       si.creation_date AS "creationDate", si.last_update_date AS "lastUpdateDate"`;

adminSubInventoriesRoute.get("/", async (c) => {
  const rows = await queryAll(
    db,
    sql`SELECT ${GROUP_COLS}
        FROM org_info si
        ORDER BY si.org_id, si.secondary_inventory_name`
  );
  return c.json(rows);
});

adminSubInventoriesRoute.get("/:id", async (c) => {
  const g = parseGroupId(c.req.param("id"));
  const row = await queryGet(
    db,
    sql`SELECT ${GROUP_COLS}
        FROM org_info si
        WHERE si.org_id = ${g.orgId} AND si.secondary_inventory_name = ${g.code}`
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
      sql`INSERT INTO org_info (id, org_id, secondary_inventory_name, subinv_description,
                  office_code, organization_id, creation_date, last_update_date)
          VALUES (app_uuid_v7(), ${orgId}, ${code}, ${optStr(b, "subinvDescription")},
                  ${optStr(b, "officeCode")}, ${optInt(b, "organizationId")}, now(), now())
          RETURNING org_id AS "orgId", secondary_inventory_name AS "secondaryInventoryName"`
    );
    return c.json(row, 201);
  } catch (e) {
    mapDbError(e);
  }
});

adminSubInventoriesRoute.patch("/:id", async (c) => {
  const g = parseGroupId(c.req.param("id"));
  const b = await readJson(c);
  const hasDesc = b.subinvDescription !== undefined;
  const hasOffice = b.officeCode !== undefined;
  const hasOrg = b.organizationId !== undefined;
  if (!hasDesc && !hasOffice && !hasOrg) {
    throw new HTTPException(400, { message: "no fields to update" });
  }
  try {
    const row = await queryGet(
      db,
      sql`UPDATE org_info
          SET subinv_description = CASE WHEN ${hasDesc} THEN ${optStr(b, "subinvDescription")} ELSE subinv_description END,
              office_code = CASE WHEN ${hasOffice} THEN ${optStr(b, "officeCode")} ELSE office_code END,
              organization_id = CASE WHEN ${hasOrg} THEN ${optInt(b, "organizationId")} ELSE organization_id END,
              last_update_date = now()
          WHERE org_id = ${g.orgId} AND secondary_inventory_name = ${g.code}
          RETURNING org_id AS "orgId", secondary_inventory_name AS "secondaryInventoryName",
                    subinv_description AS "subinvDescription", office_code AS "officeCode",
                    organization_id AS "organizationId"`
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
      sql`DELETE FROM org_info WHERE org_id = ${g.orgId} AND secondary_inventory_name = ${g.code}
          RETURNING secondary_inventory_name AS "secondaryInventoryName"`
    );
    if (!row) throw new HTTPException(404, { message: "not found" });
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    mapDbError(e);
  }
});
