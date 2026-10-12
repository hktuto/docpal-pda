import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { previewShelfExchange, commitShelfExchange } from "./shelfExchange.js";
import { inventoryLots } from "./schema/inventory.js";
import { inventoryTransactions } from "./schema/audit.js";
import { shelfExchanges } from "./schema/shelfExchange.js";
import { shelves, parts, subInventories } from "./schema/master.js";
import { eq } from "drizzle-orm";

// Shelf exchange tests (spec 2026-10-12-shelf-exchange-design.md).

const SOURCE_SHELF = "SX-A-01";
const TARGET_SHELF = "SX-B-01";
const TEST_PART_NO = "PART-SX-001";
const TEST_WCL_ITEM_NO = "WCL-SX-001";
const TEST_ORG_ID = 2;
const TEST_SUB_INVENTORY = "MAIN";

let client: TestDb;
let db: TestDb["db"];

async function actorId(): Promise<string> {
  const user = await db.execute<{ id: string }>(sql`SELECT id FROM users WHERE username = 'operator'`);
  return Array.from(user)[0]?.id ?? "test-actor";
}

/** Insert a lot directly (the state under test is the move, not put-away). */
async function insertLot(opts: {
  id: string;
  shelfCode: string;
  qty: number;
  allocatedQty?: number;
  dateCode?: string | null;
  lotCode?: string | null;
  partNo?: string;
  wclItemNo?: string;
}): Promise<void> {
  await db.insert(inventoryLots).values({
    id: opts.id,
    partNo: opts.partNo ?? TEST_PART_NO,
    wclItemNo: opts.wclItemNo ?? TEST_WCL_ITEM_NO,
    dateCode: opts.dateCode === undefined ? "2640" : opts.dateCode,
    lotCode: opts.lotCode === undefined ? "LOT-A" : opts.lotCode,
    coo: "CN",
    cow: "CN",
    shelfCode: opts.shelfCode,
    orgId: TEST_ORG_ID,
    subInventoryCode: TEST_SUB_INVENTORY,
    totalQty: opts.qty,
    allocatedQty: opts.allocatedQty ?? 0,
  });
}

async function assertHttpError(p: Promise<unknown>, status: number, message: string): Promise<void> {
  try {
    await p;
    assert.fail(`expected HTTPException ${status} ${message}`);
  } catch (err) {
    assert.ok(err instanceof HTTPException, `expected HTTPException, got ${String(err)}`);
    assert.equal(err.status, status);
    assert.equal(err.message, message);
  }
}

before(async () => {
  client = await setupTestDb();
  db = client.db;
});

beforeEach(async () => {
  await reseed(client);
  await db.delete(inventoryTransactions).where(eq(inventoryTransactions.referenceType, "shelf_exchange"));
  await db.delete(shelfExchanges);
  await db.delete(inventoryLots).where(eq(inventoryLots.partNo, TEST_PART_NO));

  for (const code of [SOURCE_SHELF, TARGET_SHELF]) {
    await db.insert(shelves).values({ id: `shelf-${code}`, code, zone: "SX" }).onConflictDoNothing();
  }
  await db.insert(parts).values({
    id: "part-sx-001",
    brand: "TEST",
    partNo: TEST_PART_NO,
    wclItemNo: TEST_WCL_ITEM_NO,
    description: "Shelf exchange test part",
  }).onConflictDoNothing();
  await db.insert(subInventories).values({
    id: "org-sx-001",
    orgId: TEST_ORG_ID,
    secondaryInventoryName: TEST_SUB_INVENTORY,
  }).onConflictDoNothing();
});

afterEach(async () => {
  await db.delete(inventoryTransactions).where(eq(inventoryTransactions.referenceType, "shelf_exchange"));
  await db.delete(shelfExchanges);
  await db.delete(inventoryLots).where(eq(inventoryLots.partNo, TEST_PART_NO));
});

