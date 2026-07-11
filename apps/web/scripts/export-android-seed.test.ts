import { describe, it } from "vitest";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "~/db/schema";
import { createTablesSql } from "~/db/init";
import { seedDb, ensureDemoPasswords } from "~/db/seed-precalc";

// FK-safe insert order (parents before children). Order only matters for
// readability here — the Android schema declares no FK constraints.
const TABLES = [
  "users",
  "suppliers",
  "parts",
  "shelves",
  "receiving_orders",
  "receiving_invoices",
  "receiving_invoice_items",
  "receiving_item_mismatches",
  "picking_orders",
  "picking_items",
  "picking_packages",
  "measuring_tasks",
  "shipping_boxes",
  "shelf_boxes",
  "put_away_scans",
  "inventory_lots",
  "inventory_lot_sources",
  "allocations",
  "transition_logs",
] as const;

// Web TIMESTAMP columns, stored as epoch-ms INTEGER on Android.
const TIMESTAMP_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "delivery_date",
  "arrived_at",
  "reported_at",
  "confirmed_at",
  "cancelled_at",
  "issue_reported_at",
  "verified_at",
]);

function toSqlLiteral(value: unknown, column: string): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return String(value.getTime());
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  if (TIMESTAMP_COLUMNS.has(column) && typeof value === "string") {
    return String(new Date(value).getTime());
  }
  // One statement per line on the Android side, so flatten newlines.
  return "'" + String(value).replace(/[\r\n]+/g, " ").replace(/'/g, "''") + "'";
}

describe("export-android-seed", () => {
  it("writes ../android/app/src/main/assets/seed.sql", async () => {
    const pg = new PGlite();
    await pg.waitReady;
    await pg.exec(createTablesSql);
    const db = drizzle(pg, { schema });

    await seedDb(db);
    await ensureDemoPasswords(db);

    const lines: string[] = [];
    for (const table of TABLES) {
      const result = await pg.query(`SELECT * FROM ${table}`);
      for (const row of result.rows as Record<string, unknown>[]) {
        const columns = Object.keys(row);
        const values = columns.map((c) => toSqlLiteral(row[c], c));
        lines.push(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")});`
        );
      }
    }

    const outPath = "../android/app/src/main/assets/seed.sql";
    fs.mkdirSync("../android/app/src/main/assets", { recursive: true });
    fs.writeFileSync(outPath, lines.join("\n") + "\n");
    console.log(`Wrote ${lines.length} INSERT statements to ${outPath}`);
  });
});
