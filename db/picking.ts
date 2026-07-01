import { eq, sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";

export async function getPickingOrdersWithSupplier(
  db: PgliteDatabase<typeof schema>
) {
  return db.query.pickingOrders.findMany({
    where: (po, { ne }) => ne(po.status, "finished"),
    orderBy: (po, { asc }) => [asc(po.deliveryDate)],
    with: { supplier: true },
  });
}

export async function getPickingOrderDetail(
  db: PgliteDatabase<typeof schema>,
  id: string
) {
  return db.query.pickingOrders.findFirst({
    where: eq(schema.pickingOrders.id, id),
    with: {
      supplier: true,
      items: {
        with: {
          part: true,
          allocations: {
            with: {
              inventoryLot: { with: { part: true } },
              receivingInvoiceItem: { with: { invoice: { with: { receivingOrder: true } } } },
            },
          },
        },
      },
    },
  });
}

export async function materializeReceivingAllocation(
  db: PgliteDatabase<typeof schema>,
  allocationId: string,
  qty: number,
  dateCode: string | null,
  lotCode: string | null,
  originCountry: string | null
) {
  return db.transaction(async (tx) => {
    const allocation = await tx.query.allocations.findFirst({
      where: eq(schema.allocations.id, allocationId),
      with: { pickingItem: true, receivingInvoiceItem: { with: { invoice: true } } },
    });

    if (!allocation) throw new Error("Allocation not found");
    if (!allocation.receivingInvoiceItemId) throw new Error("Allocation is not against a receiving item");
    if (qty <= 0 || qty > allocation.qty) throw new Error("Invalid materialize quantity");

    const invoiceItem = allocation.receivingInvoiceItem!;

    // Always create a dedicated receiving-area lot for this allocation so that
    // source accounting in confirmAllocationPicked stays tied to the original invoice item.
    const lotId = uuid();
    await tx.insert(schema.inventoryLots).values({
      id: lotId,
      partId: invoiceItem.partId,
      dateCode,
      lotCode,
      originCountry,
      shelfCode: null,
      boxId: null,
      totalQty: qty,
      allocatedQty: qty,
    });

    await tx.insert(schema.inventoryLotSources).values({
      id: uuid(),
      inventoryLotId: lotId,
      receivingInvoiceItemId: invoiceItem.id,
      qty,
    });

    if (qty < allocation.qty) {
      // Reduce the original allocation to the remainder, then create a new lot allocation
      await tx
        .update(schema.allocations)
        .set({ qty: sql`${schema.allocations.qty} - ${qty}` })
        .where(eq(schema.allocations.id, allocationId));
      const newAllocationId = uuid();
      await tx.insert(schema.allocations).values({
        id: newAllocationId,
        pickingItemId: allocation.pickingItemId,
        inventoryLotId: lotId,
        qty,
      });
      return newAllocationId;
    } else {
      // Move the whole allocation to the new lot
      await tx
        .update(schema.allocations)
        .set({ inventoryLotId: lotId, receivingInvoiceItemId: null })
        .where(eq(schema.allocations.id, allocationId));
      return allocationId;
    }
  });
}

export async function confirmAllocationPicked(
  db: PgliteDatabase<typeof schema>,
  allocationId: string,
  qty: number,
  actorId: string
) {
  await db.transaction(async (tx) => {
    const allocation = await tx.query.allocations.findFirst({
      where: eq(schema.allocations.id, allocationId),
      with: { pickingItem: true, inventoryLot: true, receivingInvoiceItem: true },
    });

    if (!allocation) throw new Error("Allocation not found");
    if (qty <= 0 || qty > allocation.qty) throw new Error("Invalid picked quantity");

    const item = allocation.pickingItem;
    const lot = allocation.inventoryLot;

    if (lot) {
      if (lot.allocatedQty < qty) throw new Error("Insufficient allocated quantity");
      if (lot.totalQty < qty) throw new Error("Insufficient lot quantity");
      if (item.pickedQty + qty > item.qty) throw new Error("Picked quantity exceeds required quantity");
    } else {
      if (item.pickedQty + qty > item.qty) throw new Error("Picked quantity exceeds required quantity");
    }

    if (lot) {
      await tx
        .update(schema.inventoryLots)
        .set({
          totalQty: sql`${schema.inventoryLots.totalQty} - ${qty}`,
          allocatedQty: sql`${schema.inventoryLots.allocatedQty} - ${qty}`,
        })
        .where(eq(schema.inventoryLots.id, lot.id));

      // For receiving-area lots, distribute the picked qty across source invoice items
      if (lot.shelfCode === null && lot.boxId === null) {
        const sources = await tx.query.inventoryLotSources.findMany({
          where: eq(schema.inventoryLotSources.inventoryLotId, lot.id),
          orderBy: (ils, { asc }) => [asc(ils.id)],
        });

        const totalSourceQty = sources.reduce((sum, s) => sum + s.qty, 0);
        if (totalSourceQty < qty) throw new Error("Insufficient source quantity");

        let remaining = qty;
        for (const source of sources) {
          if (remaining <= 0) break;
          const apply = Math.min(remaining, source.qty);
          await tx
            .update(schema.receivingInvoiceItems)
            .set({
              pickedQty: sql`${schema.receivingInvoiceItems.pickedQty} + ${apply}`,
            })
            .where(eq(schema.receivingInvoiceItems.id, source.receivingInvoiceItemId));

          const newSourceQty = source.qty - apply;
          if (newSourceQty > 0) {
            await tx
              .update(schema.inventoryLotSources)
              .set({ qty: newSourceQty })
              .where(eq(schema.inventoryLotSources.id, source.id));
          } else {
            await tx
              .delete(schema.inventoryLotSources)
              .where(eq(schema.inventoryLotSources.id, source.id));
          }
          remaining -= apply;
        }

        // Clean up empty receiving-area lots after a full pick.
        if (qty === allocation.qty) {
          await tx
            .delete(schema.inventoryLotSources)
            .where(eq(schema.inventoryLotSources.inventoryLotId, lot.id));
          await tx
            .delete(schema.inventoryLots)
            .where(eq(schema.inventoryLots.id, lot.id));
        }
      }
    }

    if (allocation.receivingInvoiceItem) {
      await tx
        .update(schema.receivingInvoiceItems)
        .set({ pickedQty: sql`${schema.receivingInvoiceItems.pickedQty} + ${qty}` })
        .where(eq(schema.receivingInvoiceItems.id, allocation.receivingInvoiceItem.id));
    }

    const newPicked = item.pickedQty + qty;
    await tx
      .update(schema.pickingItems)
      .set({
        pickedQty: newPicked,
        allocatedQty: sql`${schema.pickingItems.allocatedQty} - ${qty}`,
      })
      .where(eq(schema.pickingItems.id, item.id));

    if (qty < allocation.qty) {
      await tx
        .update(schema.allocations)
        .set({ qty: sql`${schema.allocations.qty} - ${qty}` })
        .where(eq(schema.allocations.id, allocationId));
    } else {
      await tx.delete(schema.allocations).where(eq(schema.allocations.id, allocationId));
    }

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "picking_item",
      entityId: item.id,
      fromState: "picking",
      toState: "picked",
      actorId,
      metadata: JSON.stringify({ allocationId, qty }),
      createdAt: new Date(),
    });
  });
}