test("shelf exchange — preview", async () => {
  await test("resolves a lot by part key + label batch fields", async () => {
    await insertLot({ id: "lot-sx-1", shelfCode: SOURCE_SHELF, qty: 100 });
    const result = await previewShelfExchange(db, {
      sourceShelfCode: SOURCE_SHELF,
      partNo: TEST_PART_NO,
      qty: 30,
      dateCode: "2640",
    });
    assert.equal(result.lotId, "lot-sx-1");
    assert.equal(result.partNo, TEST_PART_NO);
    assert.equal(result.totalQty, 100);
    assert.equal(result.availableQty, 100);
    assert.equal(result.qty, 30);
  });

  await test("matches space-insensitively against wcl_item_no", async () => {
    // Master carries a space the label drops: "WCL SX-001" vs "WCLSX-001".
    await insertLot({ id: "lot-sx-2", shelfCode: SOURCE_SHELF, qty: 100, wclItemNo: "WCL SX-001" });
    const result = await previewShelfExchange(db, {
      sourceShelfCode: SOURCE_SHELF,
      partNo: "WCLSX-001",
      qty: 10,
    });
    assert.equal(result.lotId, "lot-sx-2");
  });

  await test("FIFO: oldest date_code wins when the label carries no date code", async () => {
    await insertLot({ id: "lot-sx-old", shelfCode: SOURCE_SHELF, qty: 50, dateCode: "2501" });
    await insertLot({ id: "lot-sx-new", shelfCode: SOURCE_SHELF, qty: 50, dateCode: "2640" });
    const result = await previewShelfExchange(db, {
      sourceShelfCode: SOURCE_SHELF,
      partNo: TEST_PART_NO,
      qty: 10,
    });
    assert.equal(result.lotId, "lot-sx-old");
  });

  await test("404 unknown source shelf", async () => {
    await assertHttpError(
      previewShelfExchange(db, {
        sourceShelfCode: "NO-SUCH-SHELF",
        partNo: TEST_PART_NO,
        qty: 1,
      }),
      404,
      "shelf_not_found"
    );
  });

  await test("409 no lot at the location", async () => {
    await assertHttpError(
      previewShelfExchange(db, {
        sourceShelfCode: SOURCE_SHELF,
        partNo: TEST_PART_NO,
        qty: 1,
      }),
      409,
      "no_stock_at_location"
    );
  });

  await test("409 lot exists but is fully allocated", async () => {
    await insertLot({ id: "lot-sx-alloc", shelfCode: SOURCE_SHELF, qty: 100, allocatedQty: 100 });
    await assertHttpError(
      previewShelfExchange(db, {
        sourceShelfCode: SOURCE_SHELF,
        partNo: TEST_PART_NO,
        qty: 10,
      }),
      409,
      "insufficient_available_qty"
    );
  });

  await test("409 qty exceeds available (partial allocation)", async () => {
    await insertLot({ id: "lot-sx-part", shelfCode: SOURCE_SHELF, qty: 100, allocatedQty: 80 });
    await assertHttpError(
      previewShelfExchange(db, {
        sourceShelfCode: SOURCE_SHELF,
        partNo: TEST_PART_NO,
        qty: 30,
      }),
      409,
      "insufficient_available_qty"
    );
    // ...but moving within the available remainder is fine.
    const ok = await previewShelfExchange(db, {
      sourceShelfCode: SOURCE_SHELF,
      partNo: TEST_PART_NO,
      qty: 20,
    });
    assert.equal(ok.availableQty, 20);
  });

  await test("400 qty must be a positive integer", async () => {
    await assertHttpError(
      previewShelfExchange(db, {
        sourceShelfCode: SOURCE_SHELF,
        partNo: TEST_PART_NO,
        qty: 0,
      }),
      400,
      "qty must be a positive integer"
    );
  });

  await test("preview skips lots whose shelf is missing from the shelves table", async () => {
    // Simulate an upstream-sync write that bypassed the shelf FK (replication
    // role): the lot points at a shelf that does not exist, so any UPDATE on
    // it would fail the FK check — preview must not resolve it.
    await insertLot({ id: "lot-sx-ghost-shelf", shelfCode: SOURCE_SHELF, qty: 100 });
    await client.sql.unsafe(
      `SET session_replication_role = replica;
       UPDATE inventory_lots SET shelf_code = 'NO-SUCH-SHELF' WHERE id = 'lot-sx-ghost-shelf';
       RESET session_replication_role;`
    );
    await assertHttpError(
      previewShelfExchange(db, {
        sourceShelfCode: "NO-SUCH-SHELF",
        partNo: TEST_PART_NO,
        qty: 5,
      }),
      404,
      "shelf_not_found" // the bogus shelf isn't in shelves at all
    );
    // And a normal lot on the real source shelf still resolves fine.
    await insertLot({ id: "lot-sx-ok", shelfCode: SOURCE_SHELF, qty: 100 });
    const ok = await previewShelfExchange(db, {
      sourceShelfCode: SOURCE_SHELF,
      partNo: TEST_PART_NO,
      qty: 5,
    });
    assert.equal(ok.lotId, "lot-sx-ok");
  });
});

