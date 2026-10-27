import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryGet } from "./query.js";
import {
  evaluateLabelPrintConditions,
  globToRegExp,
  resolveLabelPrintRulesForOrder,
  type LabelPrintOrderContext,
} from "./labelPrint.js";
import type { RuleConditions } from "../routes/admin/crud.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

beforeEach(async () => {
  await reseed(client);
  // resetAndReseed does not truncate label_print_rules — clear between tests.
  await client.db.execute(sql`DELETE FROM label_print_rules`);
});

const ORDER_NO = "SO-DEMO-0001";

interface OrderRow {
  id: string;
  orgId: number | null;
  subInventoryCode: string | null;
  orderNo: string;
  pickingOrderType: string | null;
  customerCode: string | null;
}

async function orderRow(): Promise<OrderRow> {
  const row = await queryGet<OrderRow>(
    client.db,
    sql`
      SELECT id, org_id AS "orgId", sub_inventory_code AS "subInventoryCode",
             order_no AS "orderNo", picking_order_type AS "pickingOrderType",
             customer_code AS "customerCode"
      FROM picking_orders WHERE order_no = ${ORDER_NO}
    `
  );
  return row!;
}

async function orderBrands(orderId: string): Promise<string[]> {
  const rows = await queryGet<{ brands: string[] }>(
    client.db,
    sql`
      SELECT COALESCE(array_agg(DISTINCT p.brand), '{}') AS brands
      FROM picking_items pi
      JOIN parts p ON p.wcl_item_no = pi.part_no
      WHERE pi.picking_order_id = ${orderId}
    `
  );
  return rows!.brands;
}

async function insertRule(opts: {
  name: string;
  labelType: "carton" | "item_box" | "item";
  conditions: RuleConditions;
  priority?: number;
  active?: boolean;
  printTemplateId?: string;
}): Promise<string> {
  const id = randomUUID();
  await client.db.execute(sql`
    INSERT INTO label_print_rules
      (id, name, label_type, conditions, print_template_id, priority, active)
    VALUES
      (${id}, ${opts.name}, ${opts.labelType}, ${JSON.stringify(opts.conditions)}::jsonb,
       ${opts.printTemplateId ?? `tpl-${opts.name}`}, ${opts.priority ?? 100}, ${opts.active ?? true})
  `);
  return id;
}

const cond = (field: string, operator: "eq" | "match", value: string) => ({
  field,
  operator,
  value,
});

test("globToRegExp: full-string glob, literals escaped", () => {
  assert.ok(globToRegExp("SO-DEMO-*").test("SO-DEMO-0001"));
  assert.ok(!globToRegExp("SO-DEMO-*").test("XSO-DEMO-0001")); // anchored
  assert.ok(globToRegExp("SO-*-0001").test("SO-DEMO-0001")); // mid-string wildcard
  assert.ok(globToRegExp("a.b").test("a.b")); // dot is literal
  assert.ok(!globToRegExp("a.b").test("axb"));
});

test("evaluateLabelPrintConditions: and vs or combinator", () => {
  const ctx: LabelPrintOrderContext = {
    orgId: 2,
    subInventoryCode: "HK-MAIN",
    orderNo: "SO-DEMO-0001",
    pickingOrderType: "sales",
    customerCode: "CUST1",
    brands: ["KOA"],
  };
  const and = (conds: ReturnType<typeof cond>[]): RuleConditions => ({ combinator: "and", conditions: conds as never });
  const or = (conds: ReturnType<typeof cond>[]): RuleConditions => ({ combinator: "or", conditions: conds as never });
  assert.equal(evaluateLabelPrintConditions(and([cond("order_no", "eq", "SO-DEMO-0001"), cond("customer", "eq", "CUST1")]), ctx), true);
  assert.equal(evaluateLabelPrintConditions(and([cond("order_no", "eq", "SO-DEMO-0001"), cond("customer", "eq", "OTHER")]), ctx), false);
  assert.equal(evaluateLabelPrintConditions(or([cond("order_no", "eq", "NOPE"), cond("customer", "eq", "CUST1")]), ctx), true);
  assert.equal(evaluateLabelPrintConditions(or([cond("order_no", "eq", "NOPE"), cond("customer", "eq", "OTHER")]), ctx), false);
});

