import { and, desc, eq, inArray, isNull, sql, or, type SQL } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { adHocPutAways } from "./schema/adhocPutaway.js";
import { inventoryLots } from "./schema/inventory.js";
import { inventoryTransactions } from "./schema/audit.js";
import { shelves, parts, subInventories } from "./schema/master.js";
import { newId } from "./id.js";
import { now } from "./now.js";
import { scheduleAllocateAll } from "./allocate.js";
import { allowedOrgCondition, allowedOrgFilter } from "./org-filter.js";

// Ad-hoc put-away domain logic (spec 2026-10-07-ad-hoc-put-away-design.md).
// Commits scanned items (no receiving order) directly to a shelf in one
// transaction: find-or-create inventory lots, write ledger rows, insert an
// audit row. The PDA holds the in-progress scan list in local state; this
// module only sees the confirmed batch.

export interface AdHocPutAwayItemInput {
  partNo: string;
  wclItemNo: string | null;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  serialNo: string | null;
  orgId: number;
  subInventoryCode: string;
}

export interface AdHocPutAwayInput {
  brand: string;
  shelfCode: string;
  items: AdHocPutAwayItemInput[];
  actorId: string;
}

export interface AdHocPutAwayResult {
  id: string;
  itemCount: number;
  totalQty: number;
  shelfCode: string;
}

interface LotKey {
  partNo: string;
  shelfCode: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  orgId: number;
  subInventoryCode: string;
}

function lotKey(item: AdHocPutAwayItemInput, shelfCode: string): LotKey {
  return {
    partNo: item.partNo,
    shelfCode,
    dateCode: item.dateCode,
    lotCode: item.lotCode,
    coo: item.coo,
    cow: item.cow,
    orgId: item.orgId,
    subInventoryCode: item.subInventoryCode,
  };
}

/**
 * Commit an ad-hoc put-away batch. Single transaction:
 * 1. Validate shelf exists.
 * 2. Validate each item's part exists.
 * 3. For each item: find-or-create inventory_lots row, increment total_qty,
 *    write inventory_transactions ledger row.
 * 4. Insert ad_hoc_put_aways audit row.
 * 5. Schedule allocateAll (background — new stock may affect picking).
 */
