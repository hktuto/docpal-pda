import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { queryAll, queryGet } from "../db/query.js";
import { newId } from "../db/id.js";
import { hashPassword, isLegacyPlaintext, verifyPassword } from "../auth/password.js";
import { signAuthToken } from "../auth/jwt.js";
import { actorFrom } from "../auth/middleware.js";
import { docpalBaseUrl, docpalGroupMapping } from "../config.js";
import { DocpalAuthError, docpalGetUser, docpalLogin } from "../auth/docpal.js";

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

// DocPal-delegated login (spec: docs/superpowers/specs/2026-08-13-docpal-auth-design.md):
// DocPal verifies the credentials, we auto-provision the local users row and
// replace its group membership with the mapped local groups, then sign our
// own JWT. DocPal groups are mapped through docpalGroupMapping (the API
// returns groups, not permissions); a user with no mapped group gets 403.
async function loginViaDocpal(username: string, password: string): Promise<LoginResponse> {
  try {
    const accessToken = await docpalLogin(username, password);
    const profile = await docpalGetUser(accessToken);
    const groupCodes = [...new Set(profile.groups.flatMap((g) => docpalGroupMapping[g.id] ?? []))].sort();
    if (groupCodes.length === 0) {
      throw new HTTPException(403, { message: "user has no WMS access" });
    }
    const authUser = await db.transaction(async (tx) => {
      // Upsert the local user. password_hash = "" is an unverifiable sentinel
      // (empty passwords are rejected at the 400 check before any compare).
      const existing = await queryGet<UserRow>(
        tx,
        sql`SELECT id, username, display_name AS "displayName" FROM users WHERE username = ${profile.username}`
      );
      const userId = existing?.id ?? newId();
      if (existing) {
        await tx.execute(sql`UPDATE users SET display_name = ${profile.displayName}, last_update_date = now() WHERE id = ${userId}`);
      } else {
        await tx.execute(sql`INSERT INTO users (id, username, password_hash, display_name) VALUES (${userId}, ${profile.username}, '', ${profile.displayName})`);
      }
      // Replace membership with the mapped local groups (admin/operator).
      await tx.execute(sql`DELETE FROM user_group_members WHERE user_id = ${userId}`);
      for (const code of groupCodes) {
        await tx.execute(
          sql`INSERT INTO user_groups (id, code, label) VALUES (${newId()}, ${code}, ${code})
              ON CONFLICT (code) DO NOTHING`
        );
        await tx.execute(sql`INSERT INTO user_group_members (id, user_id, group_code) VALUES (${newId()}, ${userId}, ${code})`);
      }
      return { id: userId, username: profile.username, displayName: profile.displayName, groupCodes };
    });
    const token = await signAuthToken(authUser);
    return { user: authUser, token };
  } catch (e) {
    if (e instanceof DocpalAuthError) {
      throw new HTTPException(e.status, { message: e.status === 401 ? "invalid credentials" : "identity provider unavailable" });
    }
    throw e;
  }
}

// Login: when DOCPAL_URL is set, credentials are verified against the DocPal
// API (see loginViaDocpal). Otherwise scrypt verify against
// users.password_hash. Legacy plain-text rows (pre-auth demo data) verify by
// direct compare and are lazily re-hashed on success, upgrading the row in
// place.
authRoute.post("/auth/login", async (c) => {
  const body = await readJson<LoginRequest>(c);
  if (!body.username || !body.password) {
    throw new HTTPException(400, { message: "username and password are required" });
  }
  if (docpalBaseUrl()) {
    return c.json(await loginViaDocpal(body.username, body.password), 200);
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
