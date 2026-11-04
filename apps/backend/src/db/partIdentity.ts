// ---------------------------------------------------------------------------
// Parts-master identity lookups for scanned labels. A scanned value may need
// translation before it can hit a parts row at all: TE labels print a
// TRUNCATED MPN (e.g. "1571983-1" for a stored "1-1571983-1" / wrapped
// "AMP(...)") — like NCC's drawing code, the identity is resolved through the
// parts master. Shared by the scan decode (decode/service.ts TE branch), the
// receiving scan-commit item-match retry, and the ad-hoc canonical display.
// ---------------------------------------------------------------------------

import { or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { normalizePartNo } from "../decode/codecs.js";
import { parts } from "./schema/master.js";
import type { DbOrTx } from "./query.js";

/**
 * SQL mirror of normalizePartNo (decode/codecs.ts): whitespace collapsed,
 * uppercased, TE "AMP(<pn>)" / "TE-AMP(<pn>)" unwrapped. Byte-identical to
 * the idx_parts_norm_* expressions (schema/master.ts) so the planner uses
 * the indexes.
 */
export const normPartExpr = (col: AnyPgColumn | SQL) =>
  sql`regexp_replace(upper(regexp_replace(${col}, '\\s', '', 'g')), '^(TE-)?AMP\\((.+)\\)$', '\\2')`;

/**
 * Candidate master rows for a scanned identity, mirroring partDrawno's
 * exact-then-substring rule:
 * 1. normalized equality on part_no (idx_parts_norm_part_no btree, ~1 ms) —
 *    the label's PN is complete, only the stored FORM differs (wrapped);
 * 2. only on miss: `ILIKE '%<scanned>%'` (idx_parts_*_trgm GIN) — the label
 *    truncated the PN.
 * The equality step exists for correctness too: a bare-MPN scan is an exact
 * match, while substring would also drag in sibling parts ("-1" matching
 * "-11"). part_no only — TE labels never print the wcl key itself (the OR on
 * wcl_item_no cost 1.6 s vs 56 ms, measured 2026-11-04).
 */
export async function lookupPartKeyCandidates(
  db: DbOrTx,
  scanned: string
): Promise<{ partNo: string; wclItemNo: string }[]> {
  const needle = normalizePartNo(scanned);
  if (!needle) return [];
  const select = { partNo: parts.partNo, wclItemNo: parts.wclItemNo } as const;
  const exact = await db
    .select(select)
    .from(parts)
    .where(sql`${normPartExpr(parts.partNo)} = ${needle}`)
    .limit(20);
  if (exact.length > 0) return exact;
  return db
    .select(select)
    .from(parts)
    .where(or(
      sql`${parts.partNo} ILIKE ${`%${needle}%`}`,
      sql`${parts.wclItemNo} ILIKE ${`%${needle}%`}`
    ))
    .limit(20);
}

export interface TeIdentity {
  partNo: string;
  wclItemNo: string;
}

/**
 * Resolve the scanned identity to ONE master row:
 * - unique candidate, or several that normalize to the SAME part (dupes):
 *   resolved — business rule from the 2026-11-04 field audit: TE parts are
 *   sometimes stored twice, one row with the "AMP(...)" wrapper and one
 *   without, and TE-/TE+ mirror the wcl keys; prefer the AMP-wrapped row,
 *   else take the first;
 * - order `targets` pick exactly one candidate → that one wins outright;
 * - candidates that normalize to DIFFERENT parts (truncated "1571983-1"
 *   matching both "-1" and "-11") and no target disambiguation → null: the
 *   parsed label values stand rather than mis-receipting onto a sibling.
 */
export async function resolveTeIdentity(
  db: DbOrTx,
  scanned: string,
  targets?: string[]
): Promise<TeIdentity | null> {
  const cands = await lookupPartKeyCandidates(db, scanned);
  if (cands.length === 0) return null;
  let picked = cands;
  if (cands.length > 1 && targets?.length) {
    const norms = new Set(targets.map(normalizePartNo));
    const onOrder = cands.filter(
      (r) => norms.has(normalizePartNo(r.partNo)) || norms.has(normalizePartNo(r.wclItemNo))
    );
    if (onOrder.length === 1) return { partNo: onOrder[0].partNo, wclItemNo: onOrder[0].wclItemNo };
    if (onOrder.length > 1) picked = onOrder;
  }
  if (new Set(picked.map((r) => normalizePartNo(r.partNo))).size > 1) return null;
  const row = picked.find((r) => r.partNo.includes("AMP(")) ?? picked[0];
  const wcls = [...new Set(picked.map((r) => r.wclItemNo))];
  return { partNo: row.partNo, wclItemNo: wcls.length === 1 ? wcls[0] : row.wclItemNo };
}
