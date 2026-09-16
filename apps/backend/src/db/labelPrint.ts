import { sql, type SQL } from "drizzle-orm";
import { queryAll, type DbOrTx } from "./query.js";
import type { RuleCondition, RuleConditions } from "../routes/admin/crud.js";

// ---------------------------------------------------------------------------
// Label-print rule evaluation (spec 2026-09-16-label-print-rules-design).
// Evaluates a rule's draft conditions against picking_orders for the admin
// test-match preview; the web picking printing flow will reuse this module.
// LIKE semantics match poNoGlobTest (src/db/receiving.ts): full-string,
// case-sensitive, `*` = any run; Postgres LIKE is implicitly full-string and
// case-sensitive. `match` predicates escape `%`/`_`/`\` in literals and use
// backslash as the LIKE escape.
// ---------------------------------------------------------------------------

function globToLike(pattern: string): string {
  return pattern.replace(/[\\%_]/g, (m) => `\\${m}`).replaceAll("*", "%");
}

function valuePred(column: SQL, cond: RuleCondition): SQL {
  return cond.operator === "eq"
    ? sql`${column} = ${cond.value}`
    : sql`${column} LIKE ${globToLike(cond.value)} ESCAPE '\\'`;
}

function conditionPred(cond: RuleCondition): SQL {
  switch (cond.field) {
    case "org_id":
      return cond.operator === "eq"
        ? sql`po.org_id = ${Number(cond.value)}`
        : sql`po.org_id::text LIKE ${globToLike(cond.value)} ESCAPE '\\'`;
    case "sub_inventory":
      return valuePred(sql`po.sub_inventory_code`, cond);
    case "order_no":
      return valuePred(sql`po.order_no`, cond);
    case "order_type":
      return valuePred(sql`po.picking_order_type`, cond);
    case "customer":
      return valuePred(sql`po.customer_code`, cond);
    case "supplier":
      // An order matches when ANY item's part brand matches; picking_items
      // .part_no stores the WCL item no (join convention per picking.ts).
      return sql`EXISTS (
        SELECT 1 FROM picking_items pi
        JOIN parts p ON p.wcl_item_no = pi.part_no
        WHERE pi.picking_order_id = po.id AND ${valuePred(sql`p.brand`, cond)}
      )`;
  }
}

export interface LabelPrintMatchRow {
  id: string;
  orderNo: string;
  poNo: string | null;
  customerCode: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  pickingOrderType: string | null;
  status: string;
}

export async function testLabelPrintRuleMatch(
  db: DbOrTx,
  conditions: RuleConditions,
  keyword?: string,
  limit?: number
): Promise<{ rows: LabelPrintMatchRow[]; total: number }> {
  const joiner = conditions.combinator === "or" ? sql` OR ` : sql` AND `;
  const preds = conditions.conditions.map(conditionPred);
  const where: SQL[] = [sql`(${sql.join(preds, joiner)})`];
  const kw = keyword?.trim();
  if (kw) {
    where.push(sql`(po.order_no ILIKE ${`%${kw}%`} OR po.po_no ILIKE ${`%${kw}%`})`);
  }
  const capped = Math.min(200, Math.max(1, limit ?? 50));
  const rows = await queryAll<LabelPrintMatchRow & { total: number }>(
    db,
    sql`
      SELECT
        po.id, po.order_no AS "orderNo", po.po_no AS "poNo",
        po.customer_code AS "customerCode", po.org_id AS "orgId",
        po.sub_inventory_code AS "subInventoryCode",
        po.picking_order_type AS "pickingOrderType", po.status,
        COUNT(*) OVER ()::int AS "total"
      FROM picking_orders po
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY po.priority_seq ASC
      LIMIT ${capped}
    `
  );
  const total = rows[0]?.total ?? 0;
  return { rows: rows.map(({ total: _total, ...row }) => row), total };
}
