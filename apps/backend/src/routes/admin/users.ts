// Custom users admin router (does not use createCrudRouter): passwords are
// accepted as a write-only `password` field, hashed server-side with scrypt,
// and password_hash is never selected or returned.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { newId } from "../../db/id.js";
import { eq } from "drizzle-orm";
import { db } from "../../db.js";
import { users } from "../../db/schema/index.js";
import { hashPassword } from "../../auth/password.js";
import { mapDbError, reqStr } from "./crud.js";

const PUBLIC_COLUMNS = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  createdDate: users.createdDate,
} as const;

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

export const adminUsersRoute = new Hono();

adminUsersRoute.get("/", async (c) => {
  const rows = await db.select(PUBLIC_COLUMNS).from(users).orderBy(users.username);
  return c.json(rows);
});

adminUsersRoute.get("/:id", async (c) => {
  const rows = await db.select(PUBLIC_COLUMNS).from(users).where(eq(users.id, c.req.param("id")));
  if (rows.length === 0) throw new HTTPException(404, { message: "not found" });
  return c.json(rows[0]);
});

// Create: {id?, username, password, displayName}.
adminUsersRoute.post("/", async (c) => {
  const body = await readJson(c);
  const v = body.id;
  const row = {
    id: typeof v === "string" && v.trim() !== "" ? v.trim() : newId(),
    username: reqStr(body, "username"),
    passwordHash: await hashPassword(reqStr(body, "password")),
    displayName: reqStr(body, "displayName"),
  };
  try {
    const inserted = await db.insert(users).values(row).returning(PUBLIC_COLUMNS);
    return c.json(inserted[0], 201);
  } catch (e) {
    mapDbError(e);
  }
});

// Edit: username / displayName always patchable; `password` is optional —
// omit it to keep the current password.
adminUsersRoute.patch("/:id", async (c) => {
  const body = await readJson(c);
  const set: Partial<typeof users.$inferInsert> = {
    ...(body.username !== undefined && { username: reqStr(body, "username") }),
    ...(body.displayName !== undefined && { displayName: reqStr(body, "displayName") }),
  };
  if (body.password !== undefined) {
    set.passwordHash = await hashPassword(reqStr(body, "password"));
  }
  if (Object.keys(set).length === 0) {
    throw new HTTPException(400, { message: "no fields to update" });
  }
  try {
    const updated = await db
      .update(users)
      .set(set)
      .where(eq(users.id, c.req.param("id")))
      .returning(PUBLIC_COLUMNS);
    if (updated.length === 0) throw new HTTPException(404, { message: "not found" });
    return c.json(updated[0]);
  } catch (e) {
    mapDbError(e);
  }
});

adminUsersRoute.delete("/:id", async (c) => {
  try {
    const deleted = await db.delete(users).where(eq(users.id, c.req.param("id"))).returning({ id: users.id });
    if (deleted.length === 0) throw new HTTPException(404, { message: "not found" });
    return c.json({ ok: true });
  } catch (e) {
    mapDbError(e);
  }
});
