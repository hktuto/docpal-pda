import { sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema";

export type DbType = PgliteDatabase<typeof schema>;

export interface StockSearchSupplier {
  id: string;
  code: string;
  name: string;
}

export interface StockSearchPart {
  id: string;
  partNo: string;
  internalCode: string | null;
  description: string | null;
  defaultCoo: string | null;
}

export interface StockSearchInventoryLot {
  partId: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfCode: string | null;
  boxId: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
  locationLabel: string;
}

export interface StockSearchSupplierPart {
  part: StockSearchPart;
  lots: StockSearchInventoryLot[];
  totalQty: number;
}

export async function getAllSuppliers(db: DbType): Promise<StockSearchSupplier[]> {
  return db.query.suppliers.findMany({
    orderBy: (suppliers, { asc }) => asc(suppliers.name),
  });
}

export async function getPartsBySupplierId(
  db: DbType,
  supplierId: string
): Promise<StockSearchPart[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT p.id, p.part_no, p.internal_code, p.description, p.default_coo
    FROM parts p
    WHERE p.id IN (
      SELECT rii.part_id
      FROM receiving_invoice_items rii
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
      WHERE ro.supplier_id = ${supplierId}

      UNION

      SELECT pi.part_id
      FROM picking_items pi
      JOIN picking_orders po ON po.id = pi.picking_order_id
      WHERE po.supplier_id = ${supplierId}
    )
    ORDER BY p.part_no
  `);

  return result.rows.map((row) => ({
    id: String(row.id),
    partNo: String(row.part_no),
    internalCode: row.internal_code ? String(row.internal_code) : null,
    description: row.description ? String(row.description) : null,
    defaultCoo: row.default_coo ? String(row.default_coo) : null,
  }));
}

export async function getInventoryLotsForParts(
  db: DbType,
  partIds: string[]
): Promise<StockSearchInventoryLot[]> {
  if (partIds.length === 0) return [];

  const result = await db.execute(sql`
    SELECT
      part_id,
      date_code,
      lot_code,
      coo,
      cow,
      shelf_code,
      box_id,
      total_qty,
      allocated_qty,
      available_qty
    FROM inventory_lots
    WHERE part_id = ANY(${partIds}::text[])
    ORDER BY shelf_code NULLS LAST, box_id NULLS LAST
  `);

  return result.rows.map((row) => ({
    partId: String(row.part_id),
    dateCode: row.date_code ? String(row.date_code) : null,
    lotCode: row.lot_code ? String(row.lot_code) : null,
    coo: row.coo ? String(row.coo) : null,
    cow: row.cow ? String(row.cow) : null,
    shelfCode: row.shelf_code ? String(row.shelf_code) : null,
    boxId: row.box_id ? String(row.box_id) : null,
    totalQty: Number(row.total_qty),
    allocatedQty: Number(row.allocated_qty),
    availableQty: Number(row.available_qty),
    locationLabel: buildLocationLabel(row.shelf_code, row.box_id),
  }));
}

function buildLocationLabel(
  shelfCode: string | null,
  boxId: string | null
): string {
  if (shelfCode && boxId) return `${shelfCode} / ${boxId}`;
  if (shelfCode) return shelfCode;
  if (boxId) return boxId;
  return "receiving-area";
}
