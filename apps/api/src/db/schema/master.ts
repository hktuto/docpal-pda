import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { now } from "../now.js";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull().default("operator"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
});

export const suppliers = pgTable("suppliers", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  shortName: text("short_name"),
});

export const parts = pgTable("parts", {
  id: text("id").primaryKey(),
  partNo: text("part_no").notNull().unique(),
  internalCode: text("internal_code"),
  description: text("description"),
  defaultCoo: text("default_coo"),
});

export const shelves = pgTable("shelves", {
  code: text("code").primaryKey(),
  zone: text("zone"),
  orgId: integer("org_id"),
  subInventoryCode: text("sub_inventory_code"),
  locationType: text("location_type", { enum: ["shelf", "dock"] }).notNull().default("shelf"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
});
