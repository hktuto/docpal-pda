// Per-user sub-inventory scope filter (spec
// 2026-09-11-user-subinventory-scope-design.md). A user with a scope only
// sees picking/receiving rows stamped with one of the listed
// (org_id, sub_inventory_code) pairs. A NULL sub_inventory_code (freshly
// synced rows are unstamped) acts as "every sub-inventory of that row's
// org_id": visible when the scope covers ANY sub-inventory under the row's
// org. NULL/empty scope = unrestricted.
// Composes with allowedOrgIds by AND.

import { sql, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { newId } from "./id.js";
import { queryAll, queryGet } from "./query.js";

export interface UserScopeEntry {
  orgId: number;
  code: string;
}

/** The user's scope from user_profiles; null = no row / NULL / empty /
 *  malformed jsonb (unrestricted). */
export async function getUserScope(db: AppDb, username: string): Promise<UserScopeEntry[] | null> {
  const row = await queryGet<{ scopes: unknown }>(
    db,
    sql`SELECT sub_inventory_scopes AS scopes FROM user_profiles WHERE username = ${username}`
  );
  return normalizeScope(row?.scopes);
}

/** Defensive jsonb normalization: anything that is not an array of valid
 *  entries collapses to null (unrestricted). */
function normalizeScope(raw: unknown): UserScopeEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const entries = raw.filter(
    (e): e is UserScopeEntry =>
      typeof e === "object" && e !== null &&
      Number.isInteger((e as UserScopeEntry).orgId) &&
      typeof (e as UserScopeEntry).code === "string" && (e as UserScopeEntry).code !== ""
  );
  return entries.length ? entries : null;
}

/**
 * Scope match: exact `(org, sub)` pair, or — when `sub` is NULL — the row's
 * org having ANY sub-inventory in the scope (unstamped rows act as
 * all-sub-inventories of their org). Returns undefined when scope is
 * null/empty (= no filtering).
 */
export function userScopeCondition(
  orgCol: SQL,
  subCol: SQL,
  scope: UserScopeEntry[] | null | undefined
): SQL | undefined {
  if (!scope || scope.length === 0) return undefined;
  const pairs = sql.join(
    scope.map((e) => sql`(${e.orgId}, ${e.code})`),
    sql`, `
  );
  const orgIds = sql.join(
    [...new Set(scope.map((e) => e.orgId))].map((id) => sql`${id}`),
    sql`, `
  );
  return sql`((${subCol} IS NOT NULL AND (${orgCol}, ${subCol}) IN (${pairs}))
              OR (${subCol} IS NULL AND ${orgCol} IN (${orgIds})))`;
}

/** `AND <condition>` fragment for interpolation after a WHERE, or empty. */
export function userScopeFilter(
  orgCol: SQL,
  subCol: SQL,
  scope: UserScopeEntry[] | null | undefined
): SQL {
  const cond = userScopeCondition(orgCol, subCol, scope);
  return cond ? sql`AND ${cond}` : sql``;
}

/**
 * Order-level scope for receiving_orders: visible when the order has NO
 * items, or ANY item in scope (exact pair, or NULL-sub item whose org is
 * covered by the scope). `AND ...` fragment, or empty when unrestricted.
 */
export function receivingOrderScopeFilter(
  orderIdCol: SQL,
  scope: UserScopeEntry[] | null | undefined
): SQL {
  const cond = userScopeCondition(sql`rii2.org_id`, sql`rii2.sub_inventory_code`, scope);
  if (!cond) return sql``;
  const itemsOf = sql`FROM receiving_invoices inv2
    JOIN receiving_invoice_items rii2 ON rii2.receiving_invoice_id = inv2.id
    WHERE inv2.receiving_order_id = ${orderIdCol}`;
  return sql`AND (NOT EXISTS (SELECT 1 ${itemsOf}) OR EXISTS (SELECT 1 ${itemsOf} AND ${cond}))`;
}

/** Body validation for the profile PUTs: subInventoryScopes must be an array
 *  of `{ orgId: integer, code: non-empty string }`. Missing/[] clears the
 *  scope (stored as-is; the reader treats [] as unrestricted). */
export function parseScopeEntries(input: unknown): UserScopeEntry[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new HTTPException(400, { message: "subInventoryScopes must be an array" });
  }
  const bad = input.some(
    (e) =>
      typeof e !== "object" || e === null ||
      !Number.isInteger((e as UserScopeEntry).orgId) ||
      typeof (e as UserScopeEntry).code !== "string" || (e as UserScopeEntry).code === ""
  );
  if (bad) {
    throw new HTTPException(400, { message: "subInventoryScopes entries must be { orgId: integer, code: string }" });
  }
  return input as UserScopeEntry[];
}

/** Every scope pair must exist in org_info, else 400 unknown_sub_inventory
 *  with the bad pairs listed. */
export async function assertScopeSubInventoriesExist(db: AppDb, scope: UserScopeEntry[]): Promise<void> {
  if (scope.length === 0) return;
  const pairs = sql.join(
    scope.map((e) => sql`(${e.orgId}, ${e.code})`),
    sql`, `
  );
  const known = await queryAll<{ orgId: number; code: string }>(
    db,
    sql`SELECT org_id AS "orgId", secondary_inventory_name AS code FROM org_info
        WHERE (org_id, secondary_inventory_name) IN (${pairs})`
  );
  const knownKeys = new Set(known.map((r) => `${r.orgId}${r.code}`));
  const unknown = scope.filter((e) => !knownKeys.has(`${e.orgId}${e.code}`));
  if (unknown.length) {
    throw new HTTPException(400, {
      message: `unknown_sub_inventory: ${unknown.map((e) => `${e.orgId}/${e.code}`).join(", ")}`,
    });
  }
}

/** Upsert user_profiles by username (pre-provisioning allowed — the users
 *  row need not exist). Returns the stored scope as-is. */
export async function upsertUserScope(
  db: AppDb,
  username: string,
  scope: UserScopeEntry[]
): Promise<UserScopeEntry[]> {
  await assertScopeSubInventoriesExist(db, scope);
  await db.execute(sql`
    INSERT INTO user_profiles (id, username, sub_inventory_scopes, created_date, last_update_date)
    VALUES (${newId()}, ${username}, ${JSON.stringify(scope)}, now(), now())
    ON CONFLICT (username) DO UPDATE
    SET sub_inventory_scopes = EXCLUDED.sub_inventory_scopes, last_update_date = now()
  `);
  return scope;
}
