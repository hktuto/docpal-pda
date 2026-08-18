import { ShapeStream, type Offset } from "@electric-sql/client";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { createDb } from "../db/client.js";
import { syncCheckpoints } from "../db/schema/index.js";
import {
  upsertPart,
  deletePart,
  upsertSupplier,
  deleteSupplier,
  deleteSubInventory,
} from "../db/ingest.js";
import { now } from "../db/now.js";
import { ORDER_TABLE_SYNCS, ParentNotReadyError } from "./orders.js";

// ---------------------------------------------------------------------------
// Electric sync consumer (spec:
// docs/superpowers/specs/2026-08-18-electric-sql-sync-design.md).
//
// Pulls changes from the remote DocPal master DB (schema "demo", wms_* tables)
// through a self-hosted Electric service into the local master-data tables.
// One ShapeStream per table; each stream resumes from its sync_checkpoints
// row. Electric messages always carry the row PK; replica:"full" makes every
// update/delete carry the whole row so the natural-key apply functions have
// everything they need.
//
// Column ownership: the consumer writes ONLY remote-owned columns. Local-only
// columns (e.g. sub_inventories.customer_code) are never touched — which is
// why sub_inventories applies through its own SQL instead of
// upsertSubInventory (that function nulls customer_code when unspecified).
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown>;

export interface TableSync {
  remoteTable: string; // e.g. "demo.wms_parts"
  columns: string[]; // remote-owned columns included in the shape
  // "full" (default): every update/delete carries the whole row — master data
  // needs the business key even when unchanged. "default": PK + changed
  // columns — order tables key on the remote id, so partial rows suffice.
  replica?: "full" | "default";
  upsert: (db: AppDb, row: Row) => Promise<void>;
  remove: (db: AppDb, row: Row) => Promise<void>;
  // Post-batch hook (e.g. allocation recompute after order changes).
  afterBatch?: (db: AppDb) => Promise<void>;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : str(value);
}

// numeric arrives as a JSON number from the shape log; local columns are int.
function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/** 404/409 from the delete guards are expected during sync — log and skip. */
async function removeGuarded(remoteTable: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof HTTPException && (e.status === 404 || e.status === 409)) {
      console.warn(`[sync] ${remoteTable} delete skipped: ${e.message}`);
      return;
    }
    throw e;
  }
}

