import { pgTable, primaryKey, text, integer, real, timestamp } from "drizzle-orm/pg-core";
import { now } from "../now.js";

// Local users table; a ucenter_user integration may replace this later
// (syncable by username). password_hash holds scrypt:N:r:p:salt:hash (see
// src/auth/password.ts); legacy plain-text rows are upgraded on login.
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
});

// User groups (replaces the old users.role text column). Membership is
// many-to-many via user_group_members; tokens carry the full group-code list.
export const userGroups = pgTable("user_groups", {
  code: text("code").primaryKey(),
  label: text("label").notNull(),
  remark: text("remark"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
});

export const userGroupMembers = pgTable(
  "user_group_members",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupCode: text("group_code")
      .notNull()
      .references(() => userGroups.code, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.groupCode] })]
);

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
  qrType: text("qr_type"), // qrcode type, e.g. isbn, ban 14, ban 16
  qtyEncoding: text("qty_encoding"), // qty decoding rule, e.g. 'koa_zeros'
  remark: text("remark"), // other remark for extension
  createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
});

// Part master. Kept in this database (the upstream system may or may not
// provide one); other tables reference parts by part_no, not by UUID.
export const parts = pgTable("parts", {
  id: text("id").primaryKey(),
  supplierCode: text("supplier_code").notNull().references(() => suppliers.code), // 供应商业务代码（一个供应商有多个 part，不唯一）
  partNo: text("part_no").notNull().unique(), // 所有其他表通过 part_no 引用
  wclItemNo: text("wcl_item_no"), // WCL Part No（同 receiving_invoice_items.wcl_item_no）
  description: text("description"),
  defaultCoo: text("default_coo"),
});

export const shelves = pgTable("shelves", {
  code: text("code").primaryKey(),
  zone: text("zone"),
  orgId: integer("org_id"), // 办公室: HK, SZ, CME 等，用于区分不同办公室的货架位置
  subInventoryCode: text("sub_inventory_code").references(() => subInventories.code), // 子库存代码: STORE1
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
  partNo: text("part_no").notNull().unique().references(() => parts.partNo),
  qty: integer("qty").notNull(),
  weight: real("weight").notNull(), // grams per `qty` units
});

export const customerProfiles = pgTable("customer_profiles", {
  code: text("code").primaryKey(),
  label: text("label").notNull(),
  rule: text("rule"), // customer custom requirement/formula (stored, not yet interpreted)
  remark: text("remark"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
});

// Warehouse sub-inventories: logical partitions of stock inside one org
// (Oracle EBS organization + subinventory — the pair org_id +
// sub_inventory_code identifies stock partitioning). org_id is the office the
// sub-inventory belongs to (plain integer office id, no FK to a lookup);
// customer_code is set for customer-segregated stores.
export const subInventories = pgTable("sub_inventories", {
  code: text("code").primaryKey(), // e.g. STORE1
  name: text("name").notNull(),
  orgId: integer("org_id").notNull(), // 所属办公室, 2: HK — 与 sub_inventory_code 配对识别库存分区
  customerCode: text("customer_code").references(() => customerProfiles.code), // set for customer-segregated stores
  createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
});
