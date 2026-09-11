import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../../db.js";
import { queryAll } from "../../db/query.js";
import {
  getUserScope,
  parseScopeEntries,
  upsertUserScope,
  type UserScopeEntry,
} from "../../db/user-scope.js";
import { groupCodesOf } from "./index.js";

// ---------------------------------------------------------------------------
// Per-user sub-inventory scope profiles (spec
// 2026-09-11-user-subinventory-scope-design.md). GET lists users LEFT JOIN
// user_profiles ([] = unrestricted); PUT upserts a profile by username — the
// users row need not exist yet (pre-provisioning before the first login).
// ---------------------------------------------------------------------------

export const adminUserProfilesRoute = new Hono();

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

adminUserProfilesRoute.get("/", async (c) => {
  const rows = await queryAll<{
    id: string;
    username: string;
    displayName: string;
    scopes: unknown;
  }>(
    db,
    sql`SELECT u.id, u.username, u.display_name AS "displayName",
               up.sub_inventory_scopes AS scopes
        FROM users u
        LEFT JOIN user_profiles up ON up.username = u.username
        ORDER BY u.username`
  );
  const users = await Promise.all(
    rows.map(async (u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      groupCodes: await groupCodesOf(u.id),
      subInventoryScopes: (Array.isArray(u.scopes) ? u.scopes : []) as UserScopeEntry[],
    }))
  );
  return c.json(users);
});

adminUserProfilesRoute.put("/:username", async (c) => {
  const username = c.req.param("username");
  const body = await readJson(c);
  const scope = parseScopeEntries(body.subInventoryScopes);
  await upsertUserScope(db, username, scope);
  const saved = await getUserScope(db, username);
  return c.json({ username, subInventoryScopes: saved ?? [] });
});
