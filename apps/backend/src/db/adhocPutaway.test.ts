import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { commitAdHocPutAway, listAdHocPutAwayLocations } from "./adhocPutaway.js";
import { inventoryLots } from "./schema/inventory.js";
import { inventoryTransactions } from "./schema/audit.js";
import { adHocPutAways } from "./schema/adhocPutaway.js";
import { shelves, parts, subInventories } from "./schema/master.js";
import { eq } from "drizzle-orm";

// Ad-hoc put-away tests (spec 2026-10-07-ad-hoc-put-away-design.md).

const TEST_BRAND = "TEST";
const TEST_SHELF_CODE = "A-01-01";
const TEST_PART_NO = "PART-TEST-001";
const TEST_ORG_ID = 2;
const TEST_SUB_INVENTORY = "MAIN";

test("ad-hoc put-away", async () => {
  let client: TestDb;
  let db: TestDb["db"];

  before(async () => {
    client = await setupTestDb();
    db = client.db;
  });

  beforeEach(async () => {
    await reseed(client);

    // Clean up any existing test data
    await db.delete(inventoryTransactions).where(
      eq(inventoryTransactions.referenceType, "ad_hoc_put_away")
    );
    await db.delete(adHocPutAways);
    await db.delete(inventoryLots).where(eq(inventoryLots.partNo, TEST_PART_NO));

    // Ensure test shelf exists
    await db.insert(shelves).values({
      id: "shelf-test-001",
      code: TEST_SHELF_CODE,
      zone: "TEST",
    }).onConflictDoNothing();

    // Ensure test part exists (parts.brand is required in seed)
    await db.insert(parts).values({
      id: "part-test-001",
      brand: "TEST",
      partNo: TEST_PART_NO,
      wclItemNo: "WCL-TEST-001",
      description: "Test part",
    }).onConflictDoNothing();

    // Ensure test sub-inventory exists
    await db.insert(subInventories).values({
      id: "org-test-001",
      orgId: TEST_ORG_ID,
      secondaryInventoryName: TEST_SUB_INVENTORY,
    }).onConflictDoNothing();
  });

  afterEach(async () => {
    // Clean up test data
    await db.delete(inventoryTransactions).where(
      eq(inventoryTransactions.referenceType, "ad_hoc_put_away")
    );
    await db.delete(adHocPutAways);
    await db.delete(inventoryLots).where(eq(inventoryLots.partNo, TEST_PART_NO));
  });

  async function actorId(): Promise<string> {
    const user = await db.execute<{ id: string }>(sql`SELECT id FROM users WHERE username = 'operator'`);
    return Array.from(user)[0]?.id ?? "test-actor";
  }

  await test("commits a single item: creates lot + ledger + audit row", async () => {
    const result = await commitAdHocPutAway(db, {
      brand: TEST_BRAND,
      shelfCode: TEST_SHELF_CODE,
      items: [{
        partNo: TEST_PART_NO,
        wclItemNo: "WCL-TEST-001",
        qty: 100,
        dateCode: "2640",
        lotCode: "LOT-A",
        coo: "CN",
        cow: "CN",
        serialNo: null,
        orgId: TEST_ORG_ID,
        subInventoryCode: TEST_SUB_INVENTORY,
      }],
      actorId: await actorId(),
    });

    assert.equal(result.itemCount, 1);
    assert.equal(result.totalQty, 100);
    assert.equal(result.shelfCode, TEST_SHELF_CODE);

    // Check lot was created
    const lots = await db.select().from(inventoryLots).where(eq(inventoryLots.partNo, TEST_PART_NO));
    assert.equal(lots.length, 1);
    assert.equal(lots[0].totalQty, 100);
    assert.equal(lots[0].shelfCode, TEST_SHELF_CODE);

    // Check ledger row was created
    const txns = await db.select().from(inventoryTransactions).where(
      eq(inventoryTransactions.referenceType, "ad_hoc_put_away")
    );
    assert.equal(txns.length, 1);
    assert.equal(txns[0].qtyDelta, 100);
    assert.equal(txns[0].txnType, "ADJUST");

    // Check audit row was created
    const audits = await db.select().from(adHocPutAways).where(eq(adHocPutAways.id, result.id));
    assert.equal(audits.length, 1);
    assert.equal(audits[0].itemCount, 1);
    assert.equal(audits[0].totalQty, 100);
  });

  await test("merges items with same part+shelf+batch into one lot", async () => {
    const result = await commitAdHocPutAway(db, {
      brand: TEST_BRAND,
      shelfCode: TEST_SHELF_CODE,
      items: [
        {
          partNo: TEST_PART_NO,
          wclItemNo: "WCL-TEST-001",
          qty: 50,
          dateCode: "2640",
          lotCode: "LOT-A",
          coo: "CN",
          cow: "CN",
          serialNo: null,
          orgId: TEST_ORG_ID,
          subInventoryCode: TEST_SUB_INVENTORY,
        },
        {
          partNo: TEST_PART_NO,
          wclItemNo: "WCL-TEST-001",
          qty: 30,
          dateCode: "2640",
          lotCode: "LOT-A",
          coo: "CN",
          cow: "CN",
          serialNo: null,
          orgId: TEST_ORG_ID,
          subInventoryCode: TEST_SUB_INVENTORY,
        },
      ],
      actorId: await actorId(),
    });

    assert.equal(result.itemCount, 2);
    assert.equal(result.totalQty, 80);

    // Should be one lot with combined qty
    const lots = await db.select().from(inventoryLots).where(eq(inventoryLots.partNo, TEST_PART_NO));
    assert.equal(lots.length, 1);
    assert.equal(lots[0].totalQty, 80);
  });

  await test("creates separate lots for different batch attributes", async () => {
    const result = await commitAdHocPutAway(db, {
      brand: TEST_BRAND,
      shelfCode: TEST_SHELF_CODE,
      items: [
        {
          partNo: TEST_PART_NO,
          wclItemNo: "WCL-TEST-001",
          qty: 50,
          dateCode: "2640",
          lotCode: "LOT-A",
          coo: "CN",
          cow: "CN",
          serialNo: null,
          orgId: TEST_ORG_ID,
          subInventoryCode: TEST_SUB_INVENTORY,
        },
        {
          partNo: TEST_PART_NO,
          wclItemNo: "WCL-TEST-001",
          qty: 30,
          dateCode: "2641",
          lotCode: "LOT-B",
          coo: "CN",
          cow: "CN",
          serialNo: null,
          orgId: TEST_ORG_ID,
          subInventoryCode: TEST_SUB_INVENTORY,
        },
      ],
      actorId: await actorId(),
    });

    assert.equal(result.itemCount, 2);

    // Should be two lots
    const lots = await db.select().from(inventoryLots).where(eq(inventoryLots.partNo, TEST_PART_NO));
    assert.equal(lots.length, 2);
  });

  await test("throws on unknown part", async () => {
    await assert.rejects(
      commitAdHocPutAway(db, {
        brand: TEST_BRAND,
        shelfCode: TEST_SHELF_CODE,
        items: [{
          partNo: "NONEXISTENT-PART",
          wclItemNo: null,
          qty: 10,
          dateCode: null,
          lotCode: null,
          coo: null,
          cow: null,
          serialNo: null,
          orgId: TEST_ORG_ID,
          subInventoryCode: TEST_SUB_INVENTORY,
        }],
        actorId: await actorId(),
      }),
      { message: /part_not_found:NONEXISTENT-PART/ }
    );
  });

  await test("throws on unknown shelf", async () => {
    await assert.rejects(
      commitAdHocPutAway(db, {
        brand: TEST_BRAND,
        shelfCode: "NONEXISTENT-SHELF",
        items: [{
          partNo: TEST_PART_NO,
          wclItemNo: null,
          qty: 10,
          dateCode: null,
          lotCode: null,
          coo: null,
          cow: null,
          serialNo: null,
          orgId: TEST_ORG_ID,
          subInventoryCode: TEST_SUB_INVENTORY,
        }],
        actorId: await actorId(),
      }),
      { message: /shelf_not_found:NONEXISTENT-SHELF/ }
    );
  });

  await test("lists valid locations from org_info", async () => {
    const result = await listAdHocPutAwayLocations(db);
    assert.ok(result.locations.length > 0);
    assert.ok("orgId" in result.locations[0]);
    assert.ok("subInventoryCode" in result.locations[0]);
    assert.ok("label" in result.locations[0]);
  });
});
