import { describe, it, expect, beforeEach, afterEach } from "node:test";
import type { AppDb } from "../db.js";
import { commitAdHocPutAway, listAdHocPutAwayLocations } from "./adhocPutaway.js";
import { inventoryLots, inventoryTransactions } from "./schema/inventory.js";
import { adHocPutAways } from "./schema/adhocPutaway.js";
import { shelves, parts, subInventories } from "./schema/master.js";
import { eq } from "drizzle-orm";

// Ad-hoc put-away tests (spec 2026-10-07-ad-hoc-put-away-design.md).
// These tests need a real database connection (TEST_DATABASE_URL).

const TEST_SUPPLIER_CODE = "SUP-TEST-001";
const TEST_SHELF_CODE = "A-01-01";
const TEST_PART_NO = "PART-TEST-001";
const TEST_ORG_ID = 2;
const TEST_SUB_INVENTORY = "MAIN";

describe("ad-hoc put-away", () => {
  let db: AppDb;

  beforeEach(async () => {
    // These tests require a database connection. Skip if not available.
    const { getDb } = await import("../db.js");
    db = getDb();

    // Clean up any existing test data
    await db.delete(inventoryTransactions).where(
      eq(inventoryTransactions.referenceType, "ad_hoc_put_away")
    );
    await db.delete(adHocPutAways);
    await db.delete(inventoryLots).where(eq(inventoryLots.partNo, TEST_PART_NO));

    // Ensure test shelf exists
    await db.insert(shelves).values({
      code: TEST_SHELF_CODE,
      zone: "TEST",
    }).onConflictDoNothing();

    // Ensure test part exists
    await db.insert(parts).values({
      id: "part-test-001",
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

  it("commits a single item: creates lot + ledger + audit row", async () => {
    const result = await commitAdHocPutAway(db, {
      supplierCode: TEST_SUPPLIER_CODE,
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
      actorId: "test-actor",
    });

    expect(result.itemCount).toBe(1);
    expect(result.totalQty).toBe(100);
    expect(result.shelfCode).toBe(TEST_SHELF_CODE);

    // Check lot was created
    const lots = await db.select().from(inventoryLots).where(eq(inventoryLots.partNo, TEST_PART_NO));
    expect(lots.length).toBe(1);
    expect(lots[0].totalQty).toBe(100);
    expect(lots[0].shelfCode).toBe(TEST_SHELF_CODE);

    // Check ledger row was created
    const txns = await db.select().from(inventoryTransactions).where(
      eq(inventoryTransactions.referenceType, "ad_hoc_put_away")
    );
    expect(txns.length).toBe(1);
    expect(txns[0].qtyDelta).toBe(100);
    expect(txns[0].txnType).toBe("ADJUST");

    // Check audit row was created
    const audits = await db.select().from(adHocPutAways).where(eq(adHocPutAways.id, result.id));
    expect(audits.length).toBe(1);
    expect(audits[0].itemCount).toBe(1);
    expect(audits[0].totalQty).toBe(100);
  });

  it("merges items with same part+shelf+batch into one lot", async () => {
    const result = await commitAdHocPutAway(db, {
      supplierCode: TEST_SUPPLIER_CODE,
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
      actorId: "test-actor",
    });

    expect(result.itemCount).toBe(2);
    expect(result.totalQty).toBe(80);

    // Should be one lot with combined qty
    const lots = await db.select().from(inventoryLots).where(eq(inventoryLots.partNo, TEST_PART_NO));
    expect(lots.length).toBe(1);
    expect(lots[0].totalQty).toBe(80);
  });

  it("creates separate lots for different batch attributes", async () => {
    const result = await commitAdHocPutAway(db, {
      supplierCode: TEST_SUPPLIER_CODE,
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
      actorId: "test-actor",
    });

    expect(result.itemCount).toBe(2);

    // Should be two lots
    const lots = await db.select().from(inventoryLots).where(eq(inventoryLots.partNo, TEST_PART_NO));
    expect(lots.length).toBe(2);
  });

  it("throws on unknown part", async () => {
    await expect(commitAdHocPutAway(db, {
      supplierCode: TEST_SUPPLIER_CODE,
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
      actorId: "test-actor",
    })).rejects.toThrow("part_not_found:NONEXISTENT-PART");
  });

  it("throws on unknown shelf", async () => {
    await expect(commitAdHocPutAway(db, {
      supplierCode: TEST_SUPPLIER_CODE,
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
      actorId: "test-actor",
    })).rejects.toThrow("shelf_not_found:NONEXISTENT-SHELF");
  });

  it("lists valid locations from org_info", async () => {
    const result = await listAdHocPutAwayLocations(db);
    expect(result.locations.length).toBeGreaterThan(0);
    expect(result.locations[0]).toHaveProperty("orgId");
    expect(result.locations[0]).toHaveProperty("subInventoryCode");
  });
});
