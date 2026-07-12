import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "~/db/schema";
import { createTablesSql } from "~/db/init";
import { seedDb, ensureDemoPasswords } from "~/db/seed-precalc";

// The generated seedSql.ts is a committed build artifact, so generation must be
// byte-identical across runs. The web seed uses uuid v4 + `new Date()`, so pin both.
const uuidCounter = vi.hoisted(() => ({ n: 0 }));
vi.mock("uuid", () => ({
  v4: () => `00000000-0000-4000-8000-${String(++uuidCounter.n).padStart(12, "0")}`,
}));

// --- Normalizers, ported from apps/api/src/db/schema/normalize.ts (keep in sync) ---
const CONFUSABLES: Record<string, string> = { O: "0", I: "1", L: "1", Z: "2", S: "5" };
function collapseUpper(s: string): string {
  return s.trim().replace(/\s+/g, " ").toUpperCase();
}
/** part_no / date_code / lot_code: confusable map + collapse + upper */
function normalizeCode(s: string | null | undefined): string | null {
  if (s == null) return null;
  return collapseUpper(s).replace(/[OILZS]/g, (c) => CONFUSABLES[c] ?? c);
}
/** coo / cow: collapse + upper, no confusable map */
function normalizePlain(s: string | null | undefined): string | null {
  if (s == null) return null;
  return collapseUpper(s);
}