test("shelf exchange — commit", async () => {
  await test("moves qty: source decremented, target lot created, ledger + audit rows", async () => {
    await insertLot({ id: "lot-sx-src", shelfCode: SOURCE_SHELF, qty: 100 });
    const result = await commitShelfExchange(db, {
      sourceShelfCode: SOURCE_SHELF,
      targetShelfCode: TARGET_SHELF,
      lotId: "lot-sx-src",
      qty: 40,
      actorId: await actorId(),
    });

    assert.equal(result.partNo, TEST_PART_NO);
    assert.equal(result.qty, 40);
    assert.equal(result.sourceRemaining, 60);
    assert.equal(result.targetTotal, 40);

    const lots = await db.select().from(inventoryLots).where(eq(inventoryLots.partNo, TEST_PART_NO));
    const source = lots.find((l) => l.shelfCode === SOURCE_SHELF)!;
    const target = lots.find((l) => l.shelfCode === TARGET_SHELF)!;
    assert.equal(source.totalQty, 60);
    assert.equal(target.totalQty, 40);
    // Target lot inherits the location pair + batch fields.
    assert.equal(target.orgId, TEST_ORG_ID);
    assert.equal(target.subInventoryCode, TEST_SUB_INVENTORY);
    assert.equal(target.dateCode, "2640");
    assert.equal(target.coo, "CN");
    assert.equal(target.wclItemNo, TEST_WCL_ITEM_NO);
    assert.equal(target.allocatedQty, 0);
    assert.equal(target.boxId, null);

    // Two MOVE ledger rows: −40 at source, +40 at target.
    const txns = await db
      .select()
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.referenceId, result.id));
    assert.equal(txns.length, 2);
    const out = txns.find((t) => t.qtyDelta === -40)!;
    const inn = txns.find((t) => t.qtyDelta === 40)!;
    assert.equal(out.shelfCode, SOURCE_SHELF);
    assert.equal(out.txnType, "MOVE");
    assert.equal(out.qtyType, "on_hand");
    assert.equal(out.inventoryLotId, "lot-sx-src");
    assert.equal(inn.shelfCode, TARGET_SHELF);
    assert.equal(inn.txnType, "MOVE");

    // Audit row.
    const audits = await db.select().from(shelfExchanges).where(eq(shelfExchanges.id, result.id));
    assert.equal(audits.length, 1);
    assert.equal(audits[0].sourceShelfCode, SOURCE_SHELF);
    assert.equal(audits[0].targetShelfCode, TARGET_SHELF);
    assert.equal(audits[0].sourceLotId, "lot-sx-src");
    assert.equal(audits[0].targetLotId, target.id);
    assert.equal(audits[0].qty, 40);
  });

  await test("merges into an existing target lot with the same batch key", async () => {
    await insertLot({ id: "lot-sx-src2", shelfCode: SOURCE_SHELF, qty: 100 });
    await insertLot({ id: "lot-sx-tgt", shelfCode: TARGET_SHELF, qty: 25 });

    const result = await commitShelfExchange(db, {
      sourceShelfCode: SOURCE_SHELF,
      targetShelfCode: TARGET_SHELF,
      lotId: "lot-sx-src2",
      qty: 40,
      actorId: await actorId(),
    });

    const target = await db
      .select()
      .from(inventoryLots)
      .where(eq(inventoryLots.id, "lot-sx-tgt"));
    assert.equal(target[0].totalQty, 65); // 25 + 40
    assert.equal(result.targetTotal, 65);
    // No third lot created.
    const lots = await db.select().from(inventoryLots).where(eq(inventoryLots.partNo, TEST_PART_NO));
    assert.equal(lots.length, 2);
    // Audit points at the merged lot.
    const audits = await db.select().from(shelfExchanges).where(eq(shelfExchanges.id, result.id));
    assert.equal(audits[0].targetLotId, "lot-sx-tgt");
  });

  await test("400 same shelf", async () => {
    await insertLot({ id: "lot-sx-src3", shelfCode: SOURCE_SHELF, qty: 100 });
    await assertHttpError(
      commitShelfExchange(db, {
        sourceShelfCode: SOURCE_SHELF,
        targetShelfCode: SOURCE_SHELF,
        lotId: "lot-sx-src3",
        qty: 10,
        actorId: await actorId(),
      }),
      400,
      "same_shelf"
    );
  });

  await test("404 unknown target shelf", async () => {
    await insertLot({ id: "lot-sx-src4", shelfCode: SOURCE_SHELF, qty: 100 });
    await assertHttpError(
      commitShelfExchange(db, {
        sourceShelfCode: SOURCE_SHELF,
        targetShelfCode: "NO-SUCH-SHELF",
        lotId: "lot-sx-src4",
        qty: 10,
        actorId: await actorId(),
      }),
      404,
      "shelf_not_found"
    );
  });

  await test("409 lot drifted off the source shelf between preview and commit", async () => {
    await insertLot({ id: "lot-sx-src5", shelfCode: TARGET_SHELF, qty: 100 });
    await assertHttpError(
      commitShelfExchange(db, {
        sourceShelfCode: SOURCE_SHELF,
        targetShelfCode: TARGET_SHELF,
        lotId: "lot-sx-src5",
        qty: 10,
        actorId: await actorId(),
      }),
      409,
      "no_stock_at_location"
    );
  });

  await test("409 insufficient available at commit time", async () => {
    await insertLot({ id: "lot-sx-src6", shelfCode: SOURCE_SHELF, qty: 100, allocatedQty: 95 });
    await assertHttpError(
      commitShelfExchange(db, {
        sourceShelfCode: SOURCE_SHELF,
        targetShelfCode: TARGET_SHELF,
        lotId: "lot-sx-src6",
        qty: 10,
        actorId: await actorId(),
      }),
      409,
      "insufficient_available_qty"
    );
    // Nothing moved.
    const lots = await db.select().from(inventoryLots).where(eq(inventoryLots.id, "lot-sx-src6"));
    assert.equal(lots[0].totalQty, 100);
  });

  await test("409 unknown lotId", async () => {
    await assertHttpError(
      commitShelfExchange(db, {
        sourceShelfCode: SOURCE_SHELF,
        targetShelfCode: TARGET_SHELF,
        lotId: "lot-sx-ghost",
        qty: 10,
        actorId: await actorId(),
      }),
      409,
      "no_stock_at_location"
    );
  });
});