test("evaluateLabelPrintConditions: org_id numeric eq, null fields, supplier any-brand", () => {
  const ctx: LabelPrintOrderContext = {
    orgId: 2,
    subInventoryCode: null,
    orderNo: "SO-1",
    pickingOrderType: null,
    customerCode: null,
    brands: ["KOA", "YAGEO"],
  };
  const wrap = (c: ReturnType<typeof cond>): RuleConditions => ({ combinator: "and", conditions: [c] as never });
  assert.equal(evaluateLabelPrintConditions(wrap(cond("org_id", "eq", "2")), ctx), true);
  assert.equal(evaluateLabelPrintConditions(wrap(cond("org_id", "eq", "3")), ctx), false);
  assert.equal(evaluateLabelPrintConditions(wrap(cond("sub_inventory", "match", "*")), ctx), false); // null never matches
  assert.equal(evaluateLabelPrintConditions(wrap(cond("supplier", "eq", "KOA")), ctx), true);
  assert.equal(evaluateLabelPrintConditions(wrap(cond("supplier", "match", "YAG*")), ctx), true);
  assert.equal(evaluateLabelPrintConditions(wrap(cond("supplier", "match", "MUR*")), ctx), false);
});

test("resolveLabelPrintRulesForOrder: first match per label_type, priority order", async () => {
  const o = await orderRow();
  const low = cond("order_no", "match", "SO-DEMO-*");
  const firstCarton = await insertRule({
    name: "carton-first",
    labelType: "carton",
    conditions: { combinator: "and", conditions: [low] as never },
    priority: 10,
  });
  await insertRule({
    name: "carton-second",
    labelType: "carton",
    conditions: { combinator: "and", conditions: [low] as never },
    priority: 20,
  });
  const itemRule = await insertRule({
    name: "item-rule",
    labelType: "item",
    conditions: { combinator: "and", conditions: [low] as never },
    priority: 15,
  });

  const { matches } = await resolveLabelPrintRulesForOrder(client.db, o.id);
  assert.equal(matches.length, 2);
  const byType = Object.fromEntries(matches.map((m) => [m.labelType, m]));
  assert.equal(byType.carton.ruleId, firstCarton);
  assert.equal(byType.carton.printTemplateId, "tpl-carton-first");
  assert.equal(byType.item.ruleId, itemRule);
  assert.equal(byType.item_box, undefined);
});

test("resolveLabelPrintRulesForOrder: inactive rules skipped, eq vs glob", async () => {
  const o = await orderRow();
  await insertRule({
    name: "inactive-glob",
    labelType: "carton",
    conditions: { combinator: "and", conditions: [cond("order_no", "match", "SO-DEMO-*")] as never },
    priority: 1,
    active: false,
  });
  const active = await insertRule({
    name: "active-eq",
    labelType: "carton",
    conditions: { combinator: "and", conditions: [cond("order_no", "eq", ORDER_NO)] as never },
    priority: 50,
  });
  const { matches } = await resolveLabelPrintRulesForOrder(client.db, o.id);
  assert.deepEqual(matches.map((m) => m.ruleId), [active]);
});

test("resolveLabelPrintRulesForOrder: supplier field matches an item brand", async () => {
  const o = await orderRow();
  const brands = await orderBrands(o.id);
  assert.ok(brands.length > 0, "seeded order must have item brands");
  const ruleId = await insertRule({
    name: "by-supplier",
    labelType: "item_box",
    conditions: { combinator: "and", conditions: [cond("supplier", "eq", brands[0])] as never },
  });
  const miss = await insertRule({
    name: "by-supplier-miss",
    labelType: "carton",
    conditions: { combinator: "and", conditions: [cond("supplier", "eq", "NO_SUCH_BRAND")] as never },
  });
  void miss;
  const { matches } = await resolveLabelPrintRulesForOrder(client.db, o.id);
  assert.deepEqual(matches.map((m) => m.ruleId), [ruleId]);
});

test("resolveLabelPrintRulesForOrder: combinator and requires all, or needs one", async () => {
  const o = await orderRow();
  await insertRule({
    name: "and-fail",
    labelType: "carton",
    conditions: {
      combinator: "and",
      conditions: [cond("order_no", "eq", ORDER_NO), cond("customer", "eq", "NOPE")] as never,
    },
    priority: 10,
  });
  const orRule = await insertRule({
    name: "or-hit",
    labelType: "carton",
    conditions: {
      combinator: "or",
      conditions: [cond("order_no", "eq", "NOPE"), cond("order_no", "match", "SO-DEMO-*")] as never,
    },
    priority: 20,
  });
  const { matches } = await resolveLabelPrintRulesForOrder(client.db, o.id);
  assert.deepEqual(matches.map((m) => m.ruleId), [orRule]);
});

test("resolveLabelPrintRulesForOrder: unknown order → 404", async () => {
  try {
    await resolveLabelPrintRulesForOrder(client.db, randomUUID());
    assert.fail("expected HTTPException");
  } catch (err) {
    assert.ok(err instanceof HTTPException);
    assert.equal(err.status, 404);
    assert.equal(err.message, "picking_order_not_found");
  }
});
