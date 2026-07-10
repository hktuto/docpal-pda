import { eq, sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";

interface DateCodeRule {
  op: "eq" | ">=" | "<=" | ">" | "<";
  value: string;
}

export function parseDateCodeRule(input: string | null | undefined): DateCodeRule | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  const match = trimmed.match(/^(>=|<=|>|<)?(.*)$/);
  if (!match) return undefined;
  const op = (match[1] as DateCodeRule["op"]) || "eq";
  const value = match[2].trim();
  if (!value) return undefined;
  return { op, value };
}

function dateCodeMatches(lotDate: string | null | undefined, rule: DateCodeRule | undefined): boolean {
  if (!rule) return true;
  // A null lot date code matches any rule (wildcard) but is sorted after known codes.
  if (lotDate == null) return true;
  switch (rule.op) {
    case "eq": return lotDate === rule.value;
    case ">=": return lotDate >= rule.value;
    case "<=": return lotDate <= rule.value;
    case ">": return lotDate > rule.value;
    case "<": return lotDate < rule.value;
  }
}

interface ReceivingItemRow {
  id: string;
  dateCode: string | null;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  allocatedQty: number;
  receivingOrderId: string;
  deliveryDate: string | null;
}

export async function allocatePendingPickingOrders(
  db: PgliteDatabase<typeof schema>
) {
  const pendingOrders = await db.query.pickingOrders.findMany({
    where: eq(schema.pickingOrders.status, "pending"),
  });

  for (const order of pendingOrders) {
    await allocatePickingOrder(db, order.id);
  }
}

export async function allocatePickingOrder(
  db: PgliteDatabase<typeof schema>,
  pickingOrderId: string
) {
  const items = await db.query.pickingItems.findMany({
    where: eq(schema.pickingItems.pickingOrderId, pickingOrderId),
  });

  for (const item of items) {
    const neededAtStart = item.qty - item.pickedQty - item.allocatedQty;
    if (neededAtStart <= 0) continue;

    await db.transaction(async (tx) => {
      let needed = neededAtStart;
      const rule = parseDateCodeRule(item.requiredDateCode);

      // Phase 1: shelved / shelf-box lots
      const shelvedLots = await tx.query.inventoryLots.findMany({
        where: (il, { and, eq, gt, or, isNotNull }) =>
          and(
            eq(il.partId, item.partId),
            gt(il.availableQty, 0),
            or(isNotNull(il.shelfCode), isNotNull(il.boxId))
          ),
      });

      const matchingShelved = shelvedLots
        .filter((lot) => dateCodeMatches(lot.dateCode, rule))
        .sort((a, b) => (a.dateCode ?? "9999").localeCompare(b.dateCode ?? "9999"));

      for (const lot of matchingShelved) {
        if (needed <= 0) break;
        const take = Math.min(needed, lot.availableQty);
        await createAllocation(tx, item.id, lot.id, take);
        await tx.update(schema.pickingItems)
          .set({ allocatedQty: sql`${schema.pickingItems.allocatedQty} + ${take}` })
          .where(eq(schema.pickingItems.id, item.id));
        needed -= take;
      }

      // Phase 2: receiving-area receiving orders
      if (needed > 0) {
        const result = await tx.execute(sql`
          SELECT
            ro.id AS receiving_order_id,
            ro.delivery_date,
            COALESCE(SUM(rii.received_qty - rii.picked_qty - rii.put_away_qty), 0) AS physical_qty,
            COALESCE((
              SELECT SUM(a.qty)
              FROM allocations a
              JOIN picking_items pi ON pi.id = a.picking_item_id
              WHERE a.receiving_order_id = ro.id
                AND pi.part_id = ${item.partId}
            ), 0) AS allocated_qty,
            (
              SELECT COALESCE(SUM(pas.qty), 0)
              FROM put_away_scans pas
              JOIN receiving_invoice_items rii2 ON rii2.id = pas.receiving_invoice_item_id
              JOIN receiving_invoices ri2 ON ri2.id = rii2.receiving_invoice_id
              WHERE ri2.receiving_order_id = ro.id
                AND rii2.part_id = ${item.partId}
                AND pas.shelf_box_id IS NULL
            ) AS unboxed_qty
          FROM receiving_orders ro
          JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
          JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
          WHERE rii.part_id = ${item.partId}
            AND ro.status = 'in_hand'
          GROUP BY ro.id, ro.delivery_date
          HAVING COALESCE(SUM(rii.received_qty - rii.picked_qty - rii.put_away_qty), 0)
            - COALESCE((
              SELECT SUM(a.qty)
              FROM allocations a
              JOIN picking_items pi ON pi.id = a.picking_item_id
              WHERE a.receiving_order_id = ro.id
                AND pi.part_id = ${item.partId}
            ), 0)
            - (
              SELECT COALESCE(SUM(pas.qty), 0)
              FROM put_away_scans pas
              JOIN receiving_invoice_items rii2 ON rii2.id = pas.receiving_invoice_item_id
              JOIN receiving_invoices ri2 ON ri2.id = rii2.receiving_invoice_id
              WHERE ri2.receiving_order_id = ro.id
                AND rii2.part_id = ${item.partId}
                AND pas.shelf_box_id IS NULL
            ) > 0
          ORDER BY ro.delivery_date ASC NULLS LAST
        `);

        const rows: ReceivingItemRow[] = result.rows.map((row) => ({
          id: row.receiving_order_id as string,
          dateCode: null,
          receivedQty: Number(row.physical_qty),
          pickedQty: 0,
          putAwayQty: 0,
          allocatedQty: Number(row.allocated_qty) + Number(row.unboxed_qty),
          receivingOrderId: row.receiving_order_id as string,
          deliveryDate: row.delivery_date as string | null,
        }));

        for (const row of rows) {
          if (needed <= 0) break;
          const available = row.receivedQty - row.allocatedQty;
          if (available <= 0) continue;
          const take = Math.min(needed, available);
          await tx.insert(schema.allocations).values({
            id: uuid(),
            pickingItemId: item.id,
            receivingOrderId: row.receivingOrderId,
            qty: take,
          });
          await tx.update(schema.pickingItems)
            .set({ allocatedQty: sql`${schema.pickingItems.allocatedQty} + ${take}` })
            .where(eq(schema.pickingItems.id, item.id));
          needed -= take;
        }
      }
    });
  }
}

async function createAllocation(
  tx: PgliteDatabase<typeof schema>,
  pickingItemId: string,
  inventoryLotId: string,
  qty: number
) {
  await tx.insert(schema.allocations).values({
    id: uuid(),
    pickingItemId,
    inventoryLotId,
    qty,
  });
  await tx
    .update(schema.inventoryLots)
    .set({ allocatedQty: sql`${schema.inventoryLots.allocatedQty} + ${qty}` })
    .where(eq(schema.inventoryLots.id, inventoryLotId));
}
