import { pgTable, text, integer, real, timestamp } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { defaultWarehouse } from "../../config.js";

// Demo users table; a ucenter_user integration may replace this later.
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull().default("operator"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
});

// Synced from AP_SUPPLIERS — keep this a pure sync mirror; PDA-local fields
// live in supplier_profiles.
export const suppliers = pgTable("suppliers", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  shortName: text("short_name"), // 供应商简称（来自 AP_SUPPLIERS 同步）
});

// PDA-local supplier profile: additional fields that do not come from the sync.
export const supplierProfiles = pgTable("supplier_profiles", {
  id: text("id").primaryKey(),
  // business key — survives id churn if the sync re-creates supplier rows
  supplierCode: text("supplier_code").notNull().unique().references(() => suppliers.code),
  name: text("name"), // local display-name override; null = use suppliers.name
  qrTemplate: text("qr_template"), // qrcode template (regex with named groups)
  qtyEncoding: text("qty_encoding"), // qty decoding rule, e.g. 'koa_zeros'
  remark: text("remark"), // other remark for extension
  createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
});

export const parts = pgTable("parts", {
  id: text("id").primaryKey(),
  partNo: text("part_no").notNull().unique(),
  wclItemNo: text("wcl_item_no"), // WCL Part No（同 receiving_invoice_items.wcl_item_no）
  internalCode: text("internal_code"),
  description: text("description"),
  defaultCoo: text("default_coo"),
});

export const shelves = pgTable("shelves", {
  code: text("code").primaryKey(),
  zone: text("zone"),
  orgId: integer("org_id"), // 办公室: HK, SZ, CME 等，用于区分不同办公室的货架位置
  warehouseCode: text("warehouse_code").notNull().default("HK1").$defaultFn(defaultWarehouse), // 所属仓库（实例默认 WAREHOUSE_CODE）
  warehouseSectionCode: text("warehouse_section_code").references(() => warehouseSections.code), // 所属仓库分区
  subInventoryCode: text("sub_inventory_code").references(() => subInventories.code), // 子库存代码: STORE1
  locationType: text("location_type").notNull().default("shelf"), // 'shelf' | 'dock'
  createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
});

// ------------------------------------------------------------------
// Lookup / reference tables
// ------------------------------------------------------------------

// Country lookup: short code → display name (destination country, COO, etc.)
export const countryList = pgTable("country_list", {
  code: text("code").primaryKey(), // ISO 3166-1 alpha-2, e.g. HK, CN, JP
  name: text("name").notNull(),
});

// Default box sizes offered at measuring/packing, "L X W X H" in cm
export const boxSizeList = pgTable("box_size_list", {
  code: text("code").primaryKey(), // e.g. "26 X 20 X 20"
  description: text("description"),
});

// Net-weight reference per item: `qty` units weigh `weight` grams → unit net = weight / qty
export const netWeightFormula = pgTable("net_weight_formula", {
  id: text("id").primaryKey(),
  partId: text("part_id").notNull().unique().references(() => parts.id),
  qty: integer("qty").notNull(),
  weight: real("weight").notNull(), // grams per `qty` units
});

export const customerProfiles = pgTable("customer_profiles", {
  code: text("code").primaryKey(),
  label: text("label").notNull(),
  remark: text("remark"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
});

// Warehouse sections: the middle stock level — warehouse → warehouse_section →
// sub_inventory. Sections belong to a warehouse instance (plain text, no
// warehouse table).
export const warehouseSections = pgTable("warehouse_sections", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  warehouseCode: text("warehouse_code").notNull().default("HK1").$defaultFn(defaultWarehouse), // 所属仓库（实例默认 WAREHOUSE_CODE）
});

// Warehouse sub-inventories: logical partitions of stock (e.g. STORE1, or a
// customer-segregated store when a customer requests separation).
export const subInventories = pgTable("sub_inventories", {
  code: text("code").primaryKey(), // e.g. STORE1
  name: text("name").notNull(),
  customerCode: text("customer_code").references(() => customerProfiles.code), // set for customer-segregated stores
});
