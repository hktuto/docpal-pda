import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryGet } from "./query.js";
import { allocateAll } from "./allocate.js";
import {
  addAllUnboxedToShippingBox,
  closeShippingBox,
  createShippingBox,
  finishPickingOrder,
  reopenShippingBox,
  scanPickingItem,
  updateShippingBox,
  verifyPackage,
} from "./picking.js";
import {
  completeVerifyTask,
  getVerifyTaskDetail,
  lookupVerifyTaskByLabel,
  scanVerifyTaskLabel,
} from "./verify.js";
import { _setFlowStepsDisabledForTests } from "../config.js";

// ---------------------------------------------------------------------------
// Label-aware verify (2026-10-30): label mode per package, carton-label box
// lookup, scan-label, label_item_mismatch, completion gating, reopen resets.
// Fixtures insert label_prints rows directly (print-service success path is
// covered in labelPrintParams.test.ts).
// ---------------------------------------------------------------------------

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

async function reset(): Promise<void> {
  await reseed(client);
  _setFlowStepsDisabledForTests([]);
  await client.db.execute(sql`DELETE FROM label_prints`);
  await client.db.execute(sql`DELETE FROM label_print_rules`);
}

async function actorIdOf(username = "operator"): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = ${username}`);
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

interface Fixture {
  orderId: string;
  actorId: string;
  boxId: string;
  packageIds: string[]; // [p1: RK73H1JTTD1002F qty 1000, p2: RK73H1JTTD2202F qty 500, p3: RK73B1JTTD181G qty 300]
  verifyTaskId: string;
}

/** SO-DEMO-0001 driven through pack + measure + close → pending verify task. */
async function pendingVerifyTask(): Promise<Fixture> {
  const actorId = await actorIdOf();
  await allocateAll(client.db);
  const orderId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM picking_orders WHERE order_no = 'SO-DEMO-0001'`)
  )!.id;
  const itemOf = async (partNo: string) =>
    (await queryGet<{ id: string }>(
      client.db,
      sql`SELECT id FROM picking_items WHERE picking_order_id = ${orderId} AND part_no = ${partNo}`
    ))!.id;
  const allocOf = async (itemId: string) =>
    (await queryGet<{ id: string }>(client.db, sql`SELECT id FROM allocations WHERE picking_item_id = ${itemId}`))!.id;

  const packageIds: string[] = [];
  for (const [partNo, qty] of [["RK73H1JTTD1002F", 1000], ["RK73H1JTTD2202F", 500], ["RK73B1JTTD181G", 300]] as const) {
    const itemId = await itemOf(partNo);
    const { packageIds: ids } = await scanPickingItem(client.db, itemId, {
      actorId,
      allocationId: await allocOf(itemId),
      qty,
    });
    packageIds.push(...ids);
  }
  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  await addAllUnboxedToShippingBox(client.db, { shippingBoxId: box.id, actorId });
  await finishPickingOrder(client.db, { pickingOrderId: orderId, actorId });
  for (const packageId of packageIds) {
    await verifyPackage(client.db, { packageId, actorId });
  }
  await updateShippingBox(client.db, box.id, { actorId, boxSize: "26 X 20 X 20", netWeightKg: 0.5, grossWeightKg: 0.8 });
  await closeShippingBox(client.db, { shippingBoxId: box.id, actorId });
  const vt = (await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM verify_tasks WHERE shipping_box_id = ${box.id}`
  ))!;
  return { orderId, actorId, boxId: box.id, packageIds, verifyTaskId: vt.id };
}

async function insertRule(opts: {
  labelType: "carton" | "item_box" | "item";
  labelSource?: "internal" | "external";
}): Promise<string> {
  const id = randomUUID();
  await client.db.execute(sql`
    INSERT INTO label_print_rules
      (id, name, label_type, conditions, print_template_id, priority, active, label_source)
    VALUES
      (${id}, ${`rule-${id}`}, ${opts.labelType},
       ${JSON.stringify({ combinator: "and", conditions: [{ field: "order_no", operator: "match", value: "SO-DEMO-*" }] })}::jsonb,
       ${`tpl-${id}`}, 100, true, ${opts.labelSource ?? "internal"})
  `);
  return id;
}

/** Insert one print record whose payload rows match the given raw strings. */
async function insertPrint(opts: {
  orderId: string;
  ruleId: string;
  labelType: "carton" | "item_box" | "item";
  rows: { shippingBoxId: string | null; packageId: string | null; raw: string }[];
  printedBy: string;
}): Promise<void> {
  await client.db.execute(sql`
    INSERT INTO label_prints
      (id, picking_order_id, rule_id, label_type, print_template_id, expected_label_count, payload, printed_by, created_date, last_update_date)
    VALUES
      (${randomUUID()}, ${opts.orderId}, ${opts.ruleId}, ${opts.labelType}, 'tpl', ${opts.rows.length},
       ${JSON.stringify(opts.rows.map((r) => ({ shippingBoxId: r.shippingBoxId, packageId: r.packageId, params: { barcode: r.raw } })))}::jsonb,
       ${opts.printedBy}, now(), now())
  `);
}

const CARTON_RAW = "CARTON-RAW-1";
const ITEM_RAW = "ITEM-RAW-1";

/** Fixture + internal carton & item rules + print records (carton → box, item → p1). */
async function labeledFixture(): Promise<Fixture & { cartonRuleId: string; itemRuleId: string }> {
  const fx = await pendingVerifyTask();
  const cartonRuleId = await insertRule({ labelType: "carton" });
  const itemRuleId = await insertRule({ labelType: "item" });
  await insertPrint({
    orderId: fx.orderId,
    ruleId: cartonRuleId,
    labelType: "carton",
    printedBy: fx.actorId,
    rows: [{ shippingBoxId: fx.boxId, packageId: null, raw: CARTON_RAW }],
  });
  await insertPrint({
    orderId: fx.orderId,
    ruleId: itemRuleId,
    labelType: "item",
    printedBy: fx.actorId,
    rows: [{ shippingBoxId: null, packageId: fx.packageIds[0], raw: ITEM_RAW }],
  });
  return { ...fx, cartonRuleId, itemRuleId };
}

// --- detail label mode --------------------------------------------------------

test("detail: packages carry labelMode/labelVerified; box carries cartonLabelRequired/Verified", async () => {
  await reset();
  const fx = await labeledFixture();

  const detail = await getVerifyTaskDetail(client.db, fx.verifyTaskId);
  assert.equal(detail.box.cartonLabelRequired, true);
  assert.equal(detail.box.cartonLabelVerified, false);
  assert.equal(detail.packages.length, 3);
  assert.ok(detail.packages.every((p) => p.labelMode));
  assert.ok(detail.packages.every((p) => !p.labelVerified));

  // External-only order → aggregate mode (labelMode false everywhere).
  await reset();
  const fx2 = await pendingVerifyTask();
  await insertRule({ labelType: "carton", labelSource: "external" });
  const detail2 = await getVerifyTaskDetail(client.db, fx2.verifyTaskId);
  assert.ok(detail2.packages.every((p) => !p.labelMode));
  assert.equal(detail2.box.cartonLabelRequired, false);
});

// --- lookup-by-label ----------------------------------------------------------

test("lookup-by-label: resolves task+box, stamps carton_label_verified, idempotent, 404 on miss", async () => {
  await reset();
  const fx = await labeledFixture();

  const miss = await catchHttp(lookupVerifyTaskByLabel(client.db, { raw: "NOPE", actorId: fx.actorId }));
  assert.equal(miss.status, 404);
  assert.equal(miss.message, "label_print_not_found");

  const hit = await lookupVerifyTaskByLabel(client.db, { raw: CARTON_RAW, actorId: fx.actorId });
  assert.equal(hit.taskId, fx.verifyTaskId);
  assert.equal(hit.shippingBoxId, fx.boxId);
  const box = await queryGet<{ v: boolean; by: string | null }>(
    client.db,
    sql`SELECT carton_label_verified AS v, carton_label_verified_by AS by FROM shipping_boxes WHERE id = ${fx.boxId}`
  );
  assert.equal(box!.v, true);
  assert.equal(box!.by, fx.actorId);

  // Re-scan returns the current state without error.
  const again = await lookupVerifyTaskByLabel(client.db, { raw: CARTON_RAW, actorId: fx.actorId });
  assert.equal(again.taskId, fx.verifyTaskId);
});

// --- scan-label ---------------------------------------------------------------

test("scan-label: item match marks label_verified + expectations; carton match stamps box; 404 miss; idempotent", async () => {
  await reset();
  const fx = await labeledFixture();

  const miss = await catchHttp(
    scanVerifyTaskLabel(client.db, { taskId: fx.verifyTaskId, raw: "NOPE", actorId: fx.actorId })
  );
  assert.equal(miss.status, 404);
  assert.equal(miss.message, "label_print_not_found");

  const item = await scanVerifyTaskLabel(client.db, { taskId: fx.verifyTaskId, raw: ITEM_RAW, actorId: fx.actorId });
  assert.equal(item.kind, "item");
  assert.equal(item.packageId, fx.packageIds[0]);
  assert.equal(item.expectations!.partNo, "RK73H1JTTD1002F");
  assert.equal(item.expectations!.qty, 1000);

  const pkg = await queryGet<{ v: boolean; by: string | null }>(
    client.db,
    sql`SELECT label_verified AS v, label_verified_by AS by FROM picking_packages WHERE id = ${fx.packageIds[0]}`
  );
  assert.equal(pkg!.v, true);
  assert.equal(pkg!.by, fx.actorId);

  // Idempotent re-scan returns the same state.
  const again = await scanVerifyTaskLabel(client.db, { taskId: fx.verifyTaskId, raw: ITEM_RAW, actorId: fx.actorId });
  assert.equal(again.kind, "item");
  assert.equal(again.packageId, fx.packageIds[0]);

  const carton = await scanVerifyTaskLabel(client.db, { taskId: fx.verifyTaskId, raw: CARTON_RAW, actorId: fx.actorId });
  assert.equal(carton.kind, "carton");
  const box = await queryGet<{ v: boolean }>(
    client.db,
    sql`SELECT carton_label_verified AS v FROM shipping_boxes WHERE id = ${fx.boxId}`
  );
  assert.equal(box!.v, true);
});

// --- label_item_mismatch ------------------------------------------------------

test("verifyPackage: label-verified package hard-compares scanned batch fields → 409 label_item_mismatch", async () => {
  await reset();
  const fx = await labeledFixture();
  await scanVerifyTaskLabel(client.db, { taskId: fx.verifyTaskId, raw: ITEM_RAW, actorId: fx.actorId });

  const mismatch = await catchHttp(
    verifyPackage(client.db, { packageId: fx.packageIds[0], actorId: fx.actorId, partNo: "WRONG-PART", coo: "XX" })
  );
  assert.equal(mismatch.status, 409);
  const body = (await mismatch.getResponse().json()) as { error: string; fields: string[] };
  assert.equal(body.error, "label_item_mismatch");
  assert.deepEqual(body.fields.sort(), ["coo", "partNo"]);

  // Matching fields pass and credit the re-scan.
  const detail = await getVerifyTaskDetail(client.db, fx.verifyTaskId);
  const p1 = detail.packages.find((p) => p.id === fx.packageIds[0])!;
  await verifyPackage(client.db, {
    packageId: fx.packageIds[0],
    actorId: fx.actorId,
    partNo: p1.partNo,
    wclItemNo: p1.wclItemNo ?? "",
    coo: p1.scannedCoo ?? p1.coo ?? "",
    dateCode: p1.scannedDateCode ?? p1.dateCode ?? "",
  });

  // A package without label verification skips the compare entirely.
  await verifyPackage(client.db, { packageId: fx.packageIds[1], actorId: fx.actorId, partNo: "IGNORED" });
});

// --- completion gating --------------------------------------------------------

test("complete: labels_not_all_verified until every printed label is scanned; unprinted packages don't block", async () => {
  await reset();
  const fx = await labeledFixture();

  // Qty gate satisfied for all packages (verify re-scan).
  for (const packageId of fx.packageIds) {
    await verifyPackage(client.db, { packageId, actorId: fx.actorId });
  }

  // p1 has an item print record but is not label_verified → held.
  const held1 = await catchHttp(completeVerifyTask(client.db, { taskId: fx.verifyTaskId, actorId: fx.actorId }));
  assert.equal(held1.status, 409);
  assert.equal(held1.message, "labels_not_all_verified");

  await scanVerifyTaskLabel(client.db, { taskId: fx.verifyTaskId, raw: ITEM_RAW, actorId: fx.actorId });

  // Carton print record exists but carton label not scanned → still held.
  const held2 = await catchHttp(completeVerifyTask(client.db, { taskId: fx.verifyTaskId, actorId: fx.actorId }));
  assert.equal(held2.status, 409);
  assert.equal(held2.message, "labels_not_all_verified");

  // p2/p3 have no print rows (unprinted) → they don't block.
  await scanVerifyTaskLabel(client.db, { taskId: fx.verifyTaskId, raw: CARTON_RAW, actorId: fx.actorId });
  await completeVerifyTask(client.db, { taskId: fx.verifyTaskId, actorId: fx.actorId });
  const task = await queryGet<{ status: string }>(
    client.db,
    sql`SELECT status FROM verify_tasks WHERE id = ${fx.verifyTaskId}`
  );
  assert.equal(task!.status, "completed");
});

// --- reopen resets ------------------------------------------------------------

test("reopen: resets label_verified + carton_label_verified alongside existing flags", async () => {
  await reset();
  const fx = await labeledFixture();
  await scanVerifyTaskLabel(client.db, { taskId: fx.verifyTaskId, raw: ITEM_RAW, actorId: fx.actorId });
  await scanVerifyTaskLabel(client.db, { taskId: fx.verifyTaskId, raw: CARTON_RAW, actorId: fx.actorId });

  await reopenShippingBox(client.db, { shippingBoxId: fx.boxId, actorId: fx.actorId });

  const box = await queryGet<{ v: boolean; at: Date | null; by: string | null }>(
    client.db,
    sql`SELECT carton_label_verified AS v, carton_label_verified_at AS at, carton_label_verified_by AS by
        FROM shipping_boxes WHERE id = ${fx.boxId}`
  );
  assert.deepEqual(box, { v: false, at: null, by: null });
  const pkg = await queryGet<{ v: boolean; at: Date | null; by: string | null }>(
    client.db,
    sql`SELECT label_verified AS v, label_verified_at AS at, label_verified_by AS by
        FROM picking_packages WHERE id = ${fx.packageIds[0]}`
  );
  assert.deepEqual(pkg, { v: false, at: null, by: null });
});
