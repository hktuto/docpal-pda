// ---------------------------------------------------------------------------
// Parts-master detail lookup for the public part-details API
// (POST /scan/part-details, open-path since 2026-11-18 alongside the other
// /scan/* external-system endpoints — docs/backend/scan-decode-api.md).
// An external system holding a part_no / wcl_item_no (e.g. from our receiving
// data) resolves it to the master row(s): identity, brand, description, MOQ.
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm";
import { normalizePartNo } from "../decode/codecs.js";
import { normPartExpr } from "./partIdentity.js";
import { parts } from "./schema/master.js";
import { queryAll, type DbOrTx } from "./query.js";

export interface PartDetailRow {
  id: string;
  partNo: string;
  wclItemNo: string;
  brand: string;
  description: string | null;
  /** numeric column — serialized as a decimal string (null when unset). */
  moq: string | null;
}

export type PartDetailQuery = { partNo: string } | { wclItemNo: string };

/** Exact parts-master lookup by ONE business key:
 * - normalized equality (whitespace collapsed, uppercased, TE "AMP(...)" /
 *   "TE-AMP(...)" unwrapped — normPartExpr mirrors the idx_parts_norm_*
 *   expression indexes, same canonical rule as the scan identity lookup);
 * - NO substring fallback — a detail API must never return sibling parts;
 * - part_no is NOT unique: a partNo query returns EVERY distinct master row
 *   sharing it (one part can sit under several wcl keys); wcl_item_no is the
 *   business key; upstream-synced remotes carry duplicate rows per key with
 *   identical content, so GROUP BY (part_no, wcl_item_no) collapses them —
 *   the same MIN() rationale as partsMasterByWcl. */
export async function lookupPartDetails(db: DbOrTx, query: PartDetailQuery): Promise<PartDetailRow[]> {
  const raw = "partNo" in query ? query.partNo : query.wclItemNo;
  const needle = normalizePartNo(raw);
  if (!needle) return [];
  const col = "partNo" in query ? parts.partNo : parts.wclItemNo;
  return queryAll<PartDetailRow>(
    db,
    sql`SELECT MIN(id) AS id, part_no AS "partNo", wcl_item_no AS "wclItemNo",
               MIN(brand) AS brand, MIN(description) AS description, MIN(moq) AS moq
        FROM parts
        WHERE ${normPartExpr(col)} = ${needle}
        GROUP BY part_no, wcl_item_no
        ORDER BY wcl_item_no ASC, part_no ASC`
  );
}
