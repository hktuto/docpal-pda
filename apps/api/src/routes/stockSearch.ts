import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { queryAll, queryGet } from "../db/query.js";

export const stockSearchRoute = new Hono();

// Ported from apps/web/db/stockSearch.ts. Deviation: the web also links
// supplier ↔ part through picking_items → picking_orders.supplier_id; the API
// only uses the receiving linkage (receiving_invoice_items →
// receiving_invoices → receiving_orders) even though both picking_orders and
// parts now carry supplier_id. The API parts table also lacks internal_code /
// default_coo.
stockSearchRoute.get("/stock-search/suppliers", async (c) => {
  const rows = await queryAll<Record<string, unknown>>(db, sql`
    WITH supplier_parts AS (
      SELECT DISTINCT rii.part_id AS part_id, ro.supplier_id AS supplier_id
      FROM receiving_invoice_items rii
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
      WHERE ro.supplier_id IS NOT NULL
    ),
    inventory_parts AS (
      SELECT DISTINCT il.part_id AS part_id, sp.supplier_id AS supplier_id
      FROM inventory_lots il
      JOIN supplier_parts sp ON sp.part_id = il.part_id
      WHERE il.total_qty > 0
    )
    SELECT
      s.id,
      s.code,
      s.name,
      COALESCE((
        SELECT COUNT(DISTINCT part_id)::int
        FROM supplier_parts sp
        WHERE sp.supplier_id = s.id
      ), 0) AS total_parts,
      COALESCE((
        SELECT COUNT(DISTINCT part_id)::int
        FROM inventory_parts ip
        WHERE ip.supplier_id = s.id
      ), 0) AS parts_with_inventory
    FROM suppliers s
    ORDER BY s.name
  `);
  return c.json(
    rows.map((row) => ({
      id: String(row.id),
      code: String(row.code),
      name: String(row.name),
      total_parts: Number(row.total_parts ?? 0),
      parts_with_inventory: Number(row.parts_with_inventory ?? 0),
    })),
    200,
  );
});

stockSearchRoute.get("/stock-search/suppliers/:id/parts", async (c) => {
  const supplierId = c.req.param("id");
  const supplier = await queryGet<{ id: string }>(db, sql`SELECT id FROM suppliers WHERE id = ${supplierId}`);
  if (!supplier) throw new HTTPException(404, { message: "supplier not found" });
  const rows = await queryAll<Record<string, unknown>>(db, sql`
    SELECT DISTINCT p.id, p.part_no, p.description
    FROM parts p
    WHERE p.id IN (
      SELECT rii.part_id
      FROM receiving_invoice_items rii
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
      WHERE ro.supplier_id = ${supplierId}
    )
    ORDER BY p.part_no
  `);
  return c.json(
    rows.map((row) => ({
      id: String(row.id),
      part_no: String(row.part_no),
      description: row.description ? String(row.description) : null,
    })),
    200,
  );
});

stockSearchRoute.get("/stock-search/parts/lots", async (c) => {
  const partIds = (c.req.query("part_ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (partIds.length === 0) throw new HTTPException(400, { message: "part_ids query param is required" });
  const rows = await queryAll<Record<string, unknown>>(db, sql`
    SELECT part_id, date_code, lot_code, coo, cow, shelf_code, box_id, total_qty, allocated_qty, available_qty
    FROM inventory_lots
    WHERE part_id IN (${sql.join(
      partIds.map((id) => sql`${id}`),
      sql`, `,
    )})
    ORDER BY shelf_code NULLS LAST, box_id NULLS LAST
  `);
  return c.json(
    rows.map((row) => {
      const shelfCode = row.shelf_code ? String(row.shelf_code) : null;
      const boxId = row.box_id ? String(row.box_id) : null;
      return {
        part_id: String(row.part_id),
        date_code: row.date_code ? String(row.date_code) : null,
        lot_code: row.lot_code ? String(row.lot_code) : null,
        coo: row.coo ? String(row.coo) : null,
        cow: row.cow ? String(row.cow) : null,
        shelf_code: shelfCode,
        box_id: boxId,
        total_qty: Number(row.total_qty ?? 0),
        allocated_qty: Number(row.allocated_qty ?? 0),
        available_qty: Number(row.available_qty ?? 0),
        location_label: buildLocationLabel(shelfCode, boxId),
      };
    }),
    200,
  );
});

function buildLocationLabel(shelfCode: string | null, boxId: string | null): string {
  if (shelfCode && boxId) return `${shelfCode} / ${boxId}`;
  if (shelfCode) return shelfCode;
  if (boxId) return boxId;
  return "receiving-area";
}
