import { sql, inArray } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema";

export type DbType = PgliteDatabase<typeof schema>;

export interface StockSearchSupplier {
  id: string;
  code: string;
  name: string;
}

export interface StockSearchSupplierWithStats extends StockSearchSupplier {
  totalParts: number;
  partsWithInventory: number;
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

export async function getSuppliersWithInventoryStats(
  db: DbType
): Promise<StockSearchSupplierWithStats[]> {
  const result = await db.execute(sql`
    WITH supplier_parts AS (
      SELECT DISTINCT p.id AS part_id, ro.supplier_id
      FROM parts p
      JOIN receiving_invoice_items rii ON rii.part_id = p.id
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
      WHERE ro.supplier_id IS NOT NULL

      UNION

      SELECT DISTINCT p.id AS part_id, po.supplier_id
      FROM parts p
      JOIN picking_items pi ON pi.part_id = p.id
      JOIN picking_orders po ON po.id = pi.picking_order_id
      WHERE po.supplier_id IS NOT NULL
    ),
    inventory_parts AS (
      SELECT DISTINCT il.part_id, sp.supplier_id
      FROM inventory_lots il
      JOIN supplier_parts sp ON sp.part_id = il.part_id
      WHERE il.total_qty > 0
    )
    SELECT
      s.id,
      s.code,
      s.name,
      COALESCE((
        SELECT COUNT(DISTINCT part_id)
        FROM supplier_parts sp
        WHERE sp.supplier_id = s.id
      ), 0) AS total_parts,
      COALESCE((
        SELECT COUNT(DISTINCT part_id)
        FROM inventory_parts ip
        WHERE ip.supplier_id = s.id
      ), 0) AS parts_with_inventory
    FROM suppliers s
    ORDER BY s.name
  `);

  return (result.rows ?? []).map((row) => ({
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    totalParts: Number(row.total_parts ?? 0),
    partsWithInventory: Number(row.parts_with_inventory ?? 0),
  }));
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

  const rows = await db.query.inventoryLots.findMany({
    where: inArray(schema.inventoryLots.partId, partIds),
    orderBy: [
      sql`${schema.inventoryLots.shelfCode} NULLS LAST`,
      sql`${schema.inventoryLots.boxId} NULLS LAST`,
    ],
  });

  return rows.map((row) => ({
    partId: row.partId,
    dateCode: row.dateCode,
    lotCode: row.lotCode,
    coo: row.coo,
    cow: row.cow,
    shelfCode: row.shelfCode,
    boxId: row.boxId,
    totalQty: row.totalQty,
    allocatedQty: row.allocatedQty,
    availableQty: row.availableQty,
    locationLabel: buildLocationLabel(row.shelfCode, row.boxId),
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