export async function commitAdHocPutAway(
  db: AppDb,
  input: AdHocPutAwayInput
): Promise<AdHocPutAwayResult> {
  const { brand, shelfCode, items, actorId } = input;

  if (!items.length) {
    throw new Error("ad-hoc put-away requires at least one item");
  }

  return db.transaction(async (tx) => {
    // 1. Validate shelf exists
    const shelf = await tx
      .select({ code: shelves.code })
      .from(shelves)
      .where(eq(shelves.code, shelfCode));
    if (!shelf.length) {
      throw new Error(`shelf_not_found:${shelfCode}`);
    }

    // 2. Validate each item's part exists
    const partNos = [...new Set(items.map((i) => i.partNo))];
    const existingParts = await tx
      .select({ partNo: parts.partNo })
      .from(parts)
      .where(inArray(parts.partNo, partNos));
    const existingPartSet = new Set(existingParts.map((p) => p.partNo));
    for (const item of items) {
      if (!existingPartSet.has(item.partNo)) {
        throw new Error(`part_not_found:${item.partNo}`);
      }
    }

    // 3. For each item: find-or-create lot, increment qty, write ledger
    const lotCache = new Map<string, string>(); // key → lot id
    const nowDate = now();

    for (const item of items) {
      const key = lotKey(item, shelfCode);
      const cacheKey = JSON.stringify(key);

      let lotId = lotCache.get(cacheKey);
      if (!lotId) {
        // Try to find existing lot — nullable columns need sql conditions
        const conditions = [
          eq(inventoryLots.partNo, key.partNo),
          eq(inventoryLots.shelfCode, key.shelfCode),
          key.dateCode === null
            ? isNull(inventoryLots.dateCode)
            : eq(inventoryLots.dateCode, key.dateCode),
          key.lotCode === null
            ? isNull(inventoryLots.lotCode)
            : eq(inventoryLots.lotCode, key.lotCode),
          key.coo === null
            ? isNull(inventoryLots.coo)
            : eq(inventoryLots.coo, key.coo),
          key.cow === null
            ? isNull(inventoryLots.cow)
            : eq(inventoryLots.cow, key.cow),
          eq(inventoryLots.orgId, key.orgId),
          eq(inventoryLots.subInventoryCode, key.subInventoryCode),
        ];
        const existing = await tx
          .select({ id: inventoryLots.id })
          .from(inventoryLots)
          .where(and(...conditions));
        if (existing.length) {
          lotId = existing[0].id;
        } else {
          lotId = newId();
          await tx.insert(inventoryLots).values({
            id: lotId,
            partNo: key.partNo,
            wclItemNo: item.wclItemNo,
            dateCode: key.dateCode,
            lotCode: key.lotCode,
            coo: key.coo,
            cow: key.cow,
            shelfCode: key.shelfCode,
            orgId: key.orgId,
            subInventoryCode: key.subInventoryCode,
            totalQty: 0,
            allocatedQty: 0,
          });
        }
        lotCache.set(cacheKey, lotId);
      }

      // Increment lot total_qty
      await tx
        .update(inventoryLots)
        .set({ totalQty: sql`${inventoryLots.totalQty} + ${item.qty}`, lastUpdateDate: nowDate })
        .where(eq(inventoryLots.id, lotId));

      // Write ledger row
      await tx.insert(inventoryTransactions).values({
        id: newId(),
        inventoryLotId: lotId,
        partNo: item.partNo,
        shelfCode,
        txnType: "ADJUST",
        qtyType: "on_hand",
        qtyDelta: item.qty,
        dateCode: item.dateCode,
        lotCode: item.lotCode,
        coo: item.coo,
        cow: item.cow,
        referenceType: "ad_hoc_put_away",
        referenceId: "", // will be updated after batch insert
        actorId,
        txnReason: "ad-hoc put-away",
        txnAt: nowDate,
      });
    }

    // 4. Insert audit row
    const batchId = newId();
    const totalQty = items.reduce((sum, i) => sum + i.qty, 0);

    await tx.insert(adHocPutAways).values({
      id: batchId,
      brand,
      shelfCode,
      orgId: items[0].orgId,
      subInventoryCode: items[0].subInventoryCode,
      totalQty,
      itemCount: items.length,
      items: items.map((i) => ({
        partNo: i.partNo,
        wclItemNo: i.wclItemNo,
        qty: i.qty,
        dateCode: i.dateCode,
        lotCode: i.lotCode,
        coo: i.coo,
        cow: i.cow,
        serialNo: i.serialNo,
      })),
      actorId,
    });

    // Update ledger rows with the batch reference id
    await tx
      .update(inventoryTransactions)
      .set({ referenceId: batchId })
      .where(
        and(
          eq(inventoryTransactions.referenceType, "ad_hoc_put_away"),
          eq(inventoryTransactions.referenceId, ""),
          eq(inventoryTransactions.actorId, actorId)
        )
      );

    return {
      id: batchId,
      itemCount: items.length,
      totalQty,
      shelfCode,
    };
  });
}

/**
 * Return valid (org_id, sub_inventory_code) pairs from org_info for the
 * PDA location selector. Limited to allowedOrgIds from warehouse_config.
 */
export async function listAdHocPutAwayLocations(
  db: AppDb
): Promise<{ locations: { orgId: number; subInventoryCode: string }[] }> {
  const rows = await db
    .select({
      orgId: subInventories.orgId,
      subInventoryCode: subInventories.secondaryInventoryName,
    })
    .from(subInventories)
    .where(allowedOrgCondition(sql`${subInventories.orgId}`))
    .orderBy(subInventories.orgId, subInventories.secondaryInventoryName);

  // Deduplicate (org_info may have multiple rows per pair)
  const seen = new Set<string>();
  const locations: { orgId: number; subInventoryCode: string }[] = [];
  for (const row of rows) {
    const key = `${row.orgId}:${row.subInventoryCode}`;
    if (!seen.has(key)) {
      seen.add(key);
      locations.push({ orgId: row.orgId, subInventoryCode: row.subInventoryCode });
    }
  }
  return { locations };
}

