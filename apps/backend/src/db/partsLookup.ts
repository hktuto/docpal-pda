import { sql } from "drizzle-orm";
import { queryAll } from "./query.js";
import type { AppDb } from "../db.js";
import { normalizePartNo } from "../decode/codecs.js";

// Batch parts-master existence/brand lookup for the CN excel upload — the
// verify table mounts one combobox per item row (1xx+ rows), so per-row
// GET /admin/parts queries stall the submit; the client batches keys here
// and caches results. (See apps/admin/composables/usePartsBrandCheck.ts.)

/** Same normalization as receivingCn.unwrappedPartCol + the parts expression
 *  indexes (migrations 0051/0052) — the whitespace-stripped, uppercased,
 *  TE-AMP-unwrapped key. Kept as a local copy so this module stands alone. */
const unwrappedPartCol = (col: unknown) =>
  sql`regexp_replace(upper(regexp_replace(${col}, '\\s', '', 'g')), '^(TE-)?AMP\\((.+)\\)$', '\\2')`;

export interface PartsKeyMatch {
  /** Echoes the trimmed input key. */
  key: string;
  /** True when exactly ONE (part_no, wcl_item_no) group matches — same
   *  uniqueness rule as resolvePartByKey; an unknown or ambiguous key is
   *  false so callers never trust a brand from a non-unique hit. */
  found: boolean;
  /** The matched row's brand; null when not found. */
  brand: string | null;
}

/** Resolve many part keys in one query (either parts column, canonical
 *  normalize/unwrap); echoes the input keys back in order. */
export async function lookupPartKeys(db: AppDb, rawKeys: string[]): Promise<PartsKeyMatch[]> {
  const keys = [...new Set(rawKeys.map((k) => k.trim()).filter(Boolean))];
  if (keys.length === 0) return [];
  const normKeys = [...new Set(keys.map(normalizePartNo))];
  const keyList = sql.join(normKeys.map((k) => sql`${k}`), sql`, `);
  const rows = await queryAll<{ npn: string; nwcl: string; partNo: string; wclItemNo: string; brand: string }>(
    db,
    sql`SELECT ${unwrappedPartCol(sql`part_no`)} AS npn,
               ${unwrappedPartCol(sql`wcl_item_no`)} AS nwcl,
               part_no AS "partNo", wcl_item_no AS "wclItemNo", MAX(brand) AS brand
        FROM parts
        WHERE ${unwrappedPartCol(sql`part_no`)} IN (${keyList})
           OR ${unwrappedPartCol(sql`wcl_item_no`)} IN (${keyList})
        GROUP BY npn, nwcl, part_no, wcl_item_no`
  );
  return keys.map((key) => {
    const k = normalizePartNo(key);
    const groups = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      if (r.npn === k || r.nwcl === k) groups.set(`${r.partNo}\u0000${r.wclItemNo}`, r);
    }
    const one = groups.size === 1 ? [...groups.values()][0] : null;
    return { key, found: one !== null, brand: one?.brand ?? null };
  });
}
