// ---------------------------------------------------------------------------
// Custom Print Label (A4-LWXY) CSV line enrichment: (單號, 物料號) → Oracle
// CUST_ITEM_NUMBER + part description, batched for the whole upload.
// Chain: picking_orders.order_no → customer_code (by convention a
// customer_accounts.party_name) → account_number → mtl_cross_references
// (description = account_number AND inv_item_concat_segs = 物料號) →
// cross_reference = the label's CUST_ITEM_NUMBER. Description comes from
// parts (wcl_item_no = 物料號). mtl_cross_references is externally-managed
// upstream (like wcl_part_drawno — NOT in the Drizzle schema or migrations;
// raw sql only, missing-table tolerant).
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm";
import { queryAll, type DbOrTx } from "./query.js";

export interface CustItemLookupLine {
  /** CSV 單號 (picking_orders.order_no). */
  orderNo: string;
  /** CSV 物料號 (mtl_cross_references.inv_item_concat_segs / parts.wcl_item_no). */
  wclItemNo: string;
}

export interface CustItemLookupResult extends CustItemLookupLine {
  /** mtl_cross_references.cross_reference; null when any hop of the chain misses. */
  custItemNumber: string | null;
  /** parts.part_no for wcl_item_no = 物料號; null when no part row. */
  partNo: string | null;
  /** parts.description for wcl_item_no = 物料號; null when no part row. */
  itemDescription: string | null;
  /** MOQ number parsed from the description's `MOQ=xxx` text; null when absent. */
  moq: number | null;
  /** picking_orders.delivery_date as YYYY-MM-DD; null when the order row misses. */
  deliveryDate: string | null;
}

/** Descriptions usually carry the minimum order quantity as `MOQ=xxx`. */
export function extractMoq(description: string | null): number | null {
  const m = description?.match(/MOQ\s*=\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

interface CrossRefRow {
  accountNumber: string;
  wclItemNo: string;
  custItemNumber: string;
}

let warnedMissingTable = false;

/** Tolerate dev databases without the externally-managed table (42P01
 *  undefined_table): warn once and resolve to no matches. */
async function queryCrossRefs(
  db: DbOrTx,
  pairs: { accountNumber: string; wclItemNo: string }[]
): Promise<CrossRefRow[]> {
  const pairList = sql.join(pairs.map((p) => sql`(${p.accountNumber}, ${p.wclItemNo})`), sql`, `);
  try {
    return await queryAll<CrossRefRow>(
      db,
      sql`SELECT description AS "accountNumber", inv_item_concat_segs AS "wclItemNo",
                 cross_reference::text AS "custItemNumber"
          FROM mtl_cross_references
          WHERE (description, inv_item_concat_segs) IN (${pairList})`
    );
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        console.warn("mtl_cross_references table is missing — CUST_ITEM_NUMBER lookup disabled");
      }
      return [];
    }
    throw err;
  }
}

const PAIR_SEP = String.fromCharCode(0);

/** Resolve every line in one pass (4 batched queries total); echoes the
 *  input lines back in order, trimmed. */
export async function lookupCustItems(db: DbOrTx, rawLines: CustItemLookupLine[]): Promise<CustItemLookupResult[]> {
  const lines = rawLines.map((l) => ({ orderNo: l.orderNo.trim(), wclItemNo: l.wclItemNo.trim() }));

  // 1. 單號 → customer_code + delivery_date. order_no is not unique (upstream
  //    sync dedups on id); MIN keeps the pick deterministic across duplicate
  //    rows. delivery_date is cast to text for a clean YYYY-MM-DD.
  const customerByOrder = new Map<string, string>();
  const deliveryByOrder = new Map<string, string | null>();
  const orderNos = [...new Set(lines.map((l) => l.orderNo).filter(Boolean))];
  if (orderNos.length > 0) {
    const rows = await queryAll<{ orderNo: string; customerCode: string | null; deliveryDate: string | null }>(
      db,
      sql`SELECT order_no AS "orderNo", MIN(customer_code) AS "customerCode",
                 MIN(delivery_date)::date::text AS "deliveryDate"
          FROM picking_orders
          WHERE order_no IN (${sql.join(orderNos.map((v) => sql`${v}`), sql`, `)})
          GROUP BY order_no`
    );
    for (const r of rows) {
      deliveryByOrder.set(r.orderNo, r.deliveryDate);
      if (r.customerCode) customerByOrder.set(r.orderNo, r.customerCode);
    }
  }

  // 2. customer_code (= party_name by convention) → account_number. A party
  //    can hold several accounts; MIN is deterministic.
  const accountByParty = new Map<string, string>();
  const partyNames = [...new Set(customerByOrder.values())];
  if (partyNames.length > 0) {
    const rows = await queryAll<{ partyName: string; accountNumber: string }>(
      db,
      sql`SELECT party_name AS "partyName", MIN(account_number) AS "accountNumber"
          FROM customer_accounts
          WHERE party_name IN (${sql.join(partyNames.map((v) => sql`${v}`), sql`, `)})
          GROUP BY party_name`
    );
    for (const r of rows) accountByParty.set(r.partyName, r.accountNumber);
  }

  const accountOf = (l: CustItemLookupLine) => accountByParty.get(customerByOrder.get(l.orderNo) ?? "");

  // 3. (account_number, 物料號) → cross_reference_id in mtl_cross_references.
  const custItemByPair = new Map<string, string>();
  const pairs = new Map<string, { accountNumber: string; wclItemNo: string }>();
  for (const l of lines) {
    const accountNumber = accountOf(l);
    if (accountNumber && l.wclItemNo) {
      pairs.set(`${accountNumber}${PAIR_SEP}${l.wclItemNo}`, { accountNumber, wclItemNo: l.wclItemNo });
    }
  }
  if (pairs.size > 0) {
    for (const r of await queryCrossRefs(db, [...pairs.values()])) {
      const key = `${r.accountNumber}${PAIR_SEP}${r.wclItemNo}`;
      if (!custItemByPair.has(key)) custItemByPair.set(key, r.custItemNumber);
    }
  }

  // 4. 物料號 = parts.wcl_item_no → part_no + description (wcl_item_no is the
  //    unique business key, so no grouping needed).
  const partByWcl = new Map<string, { partNo: string; itemDescription: string | null }>();
  const wclItemNos = [...new Set(lines.map((l) => l.wclItemNo).filter(Boolean))];
  if (wclItemNos.length > 0) {
    const rows = await queryAll<{ wclItemNo: string; partNo: string; itemDescription: string | null }>(
      db,
      sql`SELECT wcl_item_no AS "wclItemNo", part_no AS "partNo", description AS "itemDescription"
          FROM parts
          WHERE wcl_item_no IN (${sql.join(wclItemNos.map((v) => sql`${v}`), sql`, `)})`
    );
    for (const r of rows) partByWcl.set(r.wclItemNo, r);
  }

  return lines.map((l) => {
    const accountNumber = accountOf(l);
    const part = partByWcl.get(l.wclItemNo);
    return {
      orderNo: l.orderNo,
      wclItemNo: l.wclItemNo,
      custItemNumber:
        accountNumber && l.wclItemNo ? custItemByPair.get(`${accountNumber}${PAIR_SEP}${l.wclItemNo}`) ?? null : null,
      partNo: part?.partNo ?? null,
      itemDescription: part?.itemDescription ?? null,
      moq: extractMoq(part?.itemDescription ?? null),
      deliveryDate: deliveryByOrder.get(l.orderNo) ?? null,
    };
  });
}
