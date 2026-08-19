import { pgTable, foreignKey, index, unique, uniqueIndex, text, integer, real, timestamp, jsonb } from "drizzle-orm/pg-core";
import { now } from "../now.js";

// Local users table; a ucenter_user integration may replace this later
// (syncable by username). password_hash holds scrypt:N:r:p:salt:hash (see
// src/auth/password.ts); legacy plain-text rows are upgraded on login.
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});

// User groups (replaces the old users.role text column). Membership is
// many-to-many via user_group_members; tokens carry the full group-code list.
export const userGroups = pgTable("user_groups", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  remark: text("remark"),
  createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});

export const userGroupMembers = pgTable(
  "user_group_members",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupCode: text("group_code")
      .notNull()
      .references(() => userGroups.code, { onDelete: "cascade" }),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => [uniqueIndex("user_group_members_user_group_unique").on(t.userId, t.groupCode)]
);

// Synced from AP_SUPPLIERS — keep this a pure sync mirror; PDA-local fields
// live in supplier_profiles.
export const suppliers = pgTable("suppliers", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  shortName: text("short_name"), // 供应商简称（来自 AP_SUPPLIERS 同步）
  creationDate: timestamp("creation_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});

// PDA-local supplier profile: additional fields that do not come from the sync.
export const supplierProfiles = pgTable("supplier_profiles", {
  id: text("id").primaryKey(),
  // business key — survives id churn if the sync re-creates supplier rows
  supplierCode: text("supplier_code").notNull().unique().references(() => suppliers.code),
  name: text("name"), // local display-name override; null = use suppliers.name
  qrTemplate: text("qr_template"), // qrcode template (regex with named groups)
  // structured definition the admin QR-template editor generates qr_template
  // from ({version, mode: delimited|fixed|advanced, delimiter, fields}) —
  // null for hand-written legacy templates (editor opens in advanced mode)
  qrTemplateConfig: jsonb("qr_template_config"),
  qrType: text("qr_type"), // qrcode type, e.g. isbn, ban 14, ban 16
  qtyEncoding: text("qty_encoding"), // qty decoding rule, e.g. 'koa_zeros'
  remark: text("remark"), // other remark for extension
  creationDate: timestamp("creation_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});

// Part master. Kept in this database (the upstream system may or may not
// provide one). part_no is NOT unique (the same supplier part number can
// appear under several WCL item numbers) — wcl_item_no is the unique business
// key and the ingest dedup key. Other tables carry part_no as plain text (no
// FK — Postgres requires a unique FK target).
export const parts = pgTable("parts", {
  id: text("id").primaryKey(),
  brand: text("brand").notNull(), // 品牌（供应商业务代码的纯文本拷贝，无 FK — 一个供应商有多个 part，不唯一）
  partNo: text("part_no").notNull(), // 供应商 part number — 不唯一
  wclItemNo: text("wcl_item_no").unique(), // WCL Part No（唯一业务 key — ingest dedup key；同 receiving_invoice_items.wcl_item_no）
  description: text("description"),
  creationDate: timestamp("creation_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
},
(t) => ({
  // part_no is not unique — plain lookup index (ingest existence checks, stock search)
  partNoIdx: index("idx_parts_part_no").on(t.partNo),
})
);

export const shelves = pgTable("shelves", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  zone: text("zone"),
  // 货架偏好子库存列表 (advisory, multi sub-inventory) — ranks put-away shelf
  // suggestions for parts with no stock history; NULL/empty = shared / any
  // sub-inventory. Not enforced at scan time
  // (spec 2026-08-12-put-away-shelf-org-suggestion-design.md).
  subInventoryCodes: text("sub_inventory_codes").array(),
  createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});

// ------------------------------------------------------------------
// Lookup / reference tables
// ------------------------------------------------------------------

// Country lookup: short code → display name (destination country, COO, etc.)
export const countryList = pgTable("country_list", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(), // ISO 3166-1 alpha-2, e.g. HK, CN, JP
  name: text("name").notNull(),
  createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});

// Default box sizes offered at measuring/packing, "L X W X H" in cm
export const boxSizeList = pgTable("box_size_list", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(), // e.g. "26 X 20 X 20"
  description: text("description"),
  createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});

// Net-weight reference per item: `qty` units weigh `weight` grams → unit net = weight / qty
// part_no is plain text (no FK — parts.part_no is not unique).
export const netWeightFormula = pgTable("net_weight_formula", {
  id: text("id").primaryKey(),
  partNo: text("part_no").notNull().unique(),
  qty: integer("qty").notNull(),
  weight: real("weight").notNull(), // grams per `qty` units
  createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});

export const customerProfiles = pgTable("customer_profiles", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  rule: text("rule"), // customer custom requirement/formula (stored, not yet interpreted)
  remark: text("remark"),
  createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});

// Warehouse sub-inventories: logical partitions of stock inside one org
// (Oracle EBS organization + subinventory — the pair org_id +
// Org info group table (formerly sub_inventories): the (org_id,
// secondary_inventory_name) GROUP level that all stock/doc tables reference
// (composite FK — referencing columns keep the name sub_inventory_code).
// Column names mirror the upstream DocPal/Oracle org_info schema; office_code /
// organization_id are upstream fields the PDA does not use (nullable).
// Cross-store sharing for allocation is declared per warehouse in
// sub_inventory_share_members below.
export const subInventories = pgTable(
  "org_info",
  {
    id: text("id").primaryKey(),
    officeCode: text("office_code"), // upstream office code (unused locally)
    organizationId: integer("organization_id"), // upstream org id (Oracle NUMBER → integer here)
    orgId: integer("org_id").notNull(), // 所属办公室 — 与 secondary_inventory_name 配对识别库存分区
    secondaryInventoryName: text("secondary_inventory_name").notNull(), // 子库存 (group level), e.g. STORE1
    subinvDescription: text("subinv_description"),
    creationDate: timestamp("creation_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    // table-level UNIQUE constraint (not a bare index) so composite FKs to
    // (org_id, secondary_inventory_name) resolve — the constraint lands inline
    // in CREATE TABLE, before the FK ALTERs in the migration.
    orgSubinvUq: unique("org_info_org_subinv_unique").on(t.orgId, t.secondaryInventoryName),
  })
);

// Warehouse-declared stock sharing between sub-inventories: members of the
// same share_group may serve each other's picking demands (allocation still
// matches org_id + sub_inventory_code — the group widens the code match to
// sibling members). UNIQUE (org_id, code): a sub-inventory joins at most one
// group. Configured per warehouse via /admin/sub-inventory-share-groups;
// lookup-only for everything except the allocation engine.
export const subInventoryShareMembers = pgTable(
  "sub_inventory_share_members",
  {
    id: text("id").primaryKey(),
    orgId: integer("org_id").notNull(),
    code: text("code").notNull(),
    shareGroup: text("share_group").notNull(), // free-text group code, e.g. HK
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    orgCodeUq: uniqueIndex("sub_inv_share_members_org_code_unique").on(t.orgId, t.code),
    groupIdx: index("idx_sub_inv_share_members_group").on(t.shareGroup),
    groupFk: foreignKey({
      name: "sub_inventory_share_members_group_fk",
      columns: [t.orgId, t.code],
      foreignColumns: [subInventories.orgId, subInventories.secondaryInventoryName],
    }),
  })
);

