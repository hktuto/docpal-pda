import postgres from "postgres";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import {
  users,
  suppliers,
  supplierProfiles,
  parts,
  shelves,
  countryList,
  boxSizeList,
  netWeightFormula,
  customerProfiles,
  subInventories,
  warehouseSections,
  receivingOrders,
  receivingInvoices,
  receivingInvoiceItems,
  inventoryLots,
  inventoryLotSources,
  pickingOrders,
  pickingItems,
} from "./schema/index.js";
import {
  realParts,
  realReceivingOrders,
  realReceivingInvoices,
  realReceivingInvoiceItems,
  realPickingOrders,
  realPickingItems,
} from "./seed-real-data.js";

// every table created by Drizzle migrations
export const ALL_TABLES = [
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
  "sub_inventories",
  "warehouse_sections",
  "customer_profiles",
  "box_size_list",
  "country_list",
  "parts",
  "supplier_profiles",
  "suppliers",
  "users",
];

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Demo dataset, aligned with the apps/web / apps/api demo world:
//  - one CLEARED KOA receiving order whose two items are fully put away into
//    on-shelf inventory lots (with lot sources)
//  - one PENDING DAITO receiving order (expected only)
//  - one PENDING picking order against the stocked parts
// Derived rows (allocations, transactions, packages) are produced by business
// logic, not by the seed.
async function seedAll(db: AppDb): Promise<void> {
  await db.insert(users).values([
    { id: uid(1), username: "operator", passwordHash: "DocPal2026!", displayName: "Demo Operator", role: "operator" },
    { id: uid(2), username: "admin", passwordHash: "DocPalAdmin2026!", displayName: "Demo Admin", role: "admin" },
  ]);

  await db.insert(suppliers).values([
    { id: uid(3), code: "KOA", name: "KOA", shortName: "KOA" },
    { id: uid(4), code: "DAITO", name: "DAITO", shortName: "DAITO" },
    // real-data supplier (new_seed/): KOA items shipped by TCG
    { id: uid(28), code: "KOA+TCG", name: "KOA+TCG", shortName: "KOA+TCG" },
  ]);

  await db.insert(supplierProfiles).values([
    {
      id: uid(25),
      supplierCode: "KOA",
      qrTemplate: "^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<serialNo>[^:]+):(?<fullName>.+)$",
      qtyEncoding: "koa_zeros",
    },
    // same KOA label format for the real-data supplier
    {
      id: uid(29),
      supplierCode: "KOA+TCG",
      qrTemplate: "^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<serialNo>[^:]+):(?<fullName>.+)$",
      qtyEncoding: "koa_zeros",
    },
  ]);

  await db.insert(parts).values([
    { id: uid(5), partNo: "RK73H1JTTD1002F", wclItemNo: "RK73H1JTTD1002F", internalCode: "R-10K-0603", description: "RES 10K OHM 1% 1/10W 0603", defaultCoo: "JP" },
    { id: uid(6), partNo: "RK73H1JTTD2202F", wclItemNo: "RK73H1JTTD2202F", internalCode: "R-22K-0603", description: "RES 22K OHM 1% 1/10W 0603", defaultCoo: "JP" },
    { id: uid(7), partNo: "RK73B1JTTD181G", wclItemNo: "RK73B1JTTD181G", internalCode: "R-180-0603", description: "RES 180 OHM 5% 1/10W 0603", defaultCoo: "JP" },
    { id: uid(8), partNo: "RK73H2ATTD1372F", wclItemNo: "RK73H2ATTD1372F", internalCode: "R-13.7K-0805", description: "RES 13.7K OHM 1% 1/8W 0805", defaultCoo: "JP" },
    { id: uid(9), partNo: "P413", wclItemNo: "P413", internalCode: "FUSE-1A", description: "DAITO FUSE 1A", defaultCoo: "JP" },
  ]);

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

  // Real sub-inventory codes (new_seed/subInventories.xlsx), grouped by
  // warehouse section: HK → STORE1/WSTORE1/OSWF (HK); TH → THHK2/OSWF (TH);
  // MCE → BJHK1…HWOS (HUAWEI); MCI → BJHK2…OSWF (MCI). The section link is
  // per-row on shelves/orders (sub_inventories itself has no section column).
  await db.insert(subInventories).values([
    { code: "STORE1", name: "Main store" },
    { code: "WSTORE1", name: "WSTORE1" },
    { code: "OSWF (HK)", name: "OSWF (HK)" },
    { code: "THHK2", name: "THHK2" },
    { code: "OSWF (TH)", name: "OSWF (TH)" },
    { code: "BJHK1", name: "BJHK1" },
    { code: "GZHK1", name: "GZHK1" },
    { code: "SHHK1", name: "SHHK1" },
    { code: "SZHK1", name: "SZHK1" },
    { code: "ZTE", name: "ZTE" },
    { code: "OSWF (MCE)", name: "OSWF (MCE)" },
    { code: "HUAWEI", name: "HUAWEI" },
    { code: "HUAWEI-CAR", name: "HUAWEI-CAR" },
    { code: "HWOS (HUAWEI)", name: "HWOS (HUAWEI)" },
    { code: "BJHK2", name: "BJHK2" },
    { code: "GZHK2", name: "GZHK2" },
    { code: "SHHK2", name: "SHHK2" },
    { code: "SZHK2", name: "SZHK2" },
    { code: "OSWF (MCI)", name: "OSWF (MCI)" },
    { code: "ACME-S1", name: "ACME segregated store", customerCode: "ACME" },
  ]);

  // warehouse → warehouse_section → sub_inventory (3 stock levels).
  // Real sections of warehouse HK1 (new_seed/subInventories.xlsx).
  await db.insert(warehouseSections).values([
    { code: "HK", name: "HK", warehouseCode: "HK1" },
    { code: "TH", name: "TH", warehouseCode: "HK1" },
    { code: "MCE", name: "MCE", warehouseCode: "HK1" },
    { code: "MCI", name: "MCI", warehouseCode: "HK1" },
  ]);

  await db.insert(shelves).values([
    { code: "A-01-01", zone: "A", orgId: 2, warehouseSectionCode: "HK", subInventoryCode: "STORE1", locationType: "shelf" },
    { code: "A-01-02", zone: "A", orgId: 2, warehouseSectionCode: "HK", subInventoryCode: "STORE1", locationType: "shelf" },
    { code: "A-01-03", zone: "A", orgId: 2, warehouseSectionCode: "HK", subInventoryCode: "STORE1", locationType: "shelf" },
    { code: "A-01-04", zone: "A", orgId: 2, warehouseSectionCode: "HK", subInventoryCode: "STORE1", locationType: "shelf" },
    // virtual dock shelf — dock/GIT lots hang off this code (never NULL)
    { code: "DOCK", zone: "DOCK", orgId: 2, warehouseSectionCode: "HK", subInventoryCode: "STORE1", locationType: "dock" },
    // shelves for the real-data sub-inventories (new_seed/ orders)
    { code: "GZ-01-01", zone: "GZ", orgId: 2, warehouseSectionCode: "MCE", subInventoryCode: "GZHK1", locationType: "shelf" },
    { code: "GZ-01-02", zone: "GZ", orgId: 2, warehouseSectionCode: "MCE", subInventoryCode: "GZHK1", locationType: "shelf" },
    { code: "SZ-01-01", zone: "SZ", orgId: 2, warehouseSectionCode: "MCE", subInventoryCode: "SZHK1", locationType: "shelf" },
    { code: "SZ-01-02", zone: "SZ", orgId: 2, warehouseSectionCode: "MCE", subInventoryCode: "SZHK1", locationType: "shelf" },
    { code: "W-01-01", zone: "W", orgId: 2, warehouseSectionCode: "HK", subInventoryCode: "WSTORE1", locationType: "shelf" },
  ]);

  // Net-weight reference: 1000 pcs of each 0603 resistor ≈ 6.3 g.
  await db.insert(netWeightFormula).values([
    { id: uid(26), partId: uid(5), qty: 1000, weight: 6.3 },
    { id: uid(27), partId: uid(6), qty: 1000, weight: 6.3 },
  ]);

  // --- cleared receiving order (fully received + put away) -------------------
  await db.insert(receivingOrders).values([
    {
      id: uid(10),
      refNo: "04958166",
      supplierId: uid(3),
      deliveryDate: new Date("2026-07-10"),
      warehouseSectionCode: "HK",
      subInventoryCode: "STORE1",
      status: "clear",
      arrivedAt: new Date("2026-07-10T09:30:00Z"),
      arrivedBy: uid(1),
    },
    // --- pending receiving order (expected only) -----------------------------
    {
      id: uid(11),
      refNo: "04958210",
      supplierId: uid(4),
      deliveryDate: new Date("2026-07-20"),
      warehouseSectionCode: "HK",
      subInventoryCode: "STORE1",
      status: "pending",
    },
  ]);

  await db.insert(receivingInvoices).values([
    {
      id: uid(12),
      receivingOrderId: uid(10),
      invoiceNo: "04958166-W-01",
      supplierId: uid(3),
      wclCompanyName: "WCL Components Ltd",
      totalQty: 15000,
      totalCtn: 2,
      deliveryDate: new Date("2026-07-08"),
      orgId: 2,
      warehouseSectionCode: "HK",
      subInventoryCode: "STORE1",
    },
    {
      id: uid(13),
      receivingOrderId: uid(11),
      invoiceNo: "04958210-W-01",
      supplierId: uid(4),
      wclCompanyName: "WCL Components Ltd",
      totalQty: 8000,
      totalCtn: 1,
      deliveryDate: new Date("2026-07-18"),
      orgId: 2,
      warehouseSectionCode: "HK",
      subInventoryCode: "STORE1",
    },
  ]);

  await db.insert(receivingInvoiceItems).values([
    // cleared order items — fully received and put away
    {
      id: uid(14),
      receivingInvoiceId: uid(12),
      partId: uid(5),
      wclItemNo: "RK73H1JTTD1002F",
      poNo: "PO-KOA-001",
      poLine: "1",
      qty: 10000,
      receivedQty: 10000,
      putAwayQty: 10000,
      boxId: "BOX-0001",
      dateCode: "2601",
      lotCode: "L2601A",
      coo: "JP",
      cow: "JP",
    },
    {
      id: uid(15),
      receivingInvoiceId: uid(12),
      partId: uid(6),
      wclItemNo: "RK73H1JTTD2202F",
      poNo: "PO-KOA-001",
      poLine: "2",
      qty: 5000,
      receivedQty: 5000,
      putAwayQty: 5000,
      boxId: "BOX-0002",
      dateCode: "2602",
      lotCode: "L2602B",
      coo: "JP",
      cow: "JP",
    },
    // pending order items — expected only
    {
      id: uid(16),
      receivingInvoiceId: uid(13),
      partId: uid(7),
      wclItemNo: "RK73B1JTTD181G",
      poNo: "PO-DAI-001",
      poLine: "1",
      qty: 5000,
      dateCode: "2610",
      coo: "JP",
    },
    {
      id: uid(17),
      receivingInvoiceId: uid(13),
      partId: uid(9),
      wclItemNo: "P413",
      poNo: "PO-DAI-001",
      poLine: "2",
      qty: 3000,
      dateCode: "2612",
      coo: "JP",
    },
  ]);

  // on-shelf stock produced by the cleared order (shelf lots: expected_qty = 0)
  await db.insert(inventoryLots).values([
    {
      id: uid(18),
      partId: uid(5),
      dateCode: "2601",
      lotCode: "L2601A",
      coo: "JP",
      cow: "JP",
      shelfCode: "A-01-01",
      boxId: "BOX-0001",
      warehouseSectionCode: "HK",
      subInventoryCode: "STORE1",
      supplierInvoiceNo: "04958166-W-01",
      expectedQty: 0,
      totalQty: 10000,
      allocatedQty: 0,
    },
    {
      id: uid(19),
      partId: uid(6),
      dateCode: "2602",
      lotCode: "L2602B",
      coo: "JP",
      cow: "JP",
      shelfCode: "A-01-02",
      boxId: "BOX-0002",
      warehouseSectionCode: "HK",
      subInventoryCode: "STORE1",
      supplierInvoiceNo: "04958166-W-01",
      expectedQty: 0,
      totalQty: 5000,
      allocatedQty: 0,
    },
  ]);

  await db.insert(inventoryLotSources).values([
    { id: uid(20), inventoryLotId: uid(18), receivingInvoiceItemId: uid(14), qty: 10000 },
    { id: uid(21), inventoryLotId: uid(19), receivingInvoiceItemId: uid(15), qty: 5000 },
  ]);

  // --- pending picking order --------------------------------------------------
  await db.insert(pickingOrders).values([
    {
      id: uid(22),
      refNo: "SO-2026-0001",
      poNo: "CUST-PO-8899",
      deliveryDate: new Date("2026-07-25"),
      requiredDateCodeNotice: "DC 2601+",
      shipTo: "ACME Electronics (HK)",
      destinationCountry: "HK",
      customerCode: "ACME",
      warehouseSectionCode: "HK",
      subInventoryCode: "STORE1",
      status: "pending",
    },
  ]);

  await db.insert(pickingItems).values([
    {
      id: uid(23),
      pickingOrderId: uid(22),
      partId: uid(5),
      qty: 2000,
      requiredDateCode: "2601+",
      sourceShelfCode: "A-01-01",
    },
    {
      id: uid(24),
      pickingOrderId: uid(22),
      partId: uid(6),
      qty: 1000,
      requiredDateCode: "2601+",
      sourceShelfCode: "A-01-02",
    },
  ]);

  // --- real data from new_seed/ (see seed-real-data.ts header) ----------------
  // Two pending receiving orders (refNo = folder name: 04958184, 65878) with
  // their real invoices/items, plus the related picking lists: picking.xlsx
  // invoices for 65878 and the TN (transfer note) PDFs for 04958184.
  await db.insert(parts).values([...realParts]);
  await db.insert(receivingOrders).values([...realReceivingOrders]);
  await db.insert(receivingInvoices).values([...realReceivingInvoices]);
  await db.insert(receivingInvoiceItems).values([...realReceivingInvoiceItems]);
  await db.insert(pickingOrders).values([...realPickingOrders]);
  await db.insert(pickingItems).values([...realPickingItems]);
}

/** Seed demo data when the users table is empty. Returns true when it seeded. */
export async function seedIfEmpty(sql: postgres.Sql, db: AppDb): Promise<boolean> {
  const rows = await sql`SELECT COUNT(*)::int AS c FROM users`;
  const c = Number((rows[0] as { c: string | number }).c);
  if (c > 0) return false;
  await seedAll(db);
  return true;
}

/** Dev-only: wipe everything and re-seed inside a transaction. */
export async function resetAndReseed(_sql: postgres.Sql, db: AppDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE ${sql.raw(ALL_TABLES.join(", "))} CASCADE`);
    await seedAll(tx as unknown as AppDb);
  });
}
