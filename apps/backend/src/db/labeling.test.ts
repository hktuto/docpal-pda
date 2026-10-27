import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryGet } from "./query.js";
import { allocateAll } from "./allocate.js";
import {
  addAllUnboxedToShippingBox,
  createShippingBox,
  finishLabeling,
  finishPickingOrder,
  getPickingOrderDetail,
  listLabelingOrders,
  overridePickingOrderStatus,
  scanPickingItem,
} from "./picking.js";
import { listMeasuringBoxes } from "./measuring.js";
import { _setFlowStepsDisabledForTests, type FlowStep } from "../config.js";
import type { RuleConditions } from "../routes/admin/crud.js";
import type { UserScopeEntry } from "./user-scope.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

async function reset(disabled: FlowStep[] = []): Promise<void> {
  await reseed(client);
  _setFlowStepsDisabledForTests(disabled);
}

beforeEach(async () => {
  await reset();
  // resetAndReseed does not truncate label_print_rules — clear between tests.
  await client.db.execute(sql`DELETE FROM label_print_rules`);
});

const ORDER_NO = "SO-DEMO-0001";

async function actorIdOf(username = "operator"): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = ${username}`);
  return row!.id;
}

async function orderIdOf(orderNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM picking_orders WHERE order_no = ${orderNo}`);
  return row!.id;
}

async function pickingItemIdOf(orderId: string, partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT pi.id FROM picking_items pi
        WHERE pi.picking_order_id = ${orderId} AND pi.part_no = ${partNo}`
  );
  return row!.id;
}

async function allocationIdOf(pickingItemId: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM allocations WHERE picking_item_id = ${pickingItemId}`);
  return row!.id;
}

async function catchHttp(p: Promise<unknown>): Promise<HTTPException> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof HTTPException, `expected HTTPException, got ${err}`);
    return err;
  }
  assert.fail("expected HTTPException");
}

async function insertRule(opts: {
  name: string;
  labelType: "carton" | "item_box" | "item";
  orderNoGlob?: string;
  active?: boolean;
}): Promise<string> {
  const id = randomUUID();
  const conditions: RuleConditions = {
    combinator: "and",
    conditions: [{ field: "order_no", operator: "match", value: opts.orderNoGlob ?? `${ORDER_NO}*` } as never],
  };
  await client.db.execute(sql`
    INSERT INTO label_print_rules
      (id, name, label_type, conditions, print_template_id, priority, active)
    VALUES
      (${id}, ${opts.name}, ${opts.labelType}, ${JSON.stringify(conditions)}::jsonb,
       ${`tpl-${opts.name}`}, 100, ${opts.active ?? true})
  `);
  return id;
}

interface LabelingState {
  status: string;
  labelingPending: boolean;
  labelingDoneAt: Date | null;
  labelingDoneBy: string | null;
}

async function labelingStateOf(orderId: string): Promise<LabelingState> {
  const row = await queryGet<LabelingState>(
    client.db,
    sql`SELECT status, labeling_pending AS "labelingPending",
               labeling_done_at AS "labelingDoneAt", labeling_done_by AS "labelingDoneBy"
        FROM picking_orders WHERE id = ${orderId}`
  );
  return row!;
}

async function verifyTaskOf(boxId: string): Promise<{ id: string; status: string } | undefined> {
  return queryGet<{ id: string; status: string }>(
    client.db,
    sql`SELECT id, status FROM verify_tasks WHERE shipping_box_id = ${boxId}`
  );
}

/** The seeded pending order driven through pack: allocate → scan all three
 *  items in full → box all (box left OPEN). Returns before the explicit
 *  finish so tests can finish under different configs. */
