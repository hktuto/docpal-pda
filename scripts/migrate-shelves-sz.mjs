#!/usr/bin/env node
/**
 * Migrate SZ shelf data to a remote PostgreSQL database.
 *
 * Uses tsx to import the TypeScript seed file directly, then connects to
 * the target database and inserts the shelves.
 *
 * Usage:
 *   node scripts/migrate-shelves-sz.mjs [database-url]
 *
 * Defaults to postgresql://warehouse:warehouse@192.168.6.99:5432/warehouse_backend
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const DATABASE_URL =
  process.argv[2] ??
  "postgresql://warehouse:warehouse@192.168.6.99:5432/warehouse_backend";

// Resolve postgres from the backend package
const require = createRequire(resolve(repoRoot, "apps/backend/package.json"));
const postgres = require("postgres");

// Use tsx to import the TypeScript seed file
const { execSync } = await import("node:child_process");

// We'll use tsx to run a small inline script that outputs JSON
const tsxPath = resolve(repoRoot, "apps/backend/node_modules/.bin/tsx");
const seedPath = resolve(repoRoot, "apps/backend/src/db/seed-shelves-sz.ts");

// Generate a temp script that imports and exports the data as JSON
const tmpScript = resolve(repoRoot, "scripts/.tmp-export-shelves.ts");
const { writeFileSync, unlinkSync } = await import("node:fs");

writeFileSync(tmpScript, `
import { szShelves } from "${seedPath.replace(/\\/g, "/")}";
console.log(JSON.stringify(szShelves));
`);

try {
  const result = execSync(`"${tsxPath}" "${tmpScript}"`, {
    cwd: resolve(repoRoot, "apps/backend"),
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });

  const szShelves = JSON.parse(result.trim());
  console.log(`Parsed ${szShelves.length} shelves from seed file`);

  // --- Connect to remote database ---
  console.log(`Connecting to ${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}...`);

  const sql = postgres(DATABASE_URL, {
    max: 1,
    connect_timeout: 10,
  });

  try {
    // Test connection
    await sql`SELECT 1`;
    console.log("Connected successfully");

    // Check current shelf count
    const [{ count }] = await sql`SELECT COUNT(*)::int as count FROM shelves`;
    console.log(`Current shelves in database: ${count}`);

    // Dynamically find all tables with FK references to shelves
    const fkTables = await sql`
      SELECT DISTINCT
        tc.table_name AS table_name,
        kcu.column_name AS column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'shelves'
    `;

    console.log(`Found ${fkTables.length} tables with FK to shelves:`);
    for (const { table_name, column_name } of fkTables) {
      try {
        const [{ count }] = await sql`SELECT COUNT(*)::int as count FROM ${sql(table_name)} WHERE ${sql(column_name)} IS NOT NULL`;
        if (count > 0) {
          // For inventory_lots, set to NULL (don't delete inventory!)
          if (table_name === "inventory_lots") {
            await sql`UPDATE ${sql(table_name)} SET ${sql(column_name)} = NULL WHERE ${sql(column_name)} IS NOT NULL`;
            console.log(`  Nulled ${column_name} on ${count} rows in ${table_name}`);
          } else {
            await sql`DELETE FROM ${sql(table_name)} WHERE ${sql(column_name)} IS NOT NULL`;
            console.log(`  Cleared ${count} rows from ${table_name}`);
          }
        }
      } catch (e) {
        console.log(`  Could not clear ${table_name}: ${e.message}`);
      }
    }

    // Delete all existing shelves
    await sql`DELETE FROM shelves`;
    console.log("Cleared existing shelves");

    // Insert new shelves — map camelCase JS props to snake_case DB columns
    const rows = szShelves.map((s, i) => ({
      id: String(200 + i),
      code: s.code,
      display_name: s.displayName ?? null,
      zone: s.zone ?? null,
      sub_inventory_scopes: null,
      warning: s.warning ?? null,
    }));

    // Insert in batches of 200
    const batchSize = 200;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      await sql`INSERT INTO shelves ${sql(batch, "id", "code", "display_name", "zone", "sub_inventory_scopes", "warning")}`;
      console.log(`  Inserted ${Math.min(i + batchSize, rows.length)}/${rows.length}`);
    }

    // Verify
    const [{ count: newCount }] = await sql`SELECT COUNT(*)::int as count FROM shelves`;
    console.log(`\nMigration complete: ${newCount} shelves in database`);

    // Show some stats
    const zoneStats = await sql`
      SELECT zone, COUNT(*)::int as count 
      FROM shelves 
      GROUP BY zone 
      ORDER BY count DESC 
      LIMIT 10
    `;
    console.log("\nTop zones by shelf count:");
    for (const z of zoneStats) {
      console.log(`  ${z.zone || "(null)"}: ${z.count}`);
    }

  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }

} finally {
  // Clean up temp file
  try { unlinkSync(tmpScript); } catch {}
}
