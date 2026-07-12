import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { now } from "../now.js";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(now),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});

export const suppliers = sqliteTable("suppliers", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  qrTemplate: text("qr_template"),
  qrcodeQtyEncoding: text("qrcode_qty_encoding"),
  createdAt: text("created_at").notNull().$defaultFn(now),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});

export const parts = sqliteTable(
  "parts",
  {
    id: text("id").primaryKey(),
    partNo: text("part_no").notNull(),
    partNoNorm: text("part_no_norm").notNull(),
    description: text("description"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ partNoNormIdx: index("parts_part_no_norm_idx").on(t.partNoNorm) })
);

export const shelves = sqliteTable("shelves", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  createdAt: text("created_at").notNull().$defaultFn(now),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});
