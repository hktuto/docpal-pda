import { sql } from "drizzle-orm";
import { queryAll, type DbOrTx } from "./query.js";

// ---------------------------------------------------------------------------
// Shared box identity + search.
//
// Box ids are `BOX-<kind>-<YYYYMMDD>-<seq>`: kind S = shipping box / H =
// shelf box, seq a per-day counter per kind (zero-padded to 4). Ids survive
// hard deletes (cancel) via their transaction_logs rows — scan both tables so
// a cancelled seq is never reused.
// ---------------------------------------------------------------------------

export type BoxKind = "S" | "H";

const KIND_TABLE: Record<BoxKind, { table: string; entityType: string }> = {
  S: { table: "shipping_boxes", entityType: "shipping_box" },
  H: { table: "shelf_boxes", entityType: "shelf_box" },
};

function localYyyymmdd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export function boxIdPrefix(kind: BoxKind, at: Date = new Date()): string {
  return `BOX-${kind}-${localYyyymmdd(at)}-`;
}

export async function nextBoxId(tx: DbOrTx, kind: BoxKind): Promise<string> {
  const prefix = boxIdPrefix(kind);
  const { table, entityType } = KIND_TABLE[kind];
  const rows = await queryAll<{ id: string }>(
    tx,
    sql`SELECT id FROM ${sql.raw(table)} WHERE id LIKE ${prefix + "%"}
        UNION ALL
        SELECT entity_id AS id FROM transaction_logs
        WHERE entity_type = ${entityType} AND entity_id LIKE ${prefix + "%"}`
  );
  let max = 0;
  for (const r of rows) {
    const n = Number(r.id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

export interface BoxSearchRow {
  kind: "shipping" | "shelf";
  id: string;
  status: string;
  createdDate: Date;
  /** Owning order's number (shipping boxes only; shelf boxes have no order). */
  orderNo: string | null;
}

/** Search both box tables by id substring (a bare seq like `7` or `0007`
 *  matches). Blank q returns the latest 50 boxes across both kinds. */
export async function searchBoxes(db: DbOrTx, q: string): Promise<BoxSearchRow[]> {
  const term = `%${q.trim()}%`;
  const rows = await queryAll<BoxSearchRow>(
    db,
    sql`SELECT * FROM (
          SELECT 'shipping' AS kind, sb.id, sb.status, sb.created_date AS "createdDate",
                 po.order_no AS "orderNo"
          FROM shipping_boxes sb
          LEFT JOIN picking_orders po ON po.id = sb.picking_order_id
          WHERE sb.id ILIKE ${term}
          UNION ALL
          SELECT 'shelf' AS kind, hb.id, hb.status, hb.created_date AS "createdDate",
                 NULL AS "orderNo"
          FROM shelf_boxes hb
          WHERE hb.id ILIKE ${term}
        ) boxes
        ORDER BY boxes."createdDate" DESC
        LIMIT 50`
  );
  return rows;
}
