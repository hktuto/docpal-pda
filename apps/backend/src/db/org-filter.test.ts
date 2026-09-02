// allowedOrgIds org-partition filter (spec
// 2026-09-01-flow-config-allowed-org-ids-design.md). The demo seed world is
// all org 2, so [2] must match the unfiltered result and [99] must hide
// everything. Covers the two representative query shapes (aggregate list with
// optional filters, single-row detail); every other filtered query uses the
// same allowedOrgFilter fragment.

import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryGet, queryRun } from "./query.js";
import { listPickingOrders, getPickingOrderDetail } from "./picking.js";
import { searchStock } from "./stocksearch.js";
import { _setAllowedOrgIdsForTests, _resetFlowConfigForTests } from "../config.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

afterEach(() => {
  _resetFlowConfigForTests();
});

test("picking orders: list + detail are scoped to allowedOrgIds", async () => {
  await reseed(client);

  const all = await listPickingOrders(client.db);
  assert.ok(all.length > 0);
  const orderId = all[0].id;
  assert.equal(all[0].orgId, 2); // demo world sanity check

  _setAllowedOrgIdsForTests([2, 3]);
  assert.equal((await listPickingOrders(client.db)).length, all.length);
  const detail = await getPickingOrderDetail(client.db, orderId);
  assert.equal(detail.id, orderId);

  _setAllowedOrgIdsForTests([99]);
  assert.equal((await listPickingOrders(client.db)).length, 0);
  await assert.rejects(getPickingOrderDetail(client.db, orderId), /picking_order_not_found/);
});

test("stock search: lots are scoped to allowedOrgIds", async () => {
  await reseed(client);
  // The demo seed currently leaves inventory_lots.wcl_item_no blank (a
  // pre-existing seed drift — searchStock joins parts on it), so backfill it
  // here to exercise the org filter against visible lots.
  await queryRun(client.db, sql`UPDATE inventory_lots SET wcl_item_no = part_no`);

  const all = await searchStock(client.db, {});
  assert.equal(all.lots.length, 6);

  _setAllowedOrgIdsForTests([2]);
  assert.equal((await searchStock(client.db, {})).lots.length, 6);

  _setAllowedOrgIdsForTests([99]);
  const scoped = await searchStock(client.db, {});
  assert.equal(scoped.lots.length, 0);
  assert.equal(scoped.parts.length, 0);
});

test("receiving orders list: scoped to allowedOrgIds (route SQL)", async () => {
  await reseed(client);

  const count = async () =>
    (
      await queryGet<{ n: number }>(
        client.db,
        sql`SELECT COUNT(*)::int AS n FROM receiving_orders`
      )
    )!.n;
  assert.ok((await count()) > 0); // seed has receiving orders

  // The route composes the same allowedOrgFilter fragment; exercise it
  // directly against the table to keep this suite db-layer only.
  const { allowedOrgFilter } = await import("./org-filter.js");
  const visible = async () =>
    (
      await queryGet<{ n: number }>(
        client.db,
        sql`SELECT COUNT(*)::int AS n FROM receiving_orders ro WHERE TRUE ${allowedOrgFilter(sql`ro.org_id`)}`
      )
    )!.n;

  assert.equal(await visible(), await count()); // [] = all
  _setAllowedOrgIdsForTests([2]);
  assert.equal(await visible(), await count());
  _setAllowedOrgIdsForTests([99]);
  assert.equal(await visible(), 0);
});
