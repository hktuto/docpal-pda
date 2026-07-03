import { eq, sql, inArray } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";
import { allocatePendingPickingOrders } from "./allocate";

export async function tryMarkReceivingOrderClear(
  tx: PgliteDatabase<typeof schema>,
  orderId: string,
  actorId: string
): Promise<void> {
  const order = await tx.query.receivingOrders.findFirst({
    where: eq(schema.receivingOrders.id, orderId),
    with: { invoices: { with: { items: true } } },
  });
  if (!order || order.status !== "in_hand") return;

  const itemIds = order.invoices.flatMap((inv) => inv.items.map((i) => i.id));
  if (itemIds.length === 0) return;

  const allocatedRows = await tx
    .select({
      receivingInvoiceItemId: schema.allocations.receivingInvoiceItemId,
      total: sql<number>`coalesce(sum(${schema.allocations.qty}), 0)`.mapWith(Number),
    })
    .from(schema.allocations)
    .where(inArray(schema.allocations.receivingInvoiceItemId, itemIds))
    .groupBy(schema.allocations.receivingInvoiceItemId);

  const allocatedMap = new Map(
    allocatedRows.map((r) => [r.receivingInvoiceItemId, r.total])
  );

  const allClear = order.invoices.every((inv) =>
    inv.items.every((item) => {
      const allocated = allocatedMap.get(item.id) ?? 0;
      const available = item.receivedQty - item.pickedQty - item.putAwayQty - allocated;
      return available <= 0;
    })
  );

  if (!allClear) return;

  const now = new Date();
  await tx
    .update(schema.receivingOrders)
    .set({ status: "clear", updatedAt: now })
    .where(eq(schema.receivingOrders.id, orderId));

  await tx.insert(schema.transitionLogs).values({
    id: uuid(),
    entityType: "receiving_order",
    entityId: orderId,
    fromState: order.status,
    toState: "clear",
    actorId,
    metadata: null,
    createdAt: now,
  });
}

export async function getReceivingOrdersWithSupplier(
  db: PgliteDatabase<typeof schema>
) {
  return db.query.receivingOrders.findMany({
    orderBy: (ro, { asc }) => [asc(ro.status), asc(ro.refNo)],
    with: { supplier: true },
  });
}

export async function getReceivingOrderDetail(
  db: PgliteDatabase<typeof schema>,
  id: string
) {
  return db.query.receivingOrders.findFirst({
    where: eq(schema.receivingOrders.id, id),
    with: {
      supplier: true,
      invoices: {
        with: {
          items: {
            with: { part: true },
          },
        },
      },
    },
  });
}

// mismatchQty meaning varies by reason:
// - damaged / quality_rejection: number of bad units to subtract from expectedQty
// - qty_mismatch: actual received quantity
// - over_shipment: extra quantity received (recorded for back office; receivedQty stays expectedQty)
// - wrong_part: quantity of the wrong part received (recorded for back office; receivedQty becomes 0)
// - not_found: always null
export function computeReceivedQty(
  expectedQty: number,
  reason: schema.MismatchReason | null,
  mismatchQty: number | null
): number {
  if (!reason) return expectedQty;

  switch (reason) {
    case "not_found":
      return 0;
    case "damaged":
    case "quality_rejection": {
      const bad = mismatchQty ?? 0;
      return Math.max(0, expectedQty - bad);
    }
    case "qty_mismatch": {
      return mismatchQty ?? 0;
    }
    case "over_shipment": {
      return expectedQty;
    }
    case "wrong_part":
      return 0;
    default:
      throw new Error(`Unhandled mismatch reason: ${reason}`);
  }
}

export function validateMismatchInputs(
  expectedQty: number,
  reason: schema.MismatchReason | null,
  mismatchQty: number | null,
  wrongPartNo: string | null
): void {
  if (!reason) return;

  if (reason === "not_found" && mismatchQty !== null) {
    throw new Error("not_found mismatch cannot include a quantity");
  }

  const qty = mismatchQty ?? 0;

  if (!Number.isInteger(qty) || qty < 0) {
    throw new Error("Quantity must be a non-negative integer");
  }

  if (reason === "damaged" || reason === "quality_rejection") {
    if (qty > expectedQty) {
      throw new Error("Damaged/rejected quantity cannot exceed expected quantity");
    }
  }

  if (reason === "over_shipment" || reason === "wrong_part") {
    if (qty <= 0) {
      throw new Error("Quantity must be greater than 0");
    }
  }

  if (reason === "wrong_part" && (!wrongPartNo || wrongPartNo.trim() === "")) {
    throw new Error("Wrong part number is required");
  }

  if (reason === "qty_mismatch" && (mismatchQty === null || mismatchQty < 0)) {
    throw new Error("Quantity mismatch requires a valid received quantity");
  }

  const receivedQty = computeReceivedQty(expectedQty, reason, mismatchQty);
  if (receivedQty < 0) {
    throw new Error("Computed received quantity cannot be negative");
  }
}

