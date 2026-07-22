import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { queryAll, queryGet } from "../db/query.js";
import { hashPassword, isLegacyPlaintext, verifyPassword } from "../auth/password.js";
import { signAuthToken } from "../auth/jwt.js";
import { actorFrom } from "../auth/middleware.js";

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  groupCodes: string[];
}

export interface LoginResponse {
  user: AuthUser;
  token: string;
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
}

async function groupCodesOf(userId: string): Promise<string[]> {
  const rows = await queryAll<{ groupCode: string }>(
    db,
    sql`SELECT group_code AS "groupCode" FROM user_group_members WHERE user_id = ${userId} ORDER BY group_code`
  );
  return rows.map((r) => r.groupCode);
}

async function toAuthUser(user: UserRow): Promise<AuthUser> {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    groupCodes: await groupCodesOf(user.id),
  };
}

// Login: scrypt verify against users.password_hash. Legacy plain-text rows
// (pre-auth demo data) verify by direct compare and are lazily re-hashed on
// success, upgrading the row in place.
authRoute.post("/auth/login", async (c) => {
  const body = await readJson<LoginRequest>(c);
  if (!body.username || !body.password) {
    throw new HTTPException(400, { message: "username and password are required" });
  }
  const user = await queryGet<UserRow & { passwordHash: string }>(
    db,
    sql`SELECT id, username, display_name AS "displayName", password_hash AS "passwordHash" FROM users WHERE username = ${body.username}`
  );
  if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
    throw new HTTPException(401, { message: "invalid credentials" });
  }
  if (isLegacyPlaintext(user.passwordHash)) {
    await db.execute(sql`UPDATE users SET password_hash = ${await hashPassword(body.password)} WHERE id = ${user.id}`);
  }
  const authUser = await toAuthUser(user);
  const token = await signAuthToken(authUser);
  const response: LoginResponse = { user: authUser, token };
  return c.json(response, 200);
});

// Stateless: the client discards the token. The endpoint exists so clients
// can call login/logout symmetrically; server-side revocation (e.g.
// users.token_version) would go here without a client change.
authRoute.post("/auth/logout", (c) => {
  return c.json({ ok: true }, 200);
});

// Current user from the bearer token (session restore). Resolved fresh from
// the DB so display name and group codes are never stale.
authRoute.get("/auth/me", async (c) => {
  const actor = actorFrom(c);
  const user = await queryGet<UserRow>(
    db,
    sql`SELECT id, username, display_name AS "displayName" FROM users WHERE id = ${actor.id}`
  );
  if (!user) throw new HTTPException(401, { message: "unauthorized" });
  return c.json(await toAuthUser(user), 200);
});

authRoute.get("/auth/users/:id", async (c) => {
  const user = await queryGet<UserRow>(
    db,
    sql`SELECT id, username, display_name AS "displayName" FROM users WHERE id = ${c.req.param("id")}`
  );
  if (!user) throw new HTTPException(404, { message: "user not found" });
  return c.json(await toAuthUser(user), 200);
});

// Self-service password change; existing tokens stay valid (logout = client
// discards the token — see the spec's revocation stance).
authRoute.post("/auth/change-password", async (c) => {
  const body = await readJson<{ oldPassword?: string; newPassword?: string }>(c);
  if (!body.oldPassword || !body.newPassword) {
    throw new HTTPException(400, { message: "oldPassword and newPassword are required" });
  }
  const actor = actorFrom(c);
  const user = await queryGet<{ id: string; passwordHash: string }>(
    db,
    sql`SELECT id, password_hash AS "passwordHash" FROM users WHERE id = ${actor.id}`
  );
  if (!user || !(await verifyPassword(body.oldPassword, user.passwordHash))) {
    throw new HTTPException(401, { message: "invalid credentials" });
  }
  await db.execute(sql`UPDATE users SET password_hash = ${await hashPassword(body.newPassword)} WHERE id = ${user.id}`);
  return c.json({ ok: true }, 200);
});