async function packedOrder(): Promise<{ orderId: string; actorId: string; boxId: string }> {
  const actorId = await actorIdOf();
  await allocateAll(client.db);
  const orderId = await orderIdOf(ORDER_NO);
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F"); // qty 1000
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F"); // qty 500
  const item3 = await pickingItemIdOf(orderId, "RK73B1JTTD181G"); // qty 300
  await scanPickingItem(client.db, item1, { actorId, allocationId: await allocationIdOf(item1), qty: 1000 });
  await scanPickingItem(client.db, item2, { actorId, allocationId: await allocationIdOf(item2), qty: 500 });
  await scanPickingItem(client.db, item3, { actorId, allocationId: await allocationIdOf(item3), qty: 300 });
  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  await addAllUnboxedToShippingBox(client.db, { shippingBoxId: box.id, actorId });
  return { orderId, actorId, boxId: box.id };
}

test("finish with a matching rule + step on: labeling_pending set, no verify task, box held from measuring", async () => {
  const ruleId = await insertRule({ name: "carton", labelType: "carton" });
  const { orderId, actorId, boxId } = await packedOrder();

  // measuring OFF + verify ON: without labeling the finish would spawn the task
  _setFlowStepsDisabledForTests(["measuring"]);
  const result = await finishPickingOrder(client.db, { pickingOrderId: orderId, actorId });
  assert.deepEqual(result, { id: orderId, status: "picking_finished", labelingPending: true });

  const state = await labelingStateOf(orderId);
  assert.equal(state.labelingPending, true);
  assert.equal(state.labelingDoneAt, null);
  assert.equal(state.labelingDoneBy, null);
  assert.equal(await verifyTaskOf(boxId), undefined); // deferred to labeling finish

  const log = await queryGet<{ fromState: string; toState: string; metadata: { ruleIds?: string[] } }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", metadata
        FROM transaction_logs WHERE entity_type = 'picking_order' AND entity_id = ${orderId} AND to_state = 'labeling_pending'`
  );
  assert.equal(log!.fromState, "picking_finished");
  assert.deepEqual(log!.metadata.ruleIds, [ruleId]);

  // measuring ON: the same flag keeps the box out of the measuring queue
  _setFlowStepsDisabledForTests([]);
  const measuring = await listMeasuringBoxes(client.db);
  assert.equal(measuring.some((g) => g.boxes.some((b) => b.boxId === boxId)), false);

  const detail = await getPickingOrderDetail(client.db, orderId);
  assert.equal(detail.labelingPending, true);
  assert.equal(detail.labelingDoneAt, null);
  assert.equal(detail.labelingDoneBy, null);
  assert.equal(detail.labelingDoneByName, null);
});

test("finish with no matching rule: old behavior (flag false, verify task spawned when measuring off)", async () => {
  const { orderId, actorId, boxId } = await packedOrder();
  _setFlowStepsDisabledForTests(["measuring"]);
  const result = await finishPickingOrder(client.db, { pickingOrderId: orderId, actorId });
  assert.deepEqual(result, { id: orderId, status: "picking_finished", labelingPending: false });
  assert.equal((await labelingStateOf(orderId)).labelingPending, false);
  assert.equal((await verifyTaskOf(boxId))!.status, "pending");
});

test("finish with the labeling step disabled: rule matches but the flag stays false", async () => {
  await insertRule({ name: "carton", labelType: "carton" });
  const { orderId, actorId, boxId } = await packedOrder();
  _setFlowStepsDisabledForTests(["measuring", "labeling"]);
  const result = await finishPickingOrder(client.db, { pickingOrderId: orderId, actorId });
  assert.equal(result.labelingPending, false);
  assert.equal((await labelingStateOf(orderId)).labelingPending, false);
  assert.equal((await verifyTaskOf(boxId))!.status, "pending");
});

test("finishLabeling: happy path stamps done at/by and spawns the deferred verify task", async () => {
  await insertRule({ name: "carton", labelType: "carton" });
  const { orderId, actorId, boxId } = await packedOrder();
  _setFlowStepsDisabledForTests(["measuring"]);
  await finishPickingOrder(client.db, { pickingOrderId: orderId, actorId });
  assert.equal(await verifyTaskOf(boxId), undefined);

  const result = await finishLabeling(client.db, { pickingOrderId: orderId, actorId });
  assert.deepEqual(result, { id: orderId, status: "picking_finished", labelingPending: false });

  const state = await labelingStateOf(orderId);
  assert.equal(state.labelingPending, false);
  assert.ok(state.labelingDoneAt);
  assert.equal(state.labelingDoneBy, actorId);
  assert.equal((await verifyTaskOf(boxId))!.status, "pending");

  const detail = await getPickingOrderDetail(client.db, orderId);
  assert.equal(detail.labelingPending, false);
  assert.equal(detail.labelingDoneByName, "Demo Operator");

  const log = await queryGet<{ fromState: string; toState: string; actorId: string | null }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'picking_order' AND entity_id = ${orderId} AND to_state = 'labeling_done'`
  );
  assert.deepEqual(log, { fromState: "labeling_pending", toState: "labeling_done", actorId });

  // idempotent-friendly: a second call 409s
  const again = await catchHttp(finishLabeling(client.db, { pickingOrderId: orderId, actorId }));
  assert.equal(again.status, 409);
  assert.equal(again.message, "labeling_not_pending");
});