const TABLE_SYNCS: TableSync[] = [
  {
    remoteTable: "demo.wms_suppliers",
    columns: ["id", "code", "name", "short_name"],
    upsert: (db, r) =>
      upsertSupplier(db, str(r.code), {
        id: str(r.id),
        name: str(r.name),
        shortName: strOrNull(r.short_name),
      }).then(() => undefined),
    remove: (db, r) => removeGuarded("wms_suppliers", () => deleteSupplier(db, str(r.code))),
  },
  {
    remoteTable: "demo.wms_parts",
    columns: ["id", "part_no", "wcl_item_no", "brand", "description"],
    upsert: (db, r) => {
      // Local parts.brand is NOT NULL; remote is nullable — coalesce + warn.
      let brand = strOrNull(r.brand);
      if (brand === null) {
        console.warn(`[sync] wms_parts ${str(r.wcl_item_no)}: NULL brand coerced to ""`);
        brand = "";
      }
      return upsertPart(db, {
        id: str(r.id),
        partNo: str(r.part_no),
        wclItemNo: str(r.wcl_item_no),
        brand,
        description: strOrNull(r.description),
      }).then(() => undefined);
    },
    remove: (db, r) => removeGuarded("wms_parts", () => deletePart(db, str(r.wcl_item_no))),
  },
  {
    remoteTable: "demo.wms_org_info",
    columns: ["id", "office_code", "organization_id", "org_id", "secondary_inventory_name", "subinv_description"],
    // Dedicated apply: upsert keyed on (org_id, secondary_inventory_name),
    // adopting the remote id on insert and never touching the local-only
    // customer_code column.
    upsert: async (db, r) => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL app.sync_events_off = 1`);
        await tx.execute(sql`SET LOCAL app.upstream_write = 1`);
        const ts = now();
        await tx.execute(sql`
          INSERT INTO sub_inventories
            (id, org_id, secondary_inventory_name, subinv_description, office_code, organization_id, creation_date, last_update_date)
          VALUES
            (${str(r.id)}, ${Number(r.org_id)}, ${str(r.secondary_inventory_name)},
             ${strOrNull(r.subinv_description)}, ${strOrNull(r.office_code)}, ${intOrNull(r.organization_id)},
             ${ts}, ${ts})
          ON CONFLICT (org_id, secondary_inventory_name) DO UPDATE SET
            subinv_description = EXCLUDED.subinv_description,
            office_code = EXCLUDED.office_code,
            organization_id = EXCLUDED.organization_id,
            last_update_date = EXCLUDED.last_update_date`);
      });
    },
    remove: (db, r) =>
      removeGuarded("wms_org_info", () =>
        deleteSubInventory(db, str(Number(r.org_id)), str(r.secondary_inventory_name))
      ),
  },
];

// ---------------------------------------------------------------------------

function electricConfig(): { url: string; secret?: string } | null {
  if (process.env.ELECTRIC_SYNC === "off") return null;
  const url = process.env.ELECTRIC_URL;
  if (!url) return null;
  const secret = process.env.ELECTRIC_SECRET || undefined;
  return { url, secret };
}

async function loadCheckpoint(
  db: AppDb,
  tableName: string
): Promise<{ shapeHandle: string; shapeOffset: string } | null> {
  const rows = await db
    .select()
    .from(syncCheckpoints)
    .where(sql`${syncCheckpoints.tableName} = ${tableName}`)
    .limit(1);
  return rows[0] ?? null;
}

async function saveCheckpoint(db: AppDb, tableName: string, handle: string, offset: string): Promise<void> {
  await db
    .insert(syncCheckpoints)
    .values({ tableName, shapeHandle: handle, shapeOffset: offset })
    .onConflictDoUpdate({
      target: syncCheckpoints.tableName,
      set: { shapeHandle: handle, shapeOffset: offset, lastUpdateDate: now() },
    });
}

async function clearCheckpoint(db: AppDb, tableName: string): Promise<void> {
  await db.delete(syncCheckpoints).where(sql`${syncCheckpoints.tableName} = ${tableName}`);
}

/** Runs one table's stream until it errors or is told to refetch. */
async function syncOnce(db: AppDb, cfg: { url: string; secret?: string }, def: TableSync): Promise<void> {
  const cp = await loadCheckpoint(db, def.remoteTable);
  const stream = new ShapeStream({
    url: `${cfg.url}/v1/shape`,
    params: {
      table: def.remoteTable,
      columns: def.columns,
      replica: def.replica ?? "full",
      ...(cfg.secret ? { secret: cfg.secret } : {}),
    },
    ...(cp ? { handle: cp.shapeHandle, offset: cp.shapeOffset as Offset } : {}),
    onError: (err) => {
      // Keep retrying instead of stopping the stream permanently.
      console.error(`[sync] ${def.remoteTable} stream error (retrying)`, err);
      return {};
    },
  });

  let mustRefetch = false;
  await new Promise<void>((_resolve, reject) => {
    stream.subscribe(
      async (messages) => {
        try {
          for (const m of messages) {
            const headers = m.headers as Record<string, unknown>;
            if ("control" in headers) {
              if (headers.control === "must-refetch") mustRefetch = true;
              continue;
            }
            const operation = headers.operation as "insert" | "update" | "delete";
            const row = (m as { value: Row }).value;
            try {
              if (operation === "delete") await def.remove(db, row);
              else await def.upsert(db, row);
            } catch (e) {
              // A child that arrived before its parent must NOT be skipped:
              // rethrow so the batch fails, the checkpoint is not saved, and
              // the stream replays until the parent lands.
              if (e instanceof ParentNotReadyError) throw e;
              // Poison message: log loudly and continue — a single bad row must
              // not stall the whole stream (checkpoint still advances).
              console.error(`[sync] ${def.remoteTable} ${operation} apply failed`, e, row);
            }
          }
          if (stream.shapeHandle) {
            await saveCheckpoint(db, def.remoteTable, stream.shapeHandle, stream.lastOffset);
          }
          if (def.afterBatch) await def.afterBatch(db);
          if (mustRefetch) {
            await clearCheckpoint(db, def.remoteTable);
            reject(new Error("must-refetch: checkpoint cleared, resyncing from scratch"));
          }
        } catch (e) {
          reject(e);
        }
      },
      (err) => reject(err)
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runTableSync(db: AppDb, cfg: { url: string; secret?: string }, def: TableSync): Promise<void> {
  let backoff = 1_000;
  for (;;) {
    try {
      await syncOnce(db, cfg, def);
    } catch (e) {
      console.error(`[sync] ${def.remoteTable} stream ended, restarting in ${backoff}ms`, e);
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }
}

/**
 * Connection string for the wms_sync_consumer role (migration 0015): the
 * enforce_remote_owned_columns trigger only lets this role (or an
 * app.upstream_write transaction) update remote-owned columns.
 */
function consumerDbUrl(): string {
  const base =
    process.env.SYNC_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://warehouse:warehouse@localhost:5432/warehouse_backend";
  const u = new URL(base);
  u.username = "wms_sync_consumer";
  u.password = process.env.SYNC_CONSUMER_DB_PASSWORD ?? "wms_sync_consumer";
  return u.toString();
}

/**
 * Starts one sync stream per mapped remote table, in the background.
 * Disabled when ELECTRIC_SYNC=off or ELECTRIC_URL is unset (tests never call
 * this — they don't import server.ts). The consumer connects to the LOCAL
 * database as the wms_sync_consumer role on its own pool.
 */
export function startElectricSync(_db: AppDb): void {
  const cfg = electricConfig();
  if (!cfg) {
    console.log("[sync] Electric sync disabled (ELECTRIC_URL unset or ELECTRIC_SYNC=off)");
    return;
  }
  const { db } = createDb(consumerDbUrl());
  const allSyncs = [...TABLE_SYNCS, ...ORDER_TABLE_SYNCS];
  console.log(`[sync] Electric sync consumer starting against ${cfg.url} (${allSyncs.length} tables)`);
  for (const def of allSyncs) {
    void runTableSync(db, cfg, def);
  }
}
