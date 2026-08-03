import postgres from "postgres";
import { sql, sql as dsql } from "drizzle-orm";
import type { PgTableWithColumns } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AppDb } from "../db.js";
import { hashPassword } from "../auth/password.js";
import {
  users,
  userGroups,
  userGroupMembers,
  suppliers,
  supplierProfiles,
  parts,
  shelves,
  countryList,
  boxSizeList,
  netWeightFormula,
  customerProfiles,
  subInventories,
  subInventoryShareMembers,
  receivingOrders,
  receivingInvoices,
  receivingInvoiceItems,
  inventoryLots,
  shelfBoxes,
  shelfBoxItems,
  pickingOrders,
  pickingItems,
} from "./schema/index.js";
import { realParts } from "./seed-real-data.js";
import { realSubInventories } from "./seed-subinventories-data.js";
import { realNetWeights } from "./seed-net-weight-data.js";
import {
  demoParts,
  demoReceivingOrders,
  demoReceivingInvoices,
  demoReceivingInvoiceItems,
  demoPickingOrders,
  demoPickingItems,
  demoShelfBoxes,
  demoShelfBoxItems,
  demoLots,
} from "./seed-demo-scenario.js";

interface BulkPartsData {
  suppliers: string[];
  parts: {
    brand: string;
    partNo: string;
    wclItemNo: string | null;
    description: string | null;
    defaultCoo: string | null;
  }[];
}

/** Lazy-loaded bulk parts master (~100k rows, generated — see
 *  scripts/gen-seed-real-data.mjs). Only read when seeding with bulkParts. */
function loadBulkParts(): BulkPartsData {
  return JSON.parse(
    readFileSync(new URL("./seed-parts-data.json", import.meta.url), "utf8")
  ) as BulkPartsData;
}

/** Insert rows in chunks, ignoring unique conflicts (parts/net-weights merge
 *  with the hand-written demo rows on part_no). */
async function insertChunked<T extends PgTableWithColumns<any>>(
  db: AppDb,
  table: T,
  rows: T["$inferInsert"][],
  size = 2000
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await db.insert(table).values(rows.slice(i, i + size) as never[]).onConflictDoNothing();
  }
}