test("finishLabeling: 404 unknown order, 409 when not labeling-pending", async () => {
  const actorId = await actorIdOf();
  const notFound = await catchHttp(finishLabeling(client.db, { pickingOrderId: randomUUID(), actorId }));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "picking_order_not_found");

  // finished without any rule → never entered labeling
  const { orderId } = await packedOrder();
  _setFlowStepsDisabledForTests(["measuring"]);
  await finishPickingOrder(client.db, { pickingOrderId: orderId, actorId });
  const notPending = await catchHttp(finishLabeling(client.db, { pickingOrderId: orderId, actorId }));
  assert.equal(notPending.status, 409);
  assert.equal(notPending.message, "labeling_not_pending");
});

/** Hand-built cross-order box: two picking_finished orders, both labeling-
 *  pending, sharing one open box. */
async function crossOrderBox(): Promise<{ orderA: string; orderB: string; boxId: string; actorId: string }> {
  const actorId = await actorIdOf();
  const orderA = randomUUID();
  const orderB = randomUUID();
  const boxId = "BOX-S-LABEL-X1";
  await client.db.execute(sql`INSERT INTO picking_orders (id, order_no, status, labeling_pending, created_date, last_update_date)
      VALUES (${orderA}, 'SO-LABEL-A', 'picking_finished', true, now(), now()),
             (${orderB}, 'SO-LABEL-B', 'picking_finished', true, now(), now())`);
  await client.db.execute(sql`INSERT INTO shipping_boxes (id, picking_order_id, status, created_date, last_update_date)
      VALUES (${boxId}, ${orderA}, 'open', now(), now())`);
  for (const [orderId, itemId, pkgId] of [
    [orderA, randomUUID(), randomUUID()],
    [orderB, randomUUID(), randomUUID()],
  ] as const) {
    await client.db.execute(sql`INSERT INTO picking_items (id, picking_order_id, part_no, qty, picked_qty, line_id, line_number, shipment_number, created_date, last_update_date)
        VALUES (${itemId}, ${orderId}, 'RK73H1JTTD1002F', 10, 10, 9301, 1, 1, now(), now())`);
    await client.db.execute(sql`INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, created_date, last_update_date)
        VALUES (${pkgId}, ${itemId}, ${orderId}, 'inventory_lot', 'label-src', 10, ${boxId}, now(), now())`);
  }
  return { orderA, orderB, boxId, actorId };
}

test("cross-order box: verify task waits for BOTH orders' labeling", async () => {
  const { orderA, orderB, boxId, actorId } = await crossOrderBox();
  _setFlowStepsDisabledForTests(["measuring"]);

  // box held out of the measuring queue while both are labeling-pending
  _setFlowStepsDisabledForTests([]);
  let groups = await listMeasuringBoxes(client.db);
  assert.equal(groups.some((g) => g.boxes.some((b) => b.boxId === boxId)), false);

  _setFlowStepsDisabledForTests(["measuring"]);
  await finishLabeling(client.db, { pickingOrderId: orderA, actorId });
  assert.equal(await verifyTaskOf(boxId), undefined); // orderB still pending

  await finishLabeling(client.db, { pickingOrderId: orderB, actorId });
  assert.equal((await verifyTaskOf(boxId))!.status, "pending");

  _setFlowStepsDisabledForTests([]);
  groups = await listMeasuringBoxes(client.db);
  assert.equal(groups.some((g) => g.boxes.some((b) => b.boxId === boxId)), true);
});

