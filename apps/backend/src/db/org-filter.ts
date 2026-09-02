// Org-partition filter (spec 2026-09-01-flow-config-allowed-org-ids-design.md).
// When flow config allowedOrgIds is non-empty, PDA-facing list/detail queries
// hide rows whose org_id is not in the list (NULL org_id excluded too).

import { inArray, sql, type SQL } from "drizzle-orm";
import { allowedOrgIds } from "../config.js";

/**
 * Bare `<column> IN (...)` condition for the active allowedOrgIds, or
 * undefined when [] (= all orgs, no filtering).
 */
export function allowedOrgCondition(column: SQL): SQL | undefined {
  const orgs = allowedOrgIds();
  return orgs.length ? inArray(column, orgs) : undefined;
}

/** `AND <column> IN (...)` fragment for interpolation after a WHERE, or empty. */
export function allowedOrgFilter(column: SQL): SQL {
  const cond = allowedOrgCondition(column);
  return cond ? sql`AND ${cond}` : sql``;
}
