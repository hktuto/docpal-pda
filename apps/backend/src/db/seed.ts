import postgres from "postgres";
import { sql } from "drizzle-orm";
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
  subInventoryTags,
  receivingOrders,
  receivingInvoices,
  receivingInvoiceItems,
  inventoryLots,
  inventoryLotSources,
  shelfBoxes,
  shelfBoxItems,
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

// Demo dataset, aligned with the apps/web / apps/api demo world:
//  - one CLEARED KOA receiving order whose two items are fully put away into
//    on-shelf inventory lots (with lot sources)
//  - one PENDING DAITO receiving order (expected only)
//  - one PENDING picking order against the stocked parts
// Derived rows (allocations, transactions, packages) are produced by business
// logic, not by the seed.
// opts.stockBoxes: seed the 10 demo stock shelf boxes (default on; tests turn
// it off so their exact-count assertions keep the minimal demo world).
async function seedAll(db: AppDb, opts?: { stockBoxes?: boolean }): Promise<void> {
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
    { id: uid(5), supplierCode: "KOA", partNo: "RK73H1JTTD1002F", wclItemNo: "RK73H1JTTD1002F", description: "RES 10K OHM 1% 1/10W 0603", defaultCoo: "JP" },
    { id: uid(6), supplierCode: "KOA", partNo: "RK73H1JTTD2202F", wclItemNo: "RK73H1JTTD2202F", description: "RES 22K OHM 1% 1/10W 0603", defaultCoo: "JP" },
    { id: uid(7), supplierCode: "KOA", partNo: "RK73B1JTTD181G", wclItemNo: "RK73B1JTTD181G", description: "RES 180 OHM 5% 1/10W 0603", defaultCoo: "JP" },
    { id: uid(8), supplierCode: "KOA", partNo: "RK73H2ATTD1372F", wclItemNo: "RK73H2ATTD1372F", description: "RES 13.7K OHM 1% 1/8W 0805", defaultCoo: "JP" },
    { id: uid(9), supplierCode: "DAITO", partNo: "P413", wclItemNo: "P413", description: "DAITO FUSE 1A", defaultCoo: "JP" },
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

  // Sub-inventories (new_seed/subInventories.xlsx): THREE levels — org_id →
  // code (sub-inventory group) → tag. Stock/docs reference the (org_id, code)
  // group via composite FK; tags are lookup-only (sub_inventory_tags).
  // ACME-S1 is the demo customer-segregated store.
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
  await db.insert(subInventoryTags).values([
    { orgId: 2, code: "STORE1", tag: "STORE1", name: "Store 1" },
    { orgId: 2, code: "WSTORE1", tag: "WSTORE1" },
    { orgId: 2, code: "OSWF (HK)", tag: "OSWF (HK)" },
    { orgId: 220, code: "THHK2", tag: "THHK2" },
    { orgId: 220, code: "OSWF (TH)", tag: "OSWF (TH)" },
    { orgId: 140, code: "STORE1", tag: "BJHK1" },
    { orgId: 140, code: "STORE1", tag: "GZHK1" },
    { orgId: 140, code: "STORE1", tag: "SHHK1" },
    { orgId: 140, code: "STORE1", tag: "SZHK1" },
    { orgId: 140, code: "ZTE", tag: "ZTE" },
    { orgId: 140, code: "OSWF (MCE)", tag: "OSWF (MCE)" },
    { orgId: 140, code: "HUAWEI", tag: "HUAWEI" },
    { orgId: 140, code: "HUAWEI", tag: "HUAWEI-CAR" },
    { orgId: 140, code: "HWOS (HUAWEI)", tag: "HWOS (HUAWEI)" },
    { orgId: 140, code: "DEFAULT", tag: "DEFAULT" },
    { orgId: 143, code: "store1", tag: "BJHK2" },
    { orgId: 143, code: "store1", tag: "GZHK2" },
    { orgId: 143, code: "store1", tag: "SHHK2" },
    { orgId: 143, code: "store1", tag: "SZHK2" },
    { orgId: 143, code: "OSWF (MCI)", tag: "OSWF (MCI)" },
    { orgId: 143, code: "DEFAULT", tag: "DEFAULT" },
    { orgId: 2, code: "ACME-S1", tag: "ACME-S1", name: "ACME segregated store" },
  ]);

  await db.insert(shelves).values([
    { code: "A-01-01", zone: "A" },
    { code: "A-01-02", zone: "A" },
    { code: "A-01-03", zone: "A" },
    { code: "A-01-04", zone: "A" },
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

  // --- cleared receiving order (fully received + put away) -------------------
  await db.insert(receivingOrders).values([
    {
      id: uid(10),
      batchNo: "04958166",
      supplierId: uid(3),
      deliveryDate: new Date("2026-07-10"),
      orgId: 2,
      subInventoryCode: "STORE1",
      status: "clear",
      arrivedAt: new Date("2026-07-10T09:30:00Z"),
      arrivedBy: uid(1),
    },
    // --- pending receiving order (expected only) -----------------------------
    {
      id: uid(11),
      batchNo: "04958210",
      supplierId: uid(4),
      deliveryDate: new Date("2026-07-20"),
      orgId: 2,
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
      subInventoryCode: "STORE1",
    },
  ]);

  await db.insert(receivingInvoiceItems).values([
    // cleared order items — fully received and put away
    {
      id: uid(14),
      receivingInvoiceId: uid(12),
      partNo: "RK73H1JTTD1002F",
      wclItemNo: "RK73H1JTTD1002F",
      poNo: "PO-KOA-001",
      poLine: "1",
      lineQty: 10000,
      receivedQty: 10000,
      putAwayQty: 10000,
      ctnNo: "BOX-0001",
      dateCode: "2601",
      lotCode: "L2601A",
      coo: "JP",
      cow: "JP",
    },
    {
      id: uid(15),
      receivingInvoiceId: uid(12),
      partNo: "RK73H1JTTD2202F",
      wclItemNo: "RK73H1JTTD2202F",
      poNo: "PO-KOA-001",
      poLine: "2",
      lineQty: 5000,
      receivedQty: 5000,
      putAwayQty: 5000,
      ctnNo: "BOX-0002",
      dateCode: "2602",
      lotCode: "L2602B",
      coo: "JP",
      cow: "JP",
    },
    // pending order items — expected only
    {
      id: uid(16),
      receivingInvoiceId: uid(13),
      partNo: "RK73B1JTTD181G",
      wclItemNo: "RK73B1JTTD181G",
      poNo: "PO-DAI-001",
      poLine: "1",
      lineQty: 5000,
      dateCode: "2610",
      coo: "JP",
    },
    {
      id: uid(17),
      receivingInvoiceId: uid(13),
      partNo: "P413",
      wclItemNo: "P413",
      poNo: "PO-DAI-001",
      poLine: "2",
      lineQty: 3000,
      dateCode: "2612",
      coo: "JP",
    },
  ]);

  // on-shelf stock produced by the cleared order
  await db.insert(inventoryLots).values([
    {
      id: uid(18),
      partNo: "RK73H1JTTD1002F",
      dateCode: "2601",
      lotCode: "L2601A",
      coo: "JP",
      cow: "JP",
      shelfCode: "A-01-01",
      boxId: "BOX-0001",
      orgId: 2,
      subInventoryCode: "STORE1",
      totalQty: 10000,
      allocatedQty: 0,
    },
    {
      id: uid(19),
      partNo: "RK73H1JTTD2202F",
      dateCode: "2602",
      lotCode: "L2602B",
      coo: "JP",
      cow: "JP",
      shelfCode: "A-01-02",
      boxId: "BOX-0002",
      orgId: 2,
      subInventoryCode: "STORE1",
      totalQty: 5000,
      allocatedQty: 0,
    },
  ]);

  await db.insert(inventoryLotSources).values([
    { id: uid(20), inventoryLotId: uid(18), receivingInvoiceItemId: uid(14), qty: 10000 },
    { id: uid(21), inventoryLotId: uid(19), receivingInvoiceItemId: uid(15), qty: 5000 },
  ]);

  // --- stocked shelf boxes ----------------------------------------------------
  // 10 closed boxes of on-shelf stock so goods verify, box lookup and stock
  // search have boxes to work with. Lots mirror the runtime put-away shape
  // (lot.box_id = shelf_boxes.id). Box ids use a past date so nextBoxId's
  // per-day seq never collides with them.
  if (opts?.stockBoxes !== false) {
    await db.insert(shelfBoxes).values([
    { id: "BOX-H-20260701-0001", shelfCode: "A-01-01", orgId: 2, subInventoryCode: "STORE1", status: "closed" },
    { id: "BOX-H-20260701-0002", shelfCode: "A-01-01", orgId: 2, subInventoryCode: "STORE1", status: "closed" },
    { id: "BOX-H-20260701-0003", shelfCode: "A-01-02", orgId: 2, subInventoryCode: "STORE1", status: "closed" },
    { id: "BOX-H-20260701-0004", shelfCode: "A-01-02", orgId: 2, subInventoryCode: "STORE1", status: "closed" },
    { id: "BOX-H-20260701-0005", shelfCode: "A-01-03", orgId: 2, subInventoryCode: "STORE1", status: "closed" },
    { id: "BOX-H-20260701-0006", shelfCode: "A-01-03", orgId: 2, subInventoryCode: "STORE1", status: "closed" },
    { id: "BOX-H-20260701-0007", shelfCode: "A-01-04", orgId: 2, subInventoryCode: "STORE1", status: "closed" },
    { id: "BOX-H-20260701-0008", shelfCode: "A-01-04", orgId: 2, subInventoryCode: "STORE1", status: "closed" },
    { id: "BOX-H-20260701-0009", shelfCode: "W-01-01", orgId: 2, subInventoryCode: "WSTORE1", status: "closed" },
    { id: "BOX-H-20260701-0010", shelfCode: "W-01-01", orgId: 2, subInventoryCode: "WSTORE1", status: "closed" },
  ]);

  await db.insert(shelfBoxItems).values([
    { id: uid(30), shelfBoxId: "BOX-H-20260701-0001", partNo: "RK73H1JTTD1002F", qty: 10000 },
    { id: uid(31), shelfBoxId: "BOX-H-20260701-0002", partNo: "RK73H1JTTD2202F", qty: 5000 },
    { id: uid(32), shelfBoxId: "BOX-H-20260701-0003", partNo: "RK73B1JTTD181G", qty: 8000 },
    { id: uid(33), shelfBoxId: "BOX-H-20260701-0004", partNo: "RK73H2ATTD1372F", qty: 4000 },
    { id: uid(34), shelfBoxId: "BOX-H-20260701-0005", partNo: "P413", qty: 2000 },
    { id: uid(35), shelfBoxId: "BOX-H-20260701-0006", partNo: "RK73H1JTTD1002F", qty: 10000 },
    { id: uid(36), shelfBoxId: "BOX-H-20260701-0007", partNo: "RK73H1JTTD2202F", qty: 5000 },
    { id: uid(37), shelfBoxId: "BOX-H-20260701-0008", partNo: "RK73B1JTTD181G", qty: 6000 },
    { id: uid(38), shelfBoxId: "BOX-H-20260701-0009", partNo: "RK73H2ATTD1372F", qty: 3000 },
    { id: uid(39), shelfBoxId: "BOX-H-20260701-0010", partNo: "P413", qty: 1500 },
  ]);

  await db.insert(inventoryLots).values([
    { id: uid(40), partNo: "RK73H1JTTD1002F", dateCode: "2603", lotCode: "L2603A", coo: "JP", cow: "JP",
      shelfCode: "A-01-01", boxId: "BOX-H-20260701-0001",
      orgId: 2, subInventoryCode: "STORE1",
      totalQty: 10000, allocatedQty: 0 },
    { id: uid(41), partNo: "RK73H1JTTD2202F", dateCode: "2603", lotCode: "L2603B", coo: "JP", cow: "JP",
      shelfCode: "A-01-01", boxId: "BOX-H-20260701-0002",
      orgId: 2, subInventoryCode: "STORE1",
      totalQty: 5000, allocatedQty: 0 },
    { id: uid(42), partNo: "RK73B1JTTD181G", dateCode: "2604", lotCode: "L2604A", coo: "JP", cow: "JP",
      shelfCode: "A-01-02", boxId: "BOX-H-20260701-0003",
      orgId: 2, subInventoryCode: "STORE1",
      totalQty: 8000, allocatedQty: 0 },
    { id: uid(43), partNo: "RK73H2ATTD1372F", dateCode: "2604", lotCode: "L2604B", coo: "JP", cow: "JP",
      shelfCode: "A-01-02", boxId: "BOX-H-20260701-0004",
      orgId: 2, subInventoryCode: "STORE1",
      totalQty: 4000, allocatedQty: 0 },
    { id: uid(44), partNo: "P413", dateCode: "2605", lotCode: "L2605A", coo: "JP", cow: "JP",
      shelfCode: "A-01-03", boxId: "BOX-H-20260701-0005",
      orgId: 2, subInventoryCode: "STORE1",
      totalQty: 2000, allocatedQty: 0 },
    { id: uid(45), partNo: "RK73H1JTTD1002F", dateCode: "2605", lotCode: "L2605B", coo: "JP", cow: "JP",
      shelfCode: "A-01-03", boxId: "BOX-H-20260701-0006",
      orgId: 2, subInventoryCode: "STORE1",
      totalQty: 10000, allocatedQty: 0 },
    { id: uid(46), partNo: "RK73H1JTTD2202F", dateCode: "2606", lotCode: "L2606A", coo: "JP", cow: "JP",
      shelfCode: "A-01-04", boxId: "BOX-H-20260701-0007",
      orgId: 2, subInventoryCode: "STORE1",
      totalQty: 5000, allocatedQty: 0 },
    { id: uid(47), partNo: "RK73B1JTTD181G", dateCode: "2606", lotCode: "L2606B", coo: "JP", cow: "JP",
      shelfCode: "A-01-04", boxId: "BOX-H-20260701-0008",
      orgId: 2, subInventoryCode: "STORE1",
      totalQty: 6000, allocatedQty: 0 },
    { id: uid(48), partNo: "RK73H2ATTD1372F", dateCode: "2607", lotCode: "L2607A", coo: "JP", cow: "JP",
      shelfCode: "W-01-01", boxId: "BOX-H-20260701-0009",
      orgId: 2, subInventoryCode: "WSTORE1",
      totalQty: 3000, allocatedQty: 0 },
    { id: uid(49), partNo: "P413", dateCode: "2607", lotCode: "L2607B", coo: "JP", cow: "JP",
      shelfCode: "W-01-01", boxId: "BOX-H-20260701-0010",
      orgId: 2, subInventoryCode: "WSTORE1",
      totalQty: 1500, allocatedQty: 0 },
  ]);
  }

  // --- pending picking order --------------------------------------------------
  await db.insert(pickingOrders).values([
    {
      id: uid(22),
      orderNo: "SO-2026-0001",
      poNo: "CUST-PO-8899",
      deliveryDate: new Date("2026-07-25"),
      shipTo: "ACME Electronics (HK)",
      customerCode: "ACME",
      orgId: 2,
      subInventoryCode: "STORE1",
      status: "pending",
    },
  ]);

  await db.insert(pickingItems).values([
    {
      id: uid(23),
      pickingOrderId: uid(22),
      partNo: "RK73H1JTTD1002F",
      qty: 2000,
    },
    {
      id: uid(24),
      pickingOrderId: uid(22),
      partNo: "RK73H1JTTD2202F",
      qty: 1000,
    },
  ]);

  // --- real data from new_seed/ (see seed-real-data.ts header) ----------------
  // Two pending receiving orders (batchNo = folder name: 04958184, 65878) with
  // their real invoices/items, plus the related picking lists: picking.xlsx
  // invoices for 65878 and the TN (transfer note) PDFs for 04958184.
  // Map legacy tag-level sub-inventory values (SZHK1, GZHK2, …) in the
  // real-data seed rows to their (org_id, code) group per the xlsx structure
  // (the composite FK rejects tag values at insert time).
  const mapPair = remapLegacyPair;
  await db.insert(parts).values([...realParts]);
  await db.insert(receivingOrders).values(realReceivingOrders.map(mapPair));
  await db.insert(receivingInvoices).values(realReceivingInvoices.map(mapPair));
  await db.insert(receivingInvoiceItems).values(realReceivingInvoiceItems.map(mapPair));
  await db.insert(pickingOrders).values(realPickingOrders.map(mapPair));
  await db.insert(pickingItems).values([...realPickingItems]);

  // Allocation priority: creation order is the initial queue order (admin
  // reorders afterwards via POST /picking-orders/reorder).
  await db.execute(sql`
    UPDATE picking_orders SET priority_seq = r.seq
    FROM (SELECT id, row_number() OVER (ORDER BY created_at) AS seq FROM picking_orders) r
    WHERE picking_orders.id = r.id`);
}

/** Legacy tag → (orgId, subInventoryCode) group (per new_seed/subInventories.xlsx). */
const LEGACY_TAG_GROUPS: Record<string, { orgId: number; subInventoryCode: string }> = {
  BJHK1: { orgId: 140, subInventoryCode: "STORE1" },
  GZHK1: { orgId: 140, subInventoryCode: "STORE1" },
  SHHK1: { orgId: 140, subInventoryCode: "STORE1" },
  SZHK1: { orgId: 140, subInventoryCode: "STORE1" },
  BJHK2: { orgId: 143, subInventoryCode: "store1" },
  GZHK2: { orgId: 143, subInventoryCode: "store1" },
  SHHK2: { orgId: 143, subInventoryCode: "store1" },
  SZHK2: { orgId: 143, subInventoryCode: "store1" },
  "HUAWEI-CAR": { orgId: 140, subInventoryCode: "HUAWEI" },
};

function remapLegacyPair<T extends object>(row: T): T {
  const r = row as { orgId?: number | null; subInventoryCode?: string | null };
  const g = r.subInventoryCode ? LEGACY_TAG_GROUPS[r.subInventoryCode] : undefined;
  return g ? { ...row, orgId: g.orgId, subInventoryCode: g.subInventoryCode } : row;
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
export async function resetAndReseed(_sql: postgres.Sql, db: AppDb, opts?: { stockBoxes?: boolean }): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE ${sql.raw(ALL_TABLES.join(", "))} CASCADE`);
    await seedAll(tx as unknown as AppDb, opts);
  });
}