export async function canEditReceivingItemMismatch(
  dbOrTx: PgliteDatabase<typeof schema>,
  itemId: string,
  existingItem?: typeof schema.receivingInvoiceItems.$inferSelect
): Promise<boolean> {
  const item = existingItem ?? await dbOrTx.query.receivingInvoiceItems.findFirst({
    where: eq(schema.receivingInvoiceItems.id, itemId),
  });
  if (!item) return false;

  const allocatedResult = await dbOrTx
    .select({ total: sql<number>`coalesce(sum(${schema.allocations.qty}), 0)`.mapWith(Number) })
    .from(schema.allocations)
    .where(eq(schema.allocations.receivingInvoiceItemId, itemId));

  const allocated = allocatedResult[0]?.total ?? 0;
  return item.pickedQty === 0 && item.putAwayQty === 0 && allocated === 0;
}

export async function updateReceivingItemMismatch(
  db: PgliteDatabase<typeof schema>,
  itemId: string,
  actorId: string,
  reason: schema.MismatchReason | null,
  mismatchQty: number | null,
  wrongPartNo: string | null,
  note: string
): Promise<void> {
  const trimmedWrongPartNo = wrongPartNo?.trim() || null;
  const trimmedNote = note.trim() || null;

  await db.transaction(async (tx) => {
    const item = await tx.query.receivingInvoiceItems.findFirst({
      where: eq(schema.receivingInvoiceItems.id, itemId),
      with: { invoice: { with: { receivingOrder: true } } },
    });

    if (!item) {
      throw new Error("Receiving invoice item not found");
    }

    const editable = await canEditReceivingItemMismatch(tx, itemId, item);
    if (!editable) {
      throw new Error("Cannot edit mismatch: stock already allocated, picked, or put away");
    }

    validateMismatchInputs(item.qty, reason, mismatchQty, trimmedWrongPartNo);

    const receivedQty = reason
      ? computeReceivedQty(item.qty, reason, mismatchQty)
      : item.qty;

    const receivingOrder = item.invoice.receivingOrder;
    const now = new Date();

    if (receivingOrder && receivingOrder.status === "clear") {
      await tx
        .update(schema.receivingOrders)
        .set({ status: "in_hand", updatedAt: now })
        .where(eq(schema.receivingOrders.id, receivingOrder.id));
      await tx.insert(schema.transitionLogs).values({
        id: uuid(),
        entityType: "receiving_order",
        entityId: receivingOrder.id,
        fromState: "clear",
        toState: "in_hand",
        actorId,
        metadata: JSON.stringify({ reason: "mismatch_updated" }),
        createdAt: now,
      });
    }

    await tx
      .update(schema.receivingInvoiceItems)
      .set({
        receivedQty,
        reportedMismatch: reason !== null,
        mismatchReason: reason,
        mismatchQty: reason && reason !== "not_found" ? mismatchQty : null,
        wrongPartNo: reason === "wrong_part" ? trimmedWrongPartNo : null,
        mismatchNote: reason ? trimmedNote : null,
      })
      .where(eq(schema.receivingInvoiceItems.id, itemId));

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "receiving_invoice_item",
      entityId: itemId,
      fromState: item.mismatchReason ?? null,
      toState: reason ?? "none",
      actorId,
      metadata: JSON.stringify({
        reason,
        mismatchQty,
        wrongPartNo: trimmedWrongPartNo,
        receivedQty,
        note: trimmedNote,
      }),
      createdAt: now,
    });

    if (item.invoice?.receivingOrderId) {
      await tryMarkReceivingOrderClear(tx, item.invoice.receivingOrderId, actorId);
    }
  });
}

export async function confirmReceivingOrderArrived(
  db: PgliteDatabase<typeof schema>,
  orderId: string,
  actorId: string
) {
  const now = new Date();

  const order = await db.query.receivingOrders.findFirst({
    where: eq(schema.receivingOrders.id, orderId),
    with: { invoices: { with: { items: true } } },
  });

  if (!order) throw new Error("Receiving order not found");
  if (order.status !== "pending") {
    throw new Error(`Receiving order is already ${order.status}`);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(schema.receivingOrders)
      .set({
        status: "in_hand",
        arrivedAt: now,
        arrivedBy: actorId,
        updatedAt: now,
      })
      .where(eq(schema.receivingOrders.id, orderId));

    for (const invoice of order.invoices) {
      for (const item of invoice.items) {
        const qtyToReceive = item.reportedMismatch ? item.receivedQty : item.qty;
        if (qtyToReceive <= 0) continue;

        await tx
          .update(schema.receivingInvoiceItems)
          .set({ receivedQty: qtyToReceive })
          .where(eq(schema.receivingInvoiceItems.id, item.id));
      }
    }

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "receiving_order",
      entityId: orderId,
      fromState: order.status,
      toState: "in_hand",
      actorId,
      metadata: null,
      createdAt: now,
    });
  });

  // Allocation is idempotent and is intentionally run after the transaction so
  // that the confirmed receiving state is preserved even if allocation fails.
  await allocatePendingPickingOrders(db);
}