/**
 * Return distinct brand values from parts for the PDA brand dropdown.
 */
export async function listAdHocPutAwayBrands(
  db: AppDb
): Promise<{ brands: string[] }> {
  const rows = await db
    .selectDistinct({ brand: parts.brand })
    .from(parts)
    .orderBy(parts.brand);
  return { brands: rows.map((r) => r.brand) };
}

// Re-export for route scheduling
export { scheduleAllocateAll };

// ---------------------------------------------------------------------------
// Admin read-only queries
// ---------------------------------------------------------------------------

export interface AdHocPutAwayListRow {
  id: string;
  brand: string;
  shelfCode: string;
  orgId: number;
  subInventoryCode: string;
  totalQty: number;
  itemCount: number;
  actorId: string;
  createdDate: string;
}

export interface AdHocPutAwayDetail extends AdHocPutAwayListRow {
  items: Array<{
    partNo: string;
    wclItemNo: string | null;
    qty: number;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    cow: string | null;
    serialNo: string | null;
  }>;
}

/**
 * List ad-hoc put-away batches with optional filters. Used by the admin
 * console. Returns rows + total count for pagination.
 */
export async function listAdHocPutAways(
  db: AppDb,
  opts: {
    page?: number;
    pageSize?: number;
    supplierCode?: string; // brand filter (legacy param name)
    shelfCode?: string;
    from?: string;
    to?: string;
  } = {}
): Promise<{ rows: AdHocPutAwayListRow[]; total: number }> {
  const { page = 1, pageSize = 20, supplierCode, shelfCode, from, to } = opts;
  const conditions: SQL[] = [];
  if (supplierCode) conditions.push(eq(adHocPutAways.brand, supplierCode));
  if (shelfCode) conditions.push(eq(adHocPutAways.shelfCode, shelfCode));
  if (from) conditions.push(sql`${adHocPutAways.createdDate} >= ${from}`);
  if (to) conditions.push(sql`${adHocPutAways.createdDate} <= ${to}`);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: adHocPutAways.id,
      brand: adHocPutAways.brand,
      shelfCode: adHocPutAways.shelfCode,
      orgId: adHocPutAways.orgId,
      subInventoryCode: adHocPutAways.subInventoryCode,
      totalQty: adHocPutAways.totalQty,
      itemCount: adHocPutAways.itemCount,
      actorId: adHocPutAways.actorId,
      createdDate: adHocPutAways.createdDate,
    })
    .from(adHocPutAways)
    .where(where)
    .orderBy(desc(adHocPutAways.createdDate))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const countRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(adHocPutAways)
    .where(where);

  return {
    rows: rows.map((r) => ({ ...r, createdDate: r.createdDate.toISOString() })),
    total: countRow[0]?.count ?? 0,
  };
}

/**
 * Get a single ad-hoc put-away batch with its items. Used by the admin
 * detail page.
 */
export async function getAdHocPutAwayDetail(
  db: AppDb,
  id: string
): Promise<AdHocPutAwayDetail | null> {
  const row = await db
    .select({
      id: adHocPutAways.id,
      brand: adHocPutAways.brand,
      shelfCode: adHocPutAways.shelfCode,
      orgId: adHocPutAways.orgId,
      subInventoryCode: adHocPutAways.subInventoryCode,
      totalQty: adHocPutAways.totalQty,
      itemCount: adHocPutAways.itemCount,
      actorId: adHocPutAways.actorId,
      createdDate: adHocPutAways.createdDate,
      items: adHocPutAways.items,
    })
    .from(adHocPutAways)
    .where(eq(adHocPutAways.id, id))
    .limit(1);
  if (!row.length) return null;
  return {
    ...row[0],
    createdDate: row[0].createdDate.toISOString(),
    items: row[0].items as AdHocPutAwayDetail["items"],
  };
}
