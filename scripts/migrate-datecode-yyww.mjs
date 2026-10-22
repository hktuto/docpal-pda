#!/usr/bin/env node
/**
 * One-time migration: canonical date codes WWYY -> YYWW.
 *
 * Spec: docs/superpowers/specs/2026-10-22-datecode-format-config-design.md
 *
 * Swaps every 4-digit date code in the matching/FIFO-critical tables:
 *   - inventory_lots.date_code          (stock lots — allocation FIFO, scans)
 *   - picking_packages.date_code        (source snapshot fallback)
 *   - picking_packages.scanned_date_code (pick-time scanned snapshot)
 *
 * NOT touched (receiving enclave stays label-format; historical audit rows
 * are display-only): receiving_orders, receiving_invoice_items, CN receiving
 * tables, inventory_transactions / transaction_logs batch snapshots,
 * outdated_scan_warnings, shelf_exchange, internal_transfer.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ RUN EXACTLY ONCE, in a maintenance window, ONLY after the deploy    │
 * │ that ships the canonical-YYWW conversion boundaries (put-away lot   │
 * │ writes, picking scan, label print encode). Re-running corrupts data │
 * │ — the script refuses when its marker row exists.                    │
 * │                                                                     │
 * │ EXTERNAL DEPENDENCY: the upstream sync service writes              │
 * │ inventory_lots directly and MUST be switched to YYWW writes before  │
 * │ or together with this migration (receiving_orders stay WWYY —       │
 * │ untouched by design). Verify no new WWYY lots arrive during the     │
 * │ window: the post-run check reports rows whose value no longer       │
 * │ parses as a plausible YYWW code.                                    │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Usage:
 *   node scripts/migrate-datecode-yyww.mjs <database-url> --yes
 *   node scripts/migrate-datecode-yyww.mjs <database-url>        # dry-run report
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const DATABASE_URL = process.argv[2];
const CONFIRM = process.argv.includes("--yes");

if (!DATABASE_URL) {
  console.error("Usage: node scripts/migrate-datecode-yyww.mjs <database-url> [--yes]");
  process.exit(1);
}

const require = createRequire(resolve(repoRoot, "apps/backend/package.json"));
const postgres = require("postgres");

const MARKER_KEY = "datecode_yyww_migration";
const SWAP = (col) => `right(${col}, 2) || left(${col}, 2)`;

const TABLES = [
  { table: "inventory_lots", column: "date_code" },
  { table: "picking_packages", column: "date_code" },
  { table: "picking_packages", column: "scanned_date_code" },
];

async function report(sql) {
  for (const { table, column } of TABLES) {
    const row = await sql.unsafe(
      `SELECT count(*)::int AS total,
              count(${column}) FILTER (WHERE ${column} ~ '^\\d{4}$') AS swappable,
              count(${column}) FILTER (WHERE ${column} IS NOT NULL AND ${column} !~ '^\\d{4}$') AS other
       FROM ${table}`
    );
    console.log(
      `  ${table}.${column}: ${row[0].swappable} swappable / ${row[0].other} other non-null / ${row[0].total} rows`
    );
  }
}

/** Rows that would be invalid as YYWW (week pair > 53) — pre-migration leftovers. */
async function suspiciousRows(sql) {
  const out = [];
  for (const { table, column } of TABLES) {
    const rows = await sql.unsafe(
      `SELECT ${column} AS code, count(*)::int AS n
       FROM ${table}
       WHERE ${column} ~ '^\\d{4}$' AND right(${column}, 2)::int > 53
       GROUP BY 1 ORDER BY 2 DESC LIMIT 5`
    );
    for (const r of rows) out.push(`${table}.${column} = '${r.code}' (${r.n} rows)`);
  }
  return out;
}

const sql = postgres(DATABASE_URL, { max: 1, connect_timeout: 10 });

try {
  console.log(`Connecting to ${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}...`);
  await sql`SELECT 1`;

  const marker = await sql`SELECT value FROM warehouse_config WHERE key = ${MARKER_KEY}`;
  if (marker.length > 0) {
    console.error(
      `\nREFUSING TO RUN: marker '${MARKER_KEY}' exists (migrated at ${marker[0].value.at}). ` +
        `This migration is NOT idempotent — re-running would corrupt date codes.`
    );
    process.exit(2);
  }

  console.log("\nPre-migration report:");
  await report(sql);

  if (!CONFIRM) {
    console.log("\nDry-run only. Re-run with --yes to execute the swap in a single transaction.");
    process.exit(0);
  }

  console.log("\nRunning swap in a single transaction...");
  await sql.begin(async (tx) => {
    for (const { table, column } of TABLES) {
      const r = await tx.unsafe(
        `UPDATE ${table} SET ${column} = ${SWAP(column)}, last_update_date = now()
         WHERE ${column} ~ '^\\d{4}$'`
      );
      console.log(`  ${table}.${column}: ${r.count} rows swapped`);
    }
    await tx.unsafe(
      `INSERT INTO warehouse_config (key, value, created_date, last_update_date)
       VALUES ($1, $2, now(), now())`,
      [MARKER_KEY, JSON.stringify({ at: new Date().toISOString() })]
    );
  });

  console.log("\nPost-migration report:");
  await report(sql);

  const suspicious = await suspiciousRows(sql);
  if (suspicious.length > 0) {
    console.log(
      "\nWARNING — values whose week pair is > 53 (invalid as YYWW). These are either " +
        "pre-existing non-standard codes or new WWYY lots written by an un-migrated sync " +
        "service during the window:"
    );
    for (const s of suspicious) console.log(`  ${s}`);
  } else {
    console.log("\nSanity check OK: no 4-digit values with week > 53 remain.");
  }
  console.log(
    "\nReminder: upstream sync must now write inventory_lots date codes as YYWW. " +
      "Receiving orders stay WWYY (receiving enclave) — do not 'fix' them."
  );
} finally {
  await sql.end();
}