test("admin status override clears labeling_pending (keeps done at/by)", async () => {
  await insertRule({ name: "carton", labelType: "carton" });
  const { orderId, actorId } = await packedOrder();
  await finishPickingOrder(client.db, { pickingOrderId: orderId, actorId });
  assert.equal((await labelingStateOf(orderId)).labelingPending, true);

  const adminId = await actorIdOf("admin");
  await overridePickingOrderStatus(client.db, { orderId, status: "shipped", actorId: adminId });
  const state = await labelingStateOf(orderId);
  assert.equal(state.status, "shipped");
  assert.equal(state.labelingPending, false);
  assert.equal(state.labelingDoneAt, null); // untouched
});

test("listLabelingOrders: only pending rows, shape, live matches, search, paging", async () => {
  const ruleId = await insertRule({ name: "carton", labelType: "carton" });
  const itemRuleId = await insertRule({ name: "item", labelType: "item" });
  const { orderId, actorId } = await packedOrder();
  await finishPickingOrder(client.db, { pickingOrderId: orderId, actorId });

  const { rows, total } = await listLabelingOrders(client.db, {});
  assert.equal(total, 1);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, orderId);
  assert.equal(row.orderNo, ORDER_NO);
  assert.equal(row.itemCount, 3);
  assert.equal(row.totalQty, 1800);
  assert.ok(row.lastUpdateDate);
  assert.deepEqual(
    row.labelMatches.map((m) => m.ruleId).sort(),
    [ruleId, itemRuleId].sort()
  );

  // search hits order_no / misses unknown text
  assert.equal((await listLabelingOrders(client.db, { search: "SO-DEMO" })).total, 1);
  assert.equal((await listLabelingOrders(client.db, { search: "NOPE" })).total, 0);
  // paging: offset past the only row returns no rows (total comes from the
  // returned rows' COUNT(*) OVER(), same convention as listPickingOrders)
  const paged = await listLabelingOrders(client.db, { limit: 50, offset: 1 });
  assert.equal(paged.rows.length, 0);
  assert.equal((await listLabelingOrders(client.db, { limit: 50, offset: 0 })).total, 1);

  // finishing labeling drops the row
  await finishLabeling(client.db, { pickingOrderId: orderId, actorId });
  assert.equal((await listLabelingOrders(client.db, {})).total, 0);
});

test("listLabelingOrders: invoice orders respect the caller's sub-inventory scope", async () => {
  // hand-built invoice order in the seeded order's org/sub-inventory partition
  const seed = await queryGet<{ orgId: number | null; subInventoryCode: string | null }>(
    client.db,
    sql`SELECT org_id AS "orgId", sub_inventory_code AS "subInventoryCode" FROM picking_orders WHERE order_no = ${ORDER_NO}`
  );
  assert.ok(seed!.orgId !== null && seed!.subInventoryCode !== null);
  const orderId = randomUUID();
  await client.db.execute(sql`INSERT INTO picking_orders
      (id, order_no, status, labeling_pending, picking_order_type, org_id, sub_inventory_code, created_date, last_update_date)
      VALUES (${orderId}, 'SO-LABEL-SCOPED', 'picking_finished', true, 'invoice', ${seed!.orgId}, ${seed!.subInventoryCode}, now(), now())`);

  const inScope: UserScopeEntry[] = [{ orgId: seed!.orgId!, code: seed!.subInventoryCode! }];
  const outScope: UserScopeEntry[] = [{ orgId: 999, code: "NOWHERE" }];
  assert.equal((await listLabelingOrders(client.db, { scope: inScope })).total, 1);
  assert.equal((await listLabelingOrders(client.db, { scope: outScope })).total, 0);
  assert.equal((await listLabelingOrders(client.db, { scope: null })).total, 1); // unrestricted
});