export async function reportPickingItemMismatch(
  db: PgliteDatabase<typeof schema>,
  pickingItemId: string,
  note: string,
  actorId: string
) {
  await db.insert(schema.transitionLogs).values({
    id: uuid(),
    entityType: "picking_item",
    entityId: pickingItemId,
    fromState: "picking",
    toState: "mismatch_reported",
    actorId,
    metadata: JSON.stringify({ note: note.trim() }),
    createdAt: new Date(),
  });
}

export async function finishPickingOrder(
  db: PgliteDatabase<typeof schema>,
  pickingOrderId: string,
  actorId: string
) {
  return db.transaction(async (tx) => {
    const order = await tx.query.pickingOrders.findFirst({
      where: eq(schema.pickingOrders.id, pickingOrderId),
      with: { items: true },
    });

    if (!order) throw new Error("Picking order not found");
    if (order.status === "finished") throw new Error("Order is already finished");
    if (order.items.length === 0) throw new Error("No items to pick");

    const allPicked = order.items.every((i) => i.pickedQty >= i.qty);
    if (!allPicked) throw new Error("Not all items are fully picked");

    const now = new Date();

    await tx
      .update(schema.pickingOrders)
      .set({ status: "finished", updatedAt: now })
      .where(eq(schema.pickingOrders.id, pickingOrderId));

    await tx.insert(schema.measuringTasks).values({
      id: uuid(),
      pickingOrderId,
      status: "pending",
      createdAt: now,
    });

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "picking_order",
      entityId: pickingOrderId,
      fromState: "picking",
      toState: "finished",
      actorId,
      metadata: null,
      createdAt: now,
    });
  });
}

