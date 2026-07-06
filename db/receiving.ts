import { eq, sql, inArray } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";
import { allocatePendingPickingOrders } from "./allocate";
import { I18nError } from "~/composables/i18nError";

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

export async function tryMarkReceivingOrderInHand(
  tx: PgliteDatabase<typeof schema>,
  orderId: string,
  actorId: string
): Promise<void> {
  const order = await tx.query.receivingOrders.findFirst({
    where: eq(schema.receivingOrders.id, orderId),
    with: { invoices: { with: { items: true } } },
  });
  if (!order || order.status !== "clear") return;

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

  const hasAvailable = order.invoices.some((inv) =>
    inv.items.some((item) => {
      const allocated = allocatedMap.get(item.id) ?? 0;
      const available = item.receivedQty - item.pickedQty - item.putAwayQty - allocated;
      return available > 0;
    })
  );

  if (!hasAvailable) return;

  const now = new Date();
  await tx
    .update(schema.receivingOrders)
    .set({ status: "in_hand", updatedAt: now })
    .where(eq(schema.receivingOrders.id, orderId));

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
      throw new I18nError("unhandled_mismatch_reason", { reason });
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
    throw new I18nError("not_found_mismatch_cannot_include_qty");
  }

  const qty = mismatchQty ?? 0;

  if (!Number.isInteger(qty) || qty < 0) {
    throw new I18nError("quantity_must_be_non_negative_integer");
  }

  if (reason === "damaged" || reason === "quality_rejection") {
    if (qty > expectedQty) {
      throw new I18nError("damaged_rejected_quantity_exceeds_expected");
    }
  }

  if (reason === "over_shipment" || reason === "wrong_part") {
    if (qty <= 0) {
      throw new I18nError("quantity_must_be_greater_than_zero");
    }
  }

  if (reason === "wrong_part" && (!wrongPartNo || wrongPartNo.trim() === "")) {
    throw new I18nError("wrong_part_number_required");
  }

  if (reason === "qty_mismatch" && (mismatchQty === null || mismatchQty < 0)) {
    throw new I18nError("quantity_mismatch_requires_valid_received_qty");
  }

  const receivedQty = computeReceivedQty(expectedQty, reason, mismatchQty);
  if (receivedQty < 0) {
    throw new I18nError("computed_received_quantity_cannot_be_negative");
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

  return item.pickedQty === 0 && item.putAwayQty === 0;
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

  let receivingOrderId: string | null = null;

  await db.transaction(async (tx) => {
    const item = await tx.query.receivingInvoiceItems.findFirst({
      where: eq(schema.receivingInvoiceItems.id, itemId),
      with: { invoice: { with: { receivingOrder: true } } },
    });

    if (!item) {
      throw new I18nError("receiving_invoice_item_not_found");
    }

    const editable = await canEditReceivingItemMismatch(tx, itemId, item);
    if (!editable) {
      throw new I18nError("cannot_edit_mismatch_stock_in_use");
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

    // Trim allocations if the new received quantity reduces availability.
    // pickedQty and putAwayQty are guaranteed zero here (canEditReceivingItemMismatch),
    // so available == receivedQty.
    const newAvailable = receivedQty;
    const allocatedResult = await tx
      .select({
        total: sql<number>`coalesce(sum(${schema.allocations.qty}), 0)`.mapWith(Number),
      })
      .from(schema.allocations)
      .where(eq(schema.allocations.receivingInvoiceItemId, itemId));

    const totalAllocated = allocatedResult[0]?.total ?? 0;

    if (totalAllocated > newAvailable) {
      const excess = totalAllocated - newAvailable;
      const allocationsToTrim = await tx
        .select()
        .from(schema.allocations)
        .where(eq(schema.allocations.receivingInvoiceItemId, itemId))
        .orderBy(sql`${schema.allocations.id} DESC`);

      let remaining = excess;
      for (const allocation of allocationsToTrim) {
        if (remaining <= 0) break;
        const cut = Math.min(remaining, allocation.qty);

        if (cut >= allocation.qty) {
          await tx.delete(schema.allocations).where(eq(schema.allocations.id, allocation.id));
        } else {
          await tx
            .update(schema.allocations)
            .set({ qty: sql`${schema.allocations.qty} - ${cut}` })
            .where(eq(schema.allocations.id, allocation.id));
        }

        await tx
          .update(schema.pickingItems)
          .set({ allocatedQty: sql`${schema.pickingItems.allocatedQty} - ${cut}` })
          .where(eq(schema.pickingItems.id, allocation.pickingItemId));

        if (allocation.inventoryLotId) {
          await tx
            .update(schema.inventoryLots)
            .set({ allocatedQty: sql`${schema.inventoryLots.allocatedQty} - ${cut}` })
            .where(eq(schema.inventoryLots.id, allocation.inventoryLotId));
        }

        remaining -= cut;
      }
    }

    receivingOrderId = item.invoice?.receivingOrderId ?? null;
  });

  // Reallocate freed stock to pending picking orders, then re-evaluate clear status.
  await allocatePendingPickingOrders(db);
  if (receivingOrderId) {
    await tryMarkReceivingOrderClear(db, receivingOrderId, actorId);
  }
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

  if (!order) throw new I18nError("receiving_order_not_found");
  if (order.status !== "pending") {
    throw new I18nError("receiving_order_already_status", { status: order.status });
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
