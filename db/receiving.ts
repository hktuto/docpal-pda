import { eq, sql, inArray } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";
import { allocatePendingPickingOrders } from "./allocate";
import { getActiveMismatchesForItems } from "./mismatch";
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

    const itemIds = order.invoices.flatMap((inv) => inv.items.map((i) => i.id));
    const activeMismatches = await getActiveMismatchesForItems(tx, itemIds);

    for (const invoice of order.invoices) {
      for (const item of invoice.items) {
        const mismatch = activeMismatches.get(item.id);
        const qtyToReceive = mismatch ? mismatch.effectiveReceivedQty : item.qty;
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