export async function getInHandReceivingOrdersWithSupplier(
  db: PgliteDatabase<typeof schema>
) {
  return db.query.receivingOrders.findMany({
    where: eq(schema.receivingOrders.status, "in_hand"),
    orderBy: (ro, { asc }) => [asc(ro.deliveryDate)],
    with: { supplier: true },
  });
}

export interface PickingByReceivingRow {
  picking_order_id: string;
  picking_order_ref: string;
  picking_order_status: string;
  picking_order_ship_to: string | null;
  picking_item_id: string;
  required_qty: number;
  picked_qty: number;
  part_id: string;
  part_no: string;
  shelf_code: string | null;
  box_id: string | null;
  date_code: string | null;
  lot_code: string | null;
  origin_country: string | null;
  allocated_qty: number;
  allocation_id: string;
}

export async function getPickingOrdersByReceivingOrder(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string
) {
  const result = await db.execute(sql`
    WITH lot_allocations AS (
      SELECT DISTINCT ON (a.id)
        po.id AS picking_order_id,
        po.ref_no AS picking_order_ref,
        po.status AS picking_order_status,
        po.ship_to AS picking_order_ship_to,
        pi.id AS picking_item_id,
        pi.qty AS required_qty,
        pi.picked_qty,
        p.id AS part_id,
        p.part_no,
        il.shelf_code,
        il.box_id,
        il.date_code,
        il.lot_code,
        il.origin_country,
        a.qty AS allocated_qty,
        a.id AS allocation_id
      FROM receiving_orders ro
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      JOIN inventory_lot_sources ils ON ils.receiving_invoice_item_id = rii.id
      JOIN inventory_lots il ON il.id = ils.inventory_lot_id
      JOIN allocations a ON a.inventory_lot_id = il.id
      JOIN picking_items pi ON pi.id = a.picking_item_id
      JOIN picking_orders po ON po.id = pi.picking_order_id
      JOIN parts p ON p.id = pi.part_id
      WHERE ro.id = ${receivingOrderId}
      ORDER BY a.id
    ),
    invoice_allocations AS (
      SELECT
        po.id AS picking_order_id,
        po.ref_no AS picking_order_ref,
        po.status AS picking_order_status,
        po.ship_to AS picking_order_ship_to,
        pi.id AS picking_item_id,
        pi.qty AS required_qty,
        pi.picked_qty,
        p.id AS part_id,
        p.part_no,
        NULL AS shelf_code,
        NULL AS box_id,
        NULL AS date_code,
        NULL AS lot_code,
        NULL AS origin_country,
        a.qty AS allocated_qty,
        a.id AS allocation_id
      FROM receiving_orders ro
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      JOIN allocations a ON a.receiving_invoice_item_id = rii.id
      JOIN picking_items pi ON pi.id = a.picking_item_id
      JOIN picking_orders po ON po.id = pi.picking_order_id
      JOIN parts p ON p.id = pi.part_id
      WHERE ro.id = ${receivingOrderId}
    )
    SELECT * FROM (
      SELECT * FROM lot_allocations
      UNION ALL
      SELECT * FROM invoice_allocations
    ) combined
    ORDER BY picking_order_ref, part_no;
  `);

  return (result.rows ?? []) as PickingByReceivingRow[];
}
