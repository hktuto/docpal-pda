import { eq } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";
import { allocatePendingPickingOrders } from "./allocate";

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

export async function updateReceivingItemMismatch(
  db: PgliteDatabase<typeof schema>,
  itemId: string,
  actualQty: number,
  note: string
) {
  if (!Number.isInteger(actualQty) || actualQty < 0) {
    throw new Error("actualQty must be a non-negative integer");
  }

  const result = await db
    .update(schema.receivingInvoiceItems)
    .set({
      receivedQty: actualQty,
      reportedMismatch: true,
      mismatchNote: note.trim() || null,
    })
    .where(eq(schema.receivingInvoiceItems.id, itemId));

  if (result.rowCount === 0) {
    throw new Error("Receiving invoice item not found");
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
