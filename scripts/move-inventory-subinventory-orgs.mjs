#!/usr/bin/env node
// Move every inventory lot in these sub-inventories to its target org:
//   GZSZ -> 14, BJSZ -> 12, SHSZ -> 5.
// Safe to rerun: lots already in the target org are left untouched.
// Defaults to a dry run; pass --yes to commit all three patches together.
//
// Usage:
//   node scripts/move-inventory-subinventory-orgs.mjs [database-url] [--yes]
//
// The default database URL matches scripts/migrate-shelves-sz.mjs.

import { createRequire } from "node:module";

const require = createRequire(
  new URL("../apps/backend/package.json", import.meta.url)
);
const postgres = require("postgres");

const args = process.argv.slice(2);
const confirm = args.includes("--yes");
const databaseUrl =
  args.find((arg) => !arg.startsWith("--")) ??
  "postgresql://warehouse:warehouse@192.168.6.99:5432/warehouse_backend";
const moves = [
  { subInventoryCode: "GZSZ", targetOrgId: 14 },
  { subInventoryCode: "BJSZ", targetOrgId: 12 },
  { subInventoryCode: "SHSZ", targetOrgId: 5 },
];
const pickingOrderId = "01M5KVEDS4WQX6F73M0K3AYYBQ";
const pickingPartNo = "NDK+NX3225SA-25.000M-STD-CRS-2";

const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });

async function report(db, { subInventoryCode }) {
  const rows = await db`
    SELECT org_id, count(*)::int AS lots,
           coalesce(sum(total_qty), 0)::bigint AS total_qty,
           coalesce(sum(allocated_qty), 0)::bigint AS allocated_qty
    FROM inventory_lots
    WHERE sub_inventory_code = ${subInventoryCode}
    GROUP BY org_id
    ORDER BY org_id NULLS FIRST
  `;
  console.log(`\n${subInventoryCode} inventory:`);
  if (rows.length === 0) console.log("  no lots found");
  for (const row of rows) {
    console.log(
      `  org ${row.org_id ?? "NULL"}: ${row.lots} lots, ` +
        `${row.total_qty} total qty, ${row.allocated_qty} allocated qty`
    );
  }
}

async function validate(db, { subInventoryCode, targetOrgId }) {
  const target = await db`
    SELECT 1 FROM org_info
    WHERE org_id = ${targetOrgId}
      AND secondary_inventory_name = ${subInventoryCode}
  `;
  if (target.length === 0) {
    throw new Error(
      `org_info has no (${targetOrgId}, ${subInventoryCode}) mapping; ` +
        "create that mapping before moving its inventory"
    );
  }

  const collisions = await db`
    SELECT source.id AS source_id, target.id AS target_id, source.part_no
    FROM inventory_lots source
    JOIN inventory_lots target
      ON target.org_id = ${targetOrgId}
     AND target.sub_inventory_code = ${subInventoryCode}
     AND target.part_no = source.part_no
     AND target.date_code = source.date_code
     AND target.coo = source.coo
     AND target.cow = source.cow
     AND target.shelf_code = source.shelf_code
     AND target.box_id = source.box_id
    WHERE source.sub_inventory_code = ${subInventoryCode}
      AND source.org_id IS DISTINCT FROM ${targetOrgId}
      AND (source.shelf_code IS NOT NULL OR source.box_id IS NOT NULL)
    LIMIT 10
  `;
  if (collisions.length > 0) {
    const detail = collisions
      .map(
        (row) =>
          `${row.part_no}: source ${row.source_id}, target ${row.target_id}`
      )
      .join("\n  ");
    throw new Error(
      `moving ${subInventoryCode} lots to org ${targetOrgId} would violate ` +
        `inventory_lots_unique_lot; merge or relocate the duplicate lots first:\n  ${detail}`
    );
  }
}

try {
  console.log(`Connecting to ${databaseUrl.replace(/:[^:@]+@/, ":***@")}...`);
  await sql`SELECT 1`;
  for (const move of moves) {
    await report(sql, move);
    await validate(sql, move);
  }

  if (!confirm) {
    console.log("\nDry run only. Re-run with --yes to apply all three patches.");
    process.exit(0);
  }

  const updated = await sql.begin(async (tx) => {
    await tx`LOCK TABLE inventory_lots IN SHARE ROW EXCLUSIVE MODE`;
    const results = [];
    for (const move of moves) {
      const { subInventoryCode, targetOrgId } = move;
      await validate(tx, move);
      const rows = await tx`
        WITH moved AS (
          UPDATE inventory_lots
          SET org_id = ${targetOrgId}, last_update_date = now()
          WHERE sub_inventory_code = ${subInventoryCode}
            AND org_id IS DISTINCT FROM ${targetOrgId}
          RETURNING total_qty
        )
        SELECT count(*)::int AS lots,
               coalesce(sum(total_qty), 0)::bigint AS total_qty
        FROM moved
      `;
      results.push({ ...move, ...rows[0] });
    }
    return results;
  });

  for (const move of updated) {
    console.log(
      `\nMoved ${move.lots} ${move.subInventoryCode} lots ` +
        `(${move.total_qty} total qty) to org ${move.targetOrgId}.`
    );
    await report(sql, move);

    const [{ remaining }] = await sql`
      SELECT count(*)::int AS remaining
      FROM inventory_lots
      WHERE sub_inventory_code = ${move.subInventoryCode}
        AND org_id IS DISTINCT FROM ${move.targetOrgId}
    `;
    if (remaining !== 0) {
      throw new Error(
        `${remaining} ${move.subInventoryCode} lots remain outside org ${move.targetOrgId}`
      );
    }
  }

  const stock = await sql`
    SELECT org_id, sub_inventory_code, part_no, shelf_code, box_id,
           total_qty, allocated_qty, available_qty
    FROM inventory_lots
    WHERE sub_inventory_code = 'GZSZ'
      AND part_no = ${pickingPartNo}
    ORDER BY shelf_code, box_id, id
  `;
  console.log(`\nPicking-order stock check (${pickingOrderId}):`);
  if (stock.length === 0) {
    console.log(`  no ${pickingPartNo} lots found in GZSZ`);
  } else {
    for (const row of stock) {
      console.log(
        `  org ${row.org_id}/${row.sub_inventory_code} ${row.part_no}: ` +
          `${row.available_qty} available at ${row.shelf_code ?? "dock"}` +
          (row.box_id ? ` / ${row.box_id}` : "")
      );
    }
  }
  console.log("\nAll three patches committed successfully.");
} finally {
  await sql.end();
}
