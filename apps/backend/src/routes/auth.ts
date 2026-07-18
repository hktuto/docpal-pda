import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { queryGet } from "../db/query.js";

export interface LoginRequest {
  username: string;
  password: string;
}

// Role union mirrors the demo users seed; the column itself is unconstrained text.
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: "operator" | "admin";
}

export const authRoute = new Hono();

async function readJson<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  role: AuthUser["role"];
}

function toAuthUser(user: UserRow): AuthUser {
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role };
}

// Demo parity with apps/api: plain-text password compare against the demo
// users table (real password hashing / ucenter integration is a later phase).
authRoute.post("/auth/login", async (c) => {
  const body = await readJson<LoginRequest>(c);
  if (!body.username || !body.password) {
    throw new HTTPException(400, { message: "username and password are required" });
  }
  const user = await queryGet<UserRow & { password_hash: string }>(
    db,
    sql`SELECT id, username, display_name AS "displayName", role, password_hash FROM users WHERE username = ${body.username}`
  );
  if (!user || user.password_hash !== body.password) {
    throw new HTTPException(401, { message: "invalid credentials" });
  }
  return c.json(toAuthUser(user), 200);
});

// Stateless demo: there is no server-side session to revoke. The endpoint
// exists so clients can call login/logout symmetrically; if tokens/sessions
// are introduced later, revocation goes here without a client change.
authRoute.post("/auth/logout", (c) => {
  return c.json({ ok: true }, 200);
});

authRoute.get("/auth/users/:id", async (c) => {
  const user = await queryGet<UserRow>(
    db,
    sql`SELECT id, username, display_name AS "displayName", role FROM users WHERE id = ${c.req.param("id")}`
  );
  if (!user) throw new HTTPException(404, { message: "user not found" });
  return c.json(toAuthUser(user), 200);
});
