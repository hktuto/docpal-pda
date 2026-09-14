import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db.js";
import { customerProfiles } from "../../db/schema/index.js";
import { newId } from "../../db/id.js";
import { mapDbError, optJson, optStr, optStrArray, reqStr } from "./crud.js";

// ---------------------------------------------------------------------------
// Customer profiles: PDA-local per-customer requirements. Custom router (not
// createCrudRouter): membership is the jsonb `customers` array (party names),
// and a party name may appear in at most one profile — enforced here at the
// app layer (no practical DB constraint on a jsonb array).
// ---------------------------------------------------------------------------

export const adminCustomerProfilesRoute = new Hono();

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

/** 409 when any name is already in another profile's customers. */
async function assertCustomersUnassigned(names: string[], excludeCode?: string): Promise<void> {
  if (names.length === 0) return;
  const rows = await db
    .select({ code: customerProfiles.code, customers: customerProfiles.customers })
    .from(customerProfiles);
  for (const name of names) {
    const owner = rows.find((r) => r.code !== excludeCode && r.customers.includes(name));
    if (owner) {
      throw new HTTPException(409, { message: `customer_already_assigned: ${name}` });
    }
  }
}

adminCustomerProfilesRoute.get("/", async (c) => {
  const rows = await db.select().from(customerProfiles).orderBy(asc(customerProfiles.code));
  return c.json(rows);
});

adminCustomerProfilesRoute.get("/:code", async (c) => {
  const rows = await db.select().from(customerProfiles).where(eq(customerProfiles.code, c.req.param("code")));
  if (rows.length === 0) throw new HTTPException(404, { message: "not found" });
  return c.json(rows[0]);
});

adminCustomerProfilesRoute.post("/", async (c) => {
  const b = await readJson(c);
  const code = reqStr(b, "code");
  const customers = optStrArray(b, "customers") ?? [];
  await assertCustomersUnassigned(customers);
  try {
    const inserted = await db
      .insert(customerProfiles)
      .values({
        id: typeof b.id === "string" && b.id.trim() !== "" ? b.id.trim() : newId(),
        code,
        label: reqStr(b, "label"),
        rule: optJson(b, "rule") as Record<string, unknown> | null,
        remark: optStr(b, "remark"),
        customers,
      })
      .returning();
    return c.json(inserted[0], 201);
  } catch (e) {
    mapDbError(e);
  }
});

adminCustomerProfilesRoute.patch("/:code", async (c) => {
  const b = await readJson(c);
  const set: Partial<typeof customerProfiles.$inferInsert> = { lastUpdateDate: new Date() };
  if (b.label !== undefined) set.label = reqStr(b, "label");
  if (b.rule !== undefined) set.rule = optJson(b, "rule") as Record<string, unknown> | null;
  if (b.remark !== undefined) set.remark = optStr(b, "remark");
  if (b.customers !== undefined) {
    const customers = optStrArray(b, "customers") ?? [];
    await assertCustomersUnassigned(customers, c.req.param("code"));
    set.customers = customers;
  }
  if (Object.keys(set).length === 1) throw new HTTPException(400, { message: "no fields to update" });
  try {
    const updated = await db
      .update(customerProfiles)
      .set(set)
      .where(eq(customerProfiles.code, c.req.param("code")))
      .returning();
    if (updated.length === 0) throw new HTTPException(404, { message: "not found" });
    return c.json(updated[0]);
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    mapDbError(e);
  }
});

// Atomic membership edit: {add?: string[], remove?: string[]}.
adminCustomerProfilesRoute.put("/:code/customers", async (c) => {
  const code = c.req.param("code");
  const b = await readJson(c);
  const add = optStrArray(b, "add") ?? [];
  const remove = new Set(optStrArray(b, "remove") ?? []);
  const rows = await db.select().from(customerProfiles).where(eq(customerProfiles.code, code));
  if (rows.length === 0) throw new HTTPException(404, { message: "not found" });
  const next = [...rows[0].customers.filter((n) => !remove.has(n))];
  for (const name of add) if (!next.includes(name)) next.push(name);
  await assertCustomersUnassigned(add, code);
  try {
    const updated = await db
      .update(customerProfiles)
      .set({ customers: next, lastUpdateDate: new Date() })
      .where(eq(customerProfiles.code, code))
      .returning();
    return c.json(updated[0]);
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    mapDbError(e);
  }
});

adminCustomerProfilesRoute.delete("/:code", async (c) => {
  try {
    const deleted = await db
      .delete(customerProfiles)
      .where(eq(customerProfiles.code, c.req.param("code")))
      .returning({ code: customerProfiles.code });
    if (deleted.length === 0) throw new HTTPException(404, { message: "not found" });
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    mapDbError(e);
  }
});
