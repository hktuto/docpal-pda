import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { queryAll, queryGet } from "../db/query.js";
import { newId } from "../db/id.js";
import { signAuthToken } from "../auth/jwt.js";
import { actorFrom } from "../auth/middleware.js";
import { docpalBaseUrl, docpalGroupMapping } from "../config.js";
import { DocpalAuthError, docpalGetUser, docpalLogin, type DocpalUser } from "../auth/docpal.js";
import { getUserScope, parseScopeEntries, upsertUserScope } from "../db/user-scope.js";

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
async function provisionAndSign(profile: DocpalUser): Promise<LoginResponse> {
  const groupCodes = [...new Set(profile.groups.flatMap((g) => docpalGroupMapping[g.id] ?? []))].sort();
  if (groupCodes.length === 0) {
    throw new HTTPException(403, { message: "user has no WMS access" });
  }
  const authUser = await db.transaction(async (tx) => {
    // Upsert the local user. password_hash = "" — passwords are never
    // stored locally; DocPal is the only credential verifier.
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
    // Replace membership with the mapped local groups (admin / PDA Group).
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
}

function rethrowDocpalFailure(e: unknown, username: string): never {
  if (e instanceof DocpalAuthError) {
    // Client gets a generic message; the underlying reason stays in the log.
    console.error(`[auth] DocPal login for "${username}" failed: ${e.message}`);
    throw new HTTPException(e.status, { message: e.status === 401 ? "invalid credentials" : "identity provider unavailable" });
  }
  throw e;
}

async function loginViaDocpal(username: string, password: string): Promise<LoginResponse> {
  try {
    const accessToken = await docpalLogin(username, password);
    const profile = await docpalGetUser(accessToken);
    return await provisionAndSign(profile);
  } catch (e) {
    rethrowDocpalFailure(e, username);
  }
}

// Token login (spec: docs/superpowers/specs/2026-09-11-token-login-link-design.md):
// the caller presents a DocPal access token (e.g. from a DocPal-side link)
// instead of a password; it is validated the same way via docpalGetUser.
async function loginViaDocpalToken(accessToken: string): Promise<LoginResponse> {
  try {
    const profile = await docpalGetUser(accessToken);
    return await provisionAndSign(profile);
  } catch (e) {
    rethrowDocpalFailure(e, "(access token)");
  }
}

// Login: credentials are always verified against the DocPal API (see
// loginViaDocpal) — users must be DocPal users. Without DOCPAL_URL there is
// no identity provider, so login fails fast with 500.
authRoute.post("/auth/login", async (c) => {
  const body = await readJson<LoginRequest>(c);
  if (!body.username || !body.password) {
    throw new HTTPException(400, { message: "username and password are required" });
  }
  if (!docpalBaseUrl()) {
    throw new HTTPException(500, { message: "DOCPAL_URL is not configured" });
  }
  return c.json(await loginViaDocpal(body.username, body.password), 200);
});

// Token login: accepts a DocPal access token (e.g. carried by a sign-in link
// from DocPal) instead of a password; validated against DocPal the same way.
authRoute.post("/auth/login-token", async (c) => {
  const body = await readJson<{ accessToken?: string }>(c);
  if (!body.accessToken) {
    throw new HTTPException(400, { message: "accessToken is required" });
  }
  if (!docpalBaseUrl()) {
    throw new HTTPException(500, { message: "DOCPAL_URL is not configured" });
  }
  return c.json(await loginViaDocpalToken(body.accessToken), 200);
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

// Per-user sub-inventory scope (spec 2026-09-11-user-subinventory-scope-design.md).
// GET returns [] when unrestricted (no profile row / NULL scope); PUT stores
// the array as-is ([] clears the scope) after validating every pair against
// org_info.
authRoute.get("/auth/me/profile", async (c) => {
  const actor = actorFrom(c);
  const scope = await getUserScope(db, actor.username);
  return c.json({ username: actor.username, subInventoryScopes: scope ?? [] }, 200);
});

authRoute.put("/auth/me/profile", async (c) => {
  const actor = actorFrom(c);
  const body = await readJson<{ subInventoryScopes?: unknown }>(c);
  const scope = parseScopeEntries(body.subInventoryScopes);
  await upsertUserScope(db, actor.username, scope);
  return c.json({ username: actor.username, subInventoryScopes: scope }, 200);
});

authRoute.get("/auth/users/:id", async (c) => {
  const user = await queryGet<UserRow>(
    db,
    sql`SELECT id, username, display_name AS "displayName" FROM users WHERE id = ${c.req.param("id")}`
  );
  if (!user) throw new HTTPException(404, { message: "user not found" });
  return c.json(await toAuthUser(user), 200);
});
