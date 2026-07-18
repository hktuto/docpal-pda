import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { LoginRequest, AuthUser } from "@warehouse/shared";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { queryGet } from "../db/query.js";

export const authRoute = new Hono();

async function readJson<T>(c: Context): Promise<T> {
  try { return await c.req.json<T>(); } catch { throw new HTTPException(400, { message: "invalid JSON body" }); }
}

interface UserRow { id: string; username: string; displayName: string; role: AuthUser["role"] }

function toAuthUser(user: UserRow): AuthUser {
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role };
}

authRoute.post("/auth/login", async (c) => {
  const body = await readJson<LoginRequest>(c);
  if (!body.username || !body.password) {
    throw new HTTPException(400, { message: "username and password are required" });
  }
  // Demo parity with the web's pgliteAuth: plain-text password compare.
  const user = await queryGet<UserRow & { password_hash: string }>(
    db,
    sql`SELECT id, username, display_name AS "displayName", role, password_hash FROM users WHERE username = ${body.username}`);
  if (!user || user.password_hash !== body.password) {
    throw new HTTPException(401, { message: "invalid credentials" });
  }
  return c.json(toAuthUser(user), 200);
});

authRoute.get("/auth/users/:id", async (c) => {
  const user = await queryGet<UserRow>(db, sql`SELECT id, username, display_name AS "displayName", role FROM users WHERE id = ${c.req.param("id")}`);
  if (!user) throw new HTTPException(404, { message: "user not found" });
  return c.json(toAuthUser(user), 200);
});
