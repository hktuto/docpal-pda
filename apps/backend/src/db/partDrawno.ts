// ---------------------------------------------------------------------------
// NCC drawing-number → part lookup (spec
// 2026-11-03-ncc-drawno-part-lookup-design.md). NCC (Chemi-Con) reel labels
// carry a numeric DRAWING CODE as the template's itemId — never the MPN and
// never the WCL item no — so label scans match no order item until the code
// is resolved through `wcl_part_drawno`, the externally-managed upstream
// drawing→item map (NOT in the Drizzle schema or migrations; raw sql only).
// Resolution is exact-match first, then a substring fallback (some drawno
// values embed the code in a longer string, e.g. `REF#826558`). A drawing
// code can map to several wcl_part_no values — all are returned and the
// caller disambiguates.
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm";
import { queryAll, type DbOrTx } from "./query.js";

export interface DrawnoPartMatch {
  wclItemNo: string;
  partNo: string | null;
}

let warnedMissingTable = false;

/** Tolerate dev databases without the externally-managed table (42P01
 *  undefined_table): warn once and resolve to no matches. */
async function queryDrawno(db: DbOrTx, q: ReturnType<typeof sql>): Promise<DrawnoPartMatch[]> {
  try {
    return await queryAll<DrawnoPartMatch>(db, q);
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        console.warn("wcl_part_drawno table is missing — NCC drawing-number lookup disabled");
      }
      return [];
    }
    throw err;
  }
}

const SELECT = sql`SELECT DISTINCT d.wcl_part_no AS "wclItemNo", p.part_no AS "partNo"
  FROM wcl_part_drawno d
  LEFT JOIN parts p ON p.wcl_item_no = d.wcl_part_no`;

/** Resolve an NCC drawing code to the matching part(s). Exact drawno match
 *  first; a LIKE substring fallback only when the exact match finds nothing.
 *  [] for blank input or no rows. */
export async function lookupPartsByDrawingNo(db: DbOrTx, drawno: string): Promise<DrawnoPartMatch[]> {
  const code = drawno.trim();
  if (!code) return [];
  const exact = await queryDrawno(db, sql`${SELECT} WHERE d.drawno = ${code}`);
  if (exact.length > 0) return exact;
  const pattern = `%${code.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return queryDrawno(db, sql`${SELECT} WHERE d.drawno LIKE ${pattern} ESCAPE '\\'`);
}