// --- SQL literals for the API schema (SQLite, ISO 8601 timestamp strings) ---
function iso(value: unknown): string {
  if (value instanceof Date) {
    // PGlite reads TIMESTAMP back as a Date whose LOCAL components are the
    // stored wall-clock (no zone is persisted); re-interpret as UTC so output
    // is stable regardless of the machine timezone.
    return new Date(
      Date.UTC(
        value.getFullYear(), value.getMonth(), value.getDate(),
        value.getHours(), value.getMinutes(), value.getSeconds(), value.getMilliseconds()
      )
    ).toISOString();
  }
  const s = String(value);
  // PGlite may return TIMESTAMP as "YYYY-MM-DD HH:MM:SS[.ffffff]" — UTC without
  // a zone suffix, so parse it explicitly as UTC.
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s);
  if (m) return new Date(`${m[1]}T${m[2]}Z`).toISOString();
  return new Date(s).toISOString();
}
function lit(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function insert(table: string, columns: string[], values: unknown[]): string {
  const literals = values.map((v, i) => {
    // undefined means the web row is missing a field we expected (e.g. a
    // web-schema rename) — fail loudly instead of emitting a silent NULL.
    if (v === undefined) throw new Error(`${table}.${columns[i]} is undefined — web schema drift?`);
    return lit(v);
  });
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${literals.join(", ")});`;
}

describe("export-api-seed", () => {
  it("writes apps/api/src/db/seedSql.ts projected onto the API schema", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00.000Z"), toFake: ["Date"] });
    try {
      const pg = new PGlite();
      await pg.waitReady;
      await pg.exec(createTablesSql);
      const db = drizzle(pg, { schema });

      await seedDb(db);
      await ensureDemoPasswords(db);

      // ORDER BY keeps output ordering independent of heap-scan order.
      // Web shelves is keyed by `code`, every other table by `id`.
      const select = async (table: string, orderBy = "id") =>
        (await pg.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`)).rows as Record<string, unknown>[];

      const users = await select("users");
      // Web tables without timestamp columns (suppliers, parts, shelves,
      // receiving_invoices, receiving_invoice_items, picking_items) get the
      // seed's fixed creation time so output stays deterministic.
      const seedTs = iso(users[0].created_at);

      const lines: string[] = [];

      for (const r of users) {
        lines.push(
          insert(
            "users",
            ["id", "username", "password_hash", "role", "name", "created_at", "updated_at"],
            [r.id, r.username, r.password_hash, r.role, r.display_name, iso(r.created_at), iso(r.created_at)]
          )
        );
      }

      const suppliers = await select("suppliers");
      for (const r of suppliers) {
        lines.push(
          insert(
            "suppliers",
            ["id", "code", "name", "qr_template", "qrcode_qty_encoding", "created_at", "updated_at"],
            [r.id, r.code, r.name, r.qrcode_template, r.qrcode_qty_encoding, seedTs, seedTs]
          )
        );
      }

      const parts = await select("parts");
      for (const r of parts) {
        lines.push(
          insert(
            "parts",
            ["id", "part_no", "part_no_norm", "description", "created_at", "updated_at"],
            [r.id, r.part_no, normalizeCode(r.part_no as string), r.description, seedTs, seedTs]
          )
        );
      }

      const shelves = await select("shelves", "code");
      for (const r of shelves) {
        lines.push(
          insert("shelves", ["id", "code", "created_at", "updated_at"], [r.code, r.code, seedTs, seedTs])
        );
      }

      const receivingOrders = await select("receiving_orders");
      for (const r of receivingOrders) {
        lines.push(
          insert(
            "receiving_orders",
            ["id", "external_id", "ref_no", "delivery_date", "status", "supplier_id", "created_at", "updated_at"],
            [r.id, r.ref_no, r.ref_no, r.delivery_date == null ? null : iso(r.delivery_date), r.status, r.supplier_id, iso(r.created_at), iso(r.updated_at)]
          )
        );
      }

      const receivingInvoices = await select("receiving_invoices");
      for (const r of receivingInvoices) {
        lines.push(
          insert(
            "receiving_invoices",
            ["id", "external_id", "receiving_order_id", "invoice_no", "supplier_id", "created_at", "updated_at"],
            [r.id, null, r.receiving_order_id, r.invoice_no, r.supplier_id, seedTs, seedTs]
          )
        );
      }

      const receivingItems = await select("receiving_invoice_items");
      for (const r of receivingItems) {
        // allocated_qty / available_qty start at 0 — re-derived by the API
        // allocation engine at seed time (later task).
        lines.push(
          insert(
            "receiving_invoice_items",
            [
              "id", "receiving_invoice_id", "part_id", "qty", "received_qty", "picked_qty", "put_away_qty",
              "allocated_qty", "available_qty", "box_id", "date_code", "lot_code", "coo", "cow",
              "date_code_norm", "lot_code_norm", "coo_norm", "cow_norm", "line_no", "created_at", "updated_at",
            ],
            [
              r.id, r.receiving_invoice_id, r.part_id, r.qty, r.received_qty, r.picked_qty, r.put_away_qty,
              0, 0, r.box_id, r.date_code, r.lot_code, r.coo, r.cow,
              normalizeCode(r.date_code as string | null), normalizeCode(r.lot_code as string | null),
              normalizePlain(r.coo as string | null), normalizePlain(r.cow as string | null),
              null, seedTs, seedTs,
            ]
          )
        );
      }

      const pickingOrders = await select("picking_orders");
      for (const r of pickingOrders) {
        lines.push(
          insert(
            "picking_orders",
            ["id", "external_id", "ref_no", "status", "ship_to", "destination_country", "delivery_date", "supplier_id", "po_no", "required_date_code_notice", "issue_reason", "issue_note", "created_at", "updated_at"],
            [r.id, r.ref_no, r.ref_no, r.status, r.ship_to, r.destination_country, r.delivery_date == null ? null : iso(r.delivery_date), r.supplier_id, r.po_no, r.required_date_code_notice, r.issue_reason, r.issue_note, iso(r.created_at), iso(r.updated_at)]
          )
        );
      }

      const pickingItems = await select("picking_items");
      for (const r of pickingItems) {
        // allocated_qty starts 0; remaining_qty is a GENERATED column (never insert);
        // scanned_not_boxed_qty 0; line_id NULL.
        lines.push(
          insert(
            "picking_items",
            [
              "id", "picking_order_id", "part_id", "qty", "picked_qty", "allocated_qty",
              "required_date_code", "source_shelf_code", "scanned_not_boxed_qty", "line_id",
              "created_at", "updated_at",
            ],
            [
              r.id, r.picking_order_id, r.part_id, r.qty, r.picked_qty, 0,
              r.required_date_code, r.source_shelf_code, 0, null,
              seedTs, seedTs,
            ]
          )
        );
      }

      // Allocations are intentionally EXCLUDED — re-derived by the API engine.
      const sql = lines.join("\n");
      expect(sql).not.toContain("INSERT INTO allocations");

      // Assert row counts BEFORE writing, so a drifting seed fails red without
      // rewriting the committed artifact.
      expect(users).toHaveLength(2);
      expect(suppliers).toHaveLength(26);
      expect(parts).toHaveLength(177);
      expect(shelves).toHaveLength(11);
      expect(receivingOrders).toHaveLength(1);
      expect(receivingInvoices).toHaveLength(16);
      expect(receivingItems).toHaveLength(264);
      expect(pickingOrders).toHaveLength(23);
      expect(pickingItems).toHaveLength(73);

      const header =
        "// GENERATED by apps/web/scripts/export-api-seed.test.ts — do not edit by hand. Regenerate: pnpm --filter @warehouse/api gen:seed";
      // Escape backslashes FIRST, then the template-literal delimiters.
      const escaped = sql.split("\\").join("\\\\").split("`").join("\\`").split("${").join("\\${");
      const moduleText = header + "\nexport const seedSql = `\n" + escaped + "\n`;\n";

      const here = path.dirname(fileURLToPath(import.meta.url));
      const outPath = path.resolve(here, "../../api/src/db/seedSql.ts");
      fs.writeFileSync(outPath, moduleText);
      console.log(`Wrote ${lines.length} INSERT statements to ${outPath}`);
    } finally {
      vi.useRealTimers();
    }
  });
});
