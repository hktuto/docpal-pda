import postgres from "postgres";
import { sql, sql as dsql } from "drizzle-orm";
import type { PgTableWithColumns } from "drizzle-orm/pg-core";
import { newId } from "./id.js";
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
  warehouseConfig,
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
 *  with the hand-written demo rows on part_no). part_no is no longer UNIQUE,
 *  so the keep-first part_no merge is enforced in TS — see seenPartNos in
 *  seedAll; onConflictDoNothing still covers the wcl_item_no unique key. */
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
  "warehouse_config",
  "inventory_transactions",
  "transaction_logs",
  "goods_verify_tasks",
  "verify_tasks",
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
  "org_info",
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

const uid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`; // deterministic v7-shaped seed id

// Country lookup — codes are ISO 3166-1 alpha-2; names kept verbatim from
// the POC sheet ("Taiwan,China", "USA", "Korea" as given there).
const COUNTRIES = [
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
];

// Default box sizes from the POC sheet, normalized to "L X W X H" (cm).
const BOX_SIZES = [
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
];

// Warehouse shelf layout. DOCK is the virtual dock shelf — dock/GIT lots hang
// off this code (never NULL).
const SHELVES = [
  { code: "A-01-01", zone: "A" },
  { code: "A-01-02", zone: "A" },
  { code: "A-01-03", zone: "A" },
  { code: "A-01-04", zone: "A" },
  { code: "A-02-01", zone: "A" },
  { code: "A-02-02", zone: "A" },
  { code: "A-03-01", zone: "A" },
  { code: "A-03-02", zone: "A" },
  { code: "A-03-03", zone: "A" },
  { code: "A-03-04", zone: "A" },
  { code: "A-03-05", zone: "A" },
  { code: "A-04-01", zone: "A" },
  { code: "A-04-02", zone: "A" },
  { code: "A-04-03", zone: "A" },
  { code: "A-04-04", zone: "A" },
  { code: "A-04-05", zone: "A", subInventoryCodes: ["STORE1"] },
  { code: "DOCK", zone: "DOCK" },
  { code: "GZ-01-01", zone: "GZ" },
  { code: "GZ-01-02", zone: "GZ" },
  { code: "SZ-01-01", zone: "SZ" },
  { code: "SZ-01-02", zone: "SZ" },
  { code: "W-01-01", zone: "W" },
];

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
// opts.orders: seed the scenario receiving/picking orders (default on; the
// boot-time auto-seed turns it off when WAREHOUSE_SEED_ORDERS=off so a fresh
// UAT/production database starts with master data + shelf stock only).
async function seedAll(db: AppDb, opts?: { stockBoxes?: boolean; bulkParts?: boolean; orders?: boolean }): Promise<void> {
  // Flow config for this warehouse (spec
  // docs/superpowers/specs/2026-08-10-flow-config-design.md): the "flow" row
  // of warehouse_config, loaded once at boot. {} = defaults (all steps on,
  // dock stock allocatable). Edit per warehouse — e.g. require put-away
  // before picking:
  //   {"steps":{"put-away":{"autoCreateTasks":true},"picking":{"allocation":{"allowDockStock":false}}}}
  // FLOW_CONFIG env (when set) overrides this row at boot.
  await db.insert(warehouseConfig).values([{ key: "flow", value: {} }]);

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
    { id: uid(30), code: "operator", label: "Operator" },
    { id: uid(31), code: "admin", label: "Administrator" },
  ]);

  // operator → operator; admin → admin + operator (many-to-many demo).
  await db.insert(userGroupMembers).values([
    { id: uid(32), userId: uid(1), groupCode: "operator" },
    { id: uid(33), userId: uid(2), groupCode: "admin" },
    { id: uid(34), userId: uid(2), groupCode: "operator" },
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
        .map((code) => ({ id: newId(), code, name: code, shortName: code }))
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

  const demoMasterParts = [
    { id: uid(5), brand: "KOA", partNo: "RK73H1JTTD1002F", wclItemNo: "RK73H1JTTD1002F", description: "RES 10K OHM 1% 1/10W 0603" },
    { id: uid(6), brand: "KOA", partNo: "RK73H1JTTD2202F", wclItemNo: "RK73H1JTTD2202F", description: "RES 22K OHM 1% 1/10W 0603" },
    { id: uid(7), brand: "KOA", partNo: "RK73B1JTTD181G", wclItemNo: "RK73B1JTTD181G", description: "RES 180 OHM 5% 1/10W 0603" },
    { id: uid(8), brand: "KOA", partNo: "RK73H2ATTD1372F", wclItemNo: "RK73H2ATTD1372F", description: "RES 13.7K OHM 1% 1/8W 0805" },
    { id: uid(9), brand: "KOA", partNo: "RK73H1JTTD4702F", wclItemNo: "RK73H1JTTD4702F", description: "RES 47K OHM 1% 1/10W 0603" },
  ];
  await db.insert(parts).values(demoMasterParts);

  // part_no is not unique anymore, so the keep-first part_no merge of the
  // generated masters (bulk/demo-scenario/real-data) is enforced in TS.
  const seenPartNos = new Set(demoMasterParts.map((p) => p.partNo));
  const unseenParts = <P extends { partNo: string }>(rows: readonly P[]): P[] =>
    rows.filter((p) => !seenPartNos.has(p.partNo) && (seenPartNos.add(p.partNo), true));

  // Full Oracle parts master (generated; merges with the demo rows on
  // part_no — the demo rows above win via keep-first skip).
  if (bulk) {
    await insertChunked(
      db,
      parts,
      unseenParts(bulk.parts).map((p) => ({ id: newId(), ...p }))
    );
  }

  await db.insert(countryList).values(COUNTRIES.map((c, i) => ({ id: uid(100 + i), ...c })));

  await db.insert(boxSizeList).values(BOX_SIZES.map((code, i) => ({ id: uid(140 + i), code })));

  await db.insert(customerProfiles).values([
    { id: uid(180), code: "ACME", label: "ACME Electronics (HK)", remark: "requires segregated storage" },
    // real-data customers (new_seed/65878/picking.xlsx)
    { id: uid(181), code: "HK-SUN64", label: "HK-SUN64" },
    { id: uid(182), code: "HK-WIN84", label: "HK-WIN84" },
  ]);

  // Sub-inventories: the (org_id, secondary_inventory_name) group level that
  // all stock/doc tables reference via composite FK.
  await db.insert(subInventories).values([
    { orgId: 2, secondaryInventoryName: "STORE1", subinvDescription: "Store 1" },
    { orgId: 2, secondaryInventoryName: "WSTORE1" },
    { orgId: 2, secondaryInventoryName: "OSWF (HK)" },
    { orgId: 220, secondaryInventoryName: "THHK2" },
    { orgId: 220, secondaryInventoryName: "OSWF (TH)" },
    { orgId: 140, secondaryInventoryName: "STORE1" },
    { orgId: 140, secondaryInventoryName: "ZTE" },
    { orgId: 140, secondaryInventoryName: "OSWF (MCE)" },
    { orgId: 140, secondaryInventoryName: "HUAWEI" },
    { orgId: 140, secondaryInventoryName: "HWOS (HUAWEI)" },
    { orgId: 140, secondaryInventoryName: "DEFAULT" },
    { orgId: 143, secondaryInventoryName: "store1" },
    { orgId: 143, secondaryInventoryName: "OSWF (MCI)" },
    { orgId: 143, secondaryInventoryName: "DEFAULT" },
    { orgId: 2, secondaryInventoryName: "ACME-S1", subinvDescription: "ACME segregated store" },
  ].map((s, i) => ({ id: uid(183 + i), ...s })));

  // Real Oracle org → sub-inventory master (generated from the mapping xlsx —
  // 151 groups across 13 orgs). Rows colliding with the demo groups above
  // (e.g. org-2 STORE1/WSTORE1) are skipped keep-first.
  await db
    .insert(subInventories)
    .values(realSubInventories.map((s) => ({ id: newId(), ...s })))
    .onConflictDoNothing();

  // Demo share group: org-2 STORE1 + WSTORE1 serve each other's picking
  // demands. Real warehouses configure their own groups via the admin console
  // (/admin/sub-inventory-share-groups).
  await db.insert(subInventoryShareMembers).values([
    { id: uid(198), orgId: 2, code: "STORE1", shareGroup: "HK" },
    { id: uid(199), orgId: 2, code: "WSTORE1", shareGroup: "HK" },
  ]);

  await db.insert(shelves).values(SHELVES.map((s, i) => ({ id: uid(200 + i), ...s })));

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
      realNetWeights.map((w) => ({ id: newId(), partNo: w.partNo, qty: 1, weight: w.weight }))
    );
  }

  // --- demo scenario (new_seed/demo-scenario.xlsx → seed-demo-scenario.ts) ---
  // Parts first (FK target; merges with the demo/bulk master keep-first).
  const newDemoParts = unseenParts(demoParts);
  if (newDemoParts.length > 0) {
    await db.insert(parts).values(newDemoParts).onConflictDoNothing();
  }
  // 3 pending receiving orders (see the block comment above). Skipped when
  // opts.orders is false (WAREHOUSE_SEED_ORDERS=off at boot).
  if (opts?.orders !== false) {
    await db.insert(receivingOrders).values([...demoReceivingOrders]);
    await db.insert(receivingInvoices).values([...demoReceivingInvoices]);
    await db.insert(receivingInvoiceItems).values([...demoReceivingInvoiceItems]);
  }
  // Scenario shelf boxes + stock (tests opt out via stockBoxes: false).
  if (opts?.stockBoxes !== false) {
    await db.insert(shelfBoxes).values([...demoShelfBoxes]);
    await db.insert(shelfBoxItems).values([...demoShelfBoxItems]);
    await db.insert(inventoryLots).values([...demoLots]);
  }
  // 2 pending picking orders (SO-DEMO-0001 item-by-item line + whole-box match, SO-DEMO-0002 partial).
  if (opts?.orders !== false) {
    await db.insert(pickingOrders).values([...demoPickingOrders]);
    await db.insert(pickingItems).values([...demoPickingItems]);
  }

  // Real Oracle parts master reference rows (generated from
  // new_seed/parts_table.xlsx into seed-real-data.ts; merges keep-first with
  // the demo/bulk parts — master data only; the real-data ORDERS (04958184,
  // 65878 + picking lists) and order 210726 are no longer seeded, spec
  // docs/superpowers/specs/2026-07-29-excel-demo-seed-design.md).
  const newRealParts = unseenParts(realParts);
  if (newRealParts.length > 0) {
    await db.insert(parts).values(newRealParts).onConflictDoNothing();
  }

  // Allocation priority default: delivery date (sooner first, NULLS LAST),
  // then order no. Admin reorders afterwards via POST /picking-orders/reorder;
  // new ingest orders slot into their delivery-date position.
  await db.execute(sql`
    UPDATE picking_orders SET priority_seq = r.seq
    FROM (SELECT id, row_number() OVER (ORDER BY delivery_date ASC NULLS LAST, order_no) AS seq FROM picking_orders) r
    WHERE picking_orders.id = r.id`);
}

/** Minimal boot seed: reference data + shelf layout only. Masters (parts,
 *  suppliers, org_info, customer profiles) and all orders/stock arrive via the
 *  Electric sync from the DocPal master DB; users come from DocPal auth, so no
 *  local users are seeded. */
async function seedReferenceOnly(db: AppDb): Promise<void> {
  // Flow config row — required for boot ({} = all defaults on).
  await db.insert(warehouseConfig).values([{ key: "flow", value: {} }]);

  await db.insert(countryList).values(COUNTRIES.map((c, i) => ({ id: uid(100 + i), ...c })));

  await db.insert(boxSizeList).values(BOX_SIZES.map((code, i) => ({ id: uid(140 + i), code })));

  await db.insert(shelves).values(SHELVES.map((s, i) => ({ id: uid(200 + i), ...s })));

  // Net-weight reference: the two demo rows + the real master (part_no is
  // plain text with no FK to parts, so this is safe before parts sync in).
  await db.insert(netWeightFormula).values([
    { id: uid(26), partNo: "RK73H1JTTD1002F", qty: 1000, weight: 6.3 },
    { id: uid(27), partNo: "RK73H1JTTD2202F", qty: 1000, weight: 6.3 },
  ]);
  await insertChunked(
    db,
    netWeightFormula,
    realNetWeights.map((w) => ({ id: newId(), partNo: w.partNo, qty: 1, weight: w.weight }))
  );
}

/** Seed when the warehouse_config table is empty (fresh database). Default
 *  seeds reference data + shelves only; WAREHOUSE_SEED_DEMO=1 seeds the full
 *  demo world (users/masters/orders) for local dev login. Returns true when
 *  it seeded. */
export async function seedIfEmpty(sql: postgres.Sql, db: AppDb): Promise<boolean> {
  const rows = await sql`SELECT COUNT(*)::int AS c FROM warehouse_config`;
  const c = Number((rows[0] as { c: string | number }).c);
  if (c > 0) return false;
  await db.transaction(async (tx) => {
    // Seeding must not flood the sync-service event feed.
    await tx.execute(dsql`SET LOCAL app.sync_events_off = 1`);
    if (process.env.WAREHOUSE_SEED_DEMO === "1") {
      // WAREHOUSE_SEED_ORDERS=off: master data + shelf stock only, no demo
      // receiving/picking orders (UAT/production fresh databases).
      await seedAll(tx as unknown as AppDb, { orders: process.env.WAREHOUSE_SEED_ORDERS !== "off" });
    } else {
      await seedReferenceOnly(tx as unknown as AppDb);
    }
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