// every table created by Drizzle migrations
export const ALL_TABLES = [
  "sync_events",
  "app_events",
  "inventory_transactions",
  "transaction_logs",
  "goods_verify_tasks",
  "measuring_tasks",
  "picking_packages",
  "shipping_box_items",
  "shipping_boxes",
  "picking_items",
  "picking_orders",
  "allocations",
  "inventory_lot_sources",
  "inventory_lots",
  "shelf_box_items",
  "shelf_boxes",
  "receiving_scan_labels",
  "receiving_invoice_items",
  "receiving_invoices",
  "receiving_orders",
  "net_weight_formula",
  "shelves",
  "sub_inventory_share_members",
  "sub_inventories",
  "customer_profiles",
  "box_size_list",
  "country_list",
  "parts",
  "supplier_profiles",
  "suppliers",
  "user_group_members",
  "user_groups",
  "users",
];

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Demo dataset (spec docs/superpowers/specs/2026-07-29-excel-demo-seed-design.md):
// the order/stock world comes from new_seed/demo-scenario.xlsx via
// scripts/gen-seed-demo-scenario.mjs (seed-demo-scenario.ts) —
//  - 3 PENDING receiving orders: 100001/100002 (2 cartons × 2-3 items each,
//    carton metadata in additional_data) for the receive → put-away journey;
//    100003 feeds the three allocation demo cases below
//  - 5 PENDING picking orders: SO-DEMO-0001 is fully allocated — scan its
//    extra 181G×300 line item-by-item first, then the remaining demand
//    exactly matches shelf box BOX-H-20260701-0001 (whole-box claim demo);
//    SO-DEMO-0002 is only partially covered by shelf stock (the shortfall
//    sits on the pending receiving orders); SO-DEMO-0003 == carton C3001
//    exactly (scan the carton + part labels on the picking page, pack into
//    a new shipping box — box size/weights prefill from the carton's
//    additional_data); SO-DEMO-0004 is under-supplied (stays
//    partial); SO-DEMO-0005 splits every line across shelf box
//    BOX-H-20260701-0003 and receiving carton C3003
// Master data (users, suppliers, parts, sub-inventories, shelves, net
// weights, profiles) is seeded here / from the real-master artifacts.
// Derived rows (allocations, transactions, packages) are produced by business
// logic, not by the seed.
// opts.stockBoxes: seed the scenario shelf boxes + stock (default on; tests
// turn it off so their exact-count assertions keep the minimal world).
async function seedAll(db: AppDb, opts?: { stockBoxes?: boolean; bulkParts?: boolean }): Promise<void> {
  // bulkParts (default on) seeds the full Oracle parts master (~100k rows),
  // its 162 auto-created suppliers, and the real net-weight table. Tests pass
  // bulkParts: false to keep the small, fast demo world.
  const bulk = opts?.bulkParts !== false ? loadBulkParts() : null;
  // Demo passwords stay DocPal2026! / DocPalAdmin2026!, stored scrypt-hashed.
  await db.insert(users).values([
    { id: uid(1), username: "operator", passwordHash: await hashPassword("DocPal2026!"), displayName: "Demo Operator" },
    { id: uid(2), username: "admin", passwordHash: await hashPassword("DocPalAdmin2026!"), displayName: "Demo Admin" },
  ]);

  await db.insert(userGroups).values([
    { code: "operator", label: "Operator" },
    { code: "admin", label: "Administrator" },
  ]);

  // operator → operator; admin → admin + operator (many-to-many demo).
  await db.insert(userGroupMembers).values([
    { userId: uid(1), groupCode: "operator" },
    { userId: uid(2), groupCode: "admin" },
    { userId: uid(2), groupCode: "operator" },
  ]);

  await db.insert(suppliers).values([
    { id: uid(3), code: "KOA", name: "KOA", shortName: "KOA" },
    { id: uid(4), code: "DAITO", name: "DAITO", shortName: "DAITO" },
    // real-data supplier (new_seed/): KOA items shipped by TCG
    { id: uid(28), code: "KOA+TCG", name: "KOA+TCG", shortName: "KOA+TCG" },
  ]);

  // Auto-created suppliers for every prefix in the Oracle parts master
  // (parts.brand holds the code as plain text; KOA/DAITO/KOA+TCG already exist
  // above). Kept so supplier-facing lists still know every brand code.
  if (bulk) {
    const demoCodes = new Set(["KOA", "DAITO", "KOA+TCG"]);
    await insertChunked(
      db,
      suppliers,
      bulk.suppliers
        .filter((code) => !demoCodes.has(code))
        .map((code) => ({ id: randomUUID(), code, name: code, shortName: code }))
    );
  }

  // structured config for the admin QR-template editor (delimited ":" —
  // leading empty piece is an Ignore; generates a matching-equivalent regex)
  const koaQrTemplateConfig = {
    version: 1,
    mode: "delimited",
    delimiter: ":",
    fields: [
      { role: "ignore" },
      { role: "itemId" },
      { role: "ignore" },
      { role: "qty" },
      { role: "ignore" },
      { role: "lotCode" },
      { role: "serialNo" },
      { role: "ignore" },
    ],
  };

  await db.insert(supplierProfiles).values([
    {
      id: uid(25),
      supplierCode: "KOA",
      qrTemplate: "^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<serialNo>[^:]+):(?<fullName>.+)$",
      qrTemplateConfig: koaQrTemplateConfig,
      qtyEncoding: "koa_zeros",
    },
    // same KOA label format for the real-data supplier
    {
      id: uid(29),
      supplierCode: "KOA+TCG",
      qrTemplate: "^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<serialNo>[^:]+):(?<fullName>.+)$",
      qrTemplateConfig: koaQrTemplateConfig,
      qtyEncoding: "koa_zeros",
    },
  ]);

  await db.insert(parts).values([
    { id: uid(5), brand: "KOA", partNo: "RK73H1JTTD1002F", wclItemNo: "RK73H1JTTD1002F", description: "RES 10K OHM 1% 1/10W 0603", defaultCoo: "JP" },
    { id: uid(6), brand: "KOA", partNo: "RK73H1JTTD2202F", wclItemNo: "RK73H1JTTD2202F", description: "RES 22K OHM 1% 1/10W 0603", defaultCoo: "JP" },
    { id: uid(7), brand: "KOA", partNo: "RK73B1JTTD181G", wclItemNo: "RK73B1JTTD181G", description: "RES 180 OHM 5% 1/10W 0603", defaultCoo: "JP" },
    { id: uid(8), brand: "KOA", partNo: "RK73H2ATTD1372F", wclItemNo: "RK73H2ATTD1372F", description: "RES 13.7K OHM 1% 1/8W 0805", defaultCoo: "JP" },
    { id: uid(9), brand: "KOA", partNo: "RK73H1JTTD4702F", wclItemNo: "RK73H1JTTD4702F", description: "RES 47K OHM 1% 1/10W 0603", defaultCoo: "JP" },
  ]);

  // Full Oracle parts master (generated; merges with the demo rows on
  // part_no — the demo rows above win via keep-first conflict skip).
  if (bulk) {
    await insertChunked(
      db,
      parts,
      bulk.parts.map((p) => ({ id: randomUUID(), ...p }))
    );
  }

  // Country lookup — codes are ISO 3166-1 alpha-2; names kept verbatim from
  // the POC sheet ("Taiwan,China", "USA", "Korea" as given there).
  await db.insert(countryList).values([
    { code: "AU", name: "Australia" },
    { code: "AT", name: "Austria" },
    { code: "BE", name: "Belgium" },
    { code: "BR", name: "Brazil" },
    { code: "KH", name: "Cambodia" },
    { code: "CA", name: "Canada" },
    { code: "CN", name: "China" },
    { code: "HR", name: "Croatia" },
    { code: "CZ", name: "Czechia" },
    { code: "DK", name: "Denmark" },
    { code: "FR", name: "France" },
    { code: "DE", name: "Germany" },
    { code: "GR", name: "Greece" },
    { code: "IN", name: "India" },
    { code: "ID", name: "Indonesia" },
    { code: "IL", name: "Israel" },
    { code: "IT", name: "Italy" },
    { code: "JP", name: "Japan" },
    { code: "KR", name: "Korea" },
    { code: "LA", name: "Laos" },
    { code: "MY", name: "Malaysia" },
    { code: "MX", name: "Mexico" },
    { code: "MA", name: "Morocco" },
    { code: "NL", name: "Netherlands" },
    { code: "PH", name: "Philippines" },
    { code: "PT", name: "Portugal" },
    { code: "SA", name: "Saudi Arabia" },
    { code: "SG", name: "Singapore" },
    { code: "SI", name: "Slovenia" },
    { code: "SK", name: "Slovakia" },
    { code: "ES", name: "Spain" },
    { code: "LK", name: "Sri Lanka" },
    { code: "CH", name: "Switzerland" },
    { code: "TW", name: "Taiwan,China" },
    { code: "TH", name: "Thailand" },
    { code: "GB", name: "United Kingdom" },
    { code: "US", name: "USA" },
    { code: "VN", name: "Vietnam" },
  ]);

  // Default box sizes from the POC sheet, normalized to "L X W X H" (cm).
  await db.insert(boxSizeList).values(
    [
      "18 X 11 X 29",
      "20 X 16 X 20",
      "21 X 21 X 9",
      "25 X 22 X 30",
      "26 X 20 X 20",
      "26 X 22 X 22",
      "26.5 X 10 X 34",
      "26.5 X 10 X 35",
      "26.5 X 17 X 34",
      "26.5 X 17 X 35",
      "28 X 32.5 X 35",
      "32 X 22 X 30",
      "32.5 X 28 X 35",
      "33 X 24 X 16",
      "33 X 24 X 18",
      "33 X 24 X 25",
      "33 X 33 X 22",
      "34 X 25 X 9",
      "35 X 35 X 22",
      "35.5 X 35.5 X 30.5",
      "36 X 22 X 22",
      "37 X 15 X 37",
      "37 X 8.5 X 37",
      "40 X 40 X 28",
      "41 X 17 X 41",
      "41 X 41 X 28",
      "41 X 8.5 X 41",
      "42 X 40 X 42",
      "44 X 20 X 20",
      "45 X 44 X 33",
      "46 X 24 X 21.5",
      "46.5 X 21.5 X 30",
      "47 X 24 X 21.5",
      "58.5 X 20 X 10",
      "58.5 X 20 X 20",
      "63 X 16 X 12",
    ].map((code) => ({ code }))
  );

  await db.insert(customerProfiles).values([
    { code: "ACME", label: "ACME Electronics (HK)", remark: "requires segregated storage" },
    // real-data customers (new_seed/65878/picking.xlsx)
    { code: "HK-SUN64", label: "HK-SUN64" },
    { code: "HK-WIN84", label: "HK-WIN84" },
  ]);

  // Sub-inventories: the (org_id, code) group level that all stock/doc
  // tables reference via composite FK. ACME-S1 is the demo
  // customer-segregated store.
  await db.insert(subInventories).values([
    { orgId: 2, code: "STORE1", name: "Store 1" },
    { orgId: 2, code: "WSTORE1" },
    { orgId: 2, code: "OSWF (HK)" },
    { orgId: 220, code: "THHK2" },
    { orgId: 220, code: "OSWF (TH)" },
    { orgId: 140, code: "STORE1" },
    { orgId: 140, code: "ZTE" },
    { orgId: 140, code: "OSWF (MCE)" },
    { orgId: 140, code: "HUAWEI" },
    { orgId: 140, code: "HWOS (HUAWEI)" },
    { orgId: 140, code: "DEFAULT" },
    { orgId: 143, code: "store1" },
    { orgId: 143, code: "OSWF (MCI)" },
    { orgId: 143, code: "DEFAULT" },
    { orgId: 2, code: "ACME-S1", name: "ACME segregated store", customerCode: "ACME" },
  ]);

  // Real Oracle org → sub-inventory master (generated from the mapping xlsx —
  // 151 groups across 13 orgs). Rows colliding with the demo groups above
  // (e.g. org-2 STORE1/WSTORE1) are skipped keep-first.
  await db.insert(subInventories).values([...realSubInventories]).onConflictDoNothing();

  // Demo share group: org-2 STORE1 + WSTORE1 serve each other's picking
  // demands. Real warehouses configure their own groups via the admin console
  // (/admin/sub-inventory-share-groups).
  await db.insert(subInventoryShareMembers).values([
    { orgId: 2, code: "STORE1", shareGroup: "HK" },
    { orgId: 2, code: "WSTORE1", shareGroup: "HK" },
  ]);

  await db.insert(shelves).values([
    { code: "A-01-01", zone: "A" },
    { code: "A-01-02", zone: "A" },
    { code: "A-01-03", zone: "A" },
    { code: "A-01-04", zone: "A" },
    // case-1/3 demo boxes (BOX-H-20260701-0003/-0004)
    { code: "A-02-01", zone: "A" },
    { code: "A-02-02", zone: "A" },
    // virtual dock shelf — dock/GIT lots hang off this code (never NULL)
    { code: "DOCK", zone: "DOCK" },
    // shelves for the real-data orders (new_seed/)
    { code: "GZ-01-01", zone: "GZ" },
    { code: "GZ-01-02", zone: "GZ" },
    { code: "SZ-01-01", zone: "SZ" },
    { code: "SZ-01-02", zone: "SZ" },
    { code: "W-01-01", zone: "W" },
  ]);

  // Net-weight reference: 1000 pcs of each 0603 resistor ≈ 6.3 g.
  await db.insert(netWeightFormula).values([
    { id: uid(26), partNo: "RK73H1JTTD1002F", qty: 1000, weight: 6.3 },
    { id: uid(27), partNo: "RK73H1JTTD2202F", qty: 1000, weight: 6.3 },
  ]);
  // Real net-weight master (generated from new_seed/weight/*.xls — unit
  // weight per 1 pc in grams; FK into the bulk parts master).
  if (bulk) {
    await insertChunked(
      db,
      netWeightFormula,
      realNetWeights.map((w) => ({ id: randomUUID(), partNo: w.partNo, qty: 1, weight: w.weight }))
    );
  }

  // --- demo scenario (new_seed/demo-scenario.xlsx → seed-demo-scenario.ts) ---
  // Parts first (FK target; merges with the demo/bulk master keep-first).
  await db.insert(parts).values([...demoParts]).onConflictDoNothing();
  // 3 pending receiving orders (see the block comment above).
  await db.insert(receivingOrders).values([...demoReceivingOrders]);
  await db.insert(receivingInvoices).values([...demoReceivingInvoices]);
  await db.insert(receivingInvoiceItems).values([...demoReceivingInvoiceItems]);
  // Scenario shelf boxes + stock (tests opt out via stockBoxes: false).
  if (opts?.stockBoxes !== false) {
    await db.insert(shelfBoxes).values([...demoShelfBoxes]);
    await db.insert(shelfBoxItems).values([...demoShelfBoxItems]);
    await db.insert(inventoryLots).values([...demoLots]);
  }
  // 2 pending picking orders (SO-DEMO-0001 item-by-item line + whole-box match, SO-DEMO-0002 partial).
  await db.insert(pickingOrders).values([...demoPickingOrders]);
  await db.insert(pickingItems).values([...demoPickingItems]);

  // Real Oracle parts master reference rows (generated from
  // new_seed/parts_table.xlsx into seed-real-data.ts; merges keep-first with
  // the demo/bulk parts — master data only; the real-data ORDERS (04958184,
  // 65878 + picking lists) and order 210726 are no longer seeded, spec
  // docs/superpowers/specs/2026-07-29-excel-demo-seed-design.md).
  await db.insert(parts).values([...realParts]).onConflictDoNothing();

  // Allocation priority default: delivery date (sooner first, NULLS LAST),
  // then order no. Admin reorders afterwards via POST /picking-orders/reorder;
  // new ingest orders slot into their delivery-date position.
  await db.execute(sql`
    UPDATE picking_orders SET priority_seq = r.seq
    FROM (SELECT id, row_number() OVER (ORDER BY delivery_date ASC NULLS LAST, order_no) AS seq FROM picking_orders) r
    WHERE picking_orders.id = r.id`);
}

/** Seed demo data when the users table is empty. Returns true when it seeded. */
export async function seedIfEmpty(sql: postgres.Sql, db: AppDb): Promise<boolean> {
  const rows = await sql`SELECT COUNT(*)::int AS c FROM users`;
  const c = Number((rows[0] as { c: string | number }).c);
  if (c > 0) return false;
  await db.transaction(async (tx) => {
    // Demo seeding must not flood the sync-service event feed.
    await tx.execute(dsql`SET LOCAL app.sync_events_off = 1`);
    await seedAll(tx as unknown as AppDb);
  });
  return true;
}

/** Dev-only: wipe everything and re-seed inside a transaction. */
export async function resetAndReseed(
  _sql: postgres.Sql,
  db: AppDb,
  opts?: { stockBoxes?: boolean; bulkParts?: boolean }
): Promise<void> {
  await db.transaction(async (tx) => {
    // Demo seeding must not flood the sync-service event feed.
    await tx.execute(sql`SET LOCAL app.sync_events_off = 1`);
    await tx.execute(sql`TRUNCATE TABLE ${sql.raw(ALL_TABLES.join(", "))} CASCADE`);
    await seedAll(tx as unknown as AppDb, opts);
  });
}
