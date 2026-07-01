import { eq, and, sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";

export interface MeasuringTaskSummary {
  id: string;
  status: (typeof schema.measuringTaskStatus)[number];
  pickingOrderId: string;
  pickingOrderRef: string | null;
  supplierName: string | null;
  totalItems: number;
  packedItems: number;
}

export interface MeasuringTaskDetail {
  id: string;
  status: (typeof schema.measuringTaskStatus)[number];
  pickingOrderId: string;
  createdAt: Date;
  pickingOrder: {
    id: string;
    refNo: string | null;
    supplierId: string | null;
    deliveryDate: Date | null;
    poNo: string | null;
    requiredDateCodeNotice: string | null;
    status: (typeof schema.pickingOrderStatus)[number];
    createdAt: Date;
    updatedAt: Date;
    supplier: typeof schema.suppliers.$inferSelect | null;
    items: Array<{
      id: string;
      pickingOrderId: string;
      partId: string;
      qty: number;
      pickedQty: number;
      requiredDateCode: string | null;
      sourceShelfCode: string | null;
      part: typeof schema.parts.$inferSelect | null;
      allocations: Array<{
        id: string;
        pickingItemId: string;
        inventoryLotId: string;
        qty: number;
        inventoryLot: {
          id: string;
          partId: string;
          dateCode: string | null;
          lotCode: string | null;
          originCountry: string | null;
          shelfCode: string | null;
          boxId: string | null;
          totalQty: number;
          allocatedQty: number;
          part: typeof schema.parts.$inferSelect | null;
        };
      }>;
    }>;
  } | null;
  shippingBoxes: Array<{
    id: string;
    pickingOrderId: string | null;
    measuringTaskId: string | null;
    status: (typeof schema.boxStatus)[number];
    grossWeight: number | null;
    netWeight: number | null;
    destinationCountry: string | null;
    boxSize: string | null;
    createdAt: Date;
    items: Array<{
      id: string;
      shippingBoxId: string;
      pickingItemId: string | null;
      partId: string;
      qty: number;
      part: typeof schema.parts.$inferSelect | null;
    }>;
  }>;
}

export interface ShippingBoxUpdateFields {
  grossWeight?: number | string | null;
  netWeight?: number | string | null;
  destinationCountry?: string | null;
  boxSize?: string | null;
}

export async function getMeasuringTasks(
  db: PgliteDatabase<typeof schema>
): Promise<MeasuringTaskSummary[]> {
  const totalItemsSubquery = db
    .select({
      pickingOrderId: schema.pickingItems.pickingOrderId,
      totalItems: sql<number>`sum(${schema.pickingItems.qty})`.as("total_items"),
    })
    .from(schema.pickingItems)
    .groupBy(schema.pickingItems.pickingOrderId)
    .as("total_items");

  const packedItemsSubquery = db
    .select({
      measuringTaskId: schema.shippingBoxes.measuringTaskId,
      packedItems: sql<number>`sum(${schema.shippingBoxItems.qty})`.as("packed_items"),
    })
    .from(schema.shippingBoxItems)
    .innerJoin(
      schema.shippingBoxes,
      eq(schema.shippingBoxItems.shippingBoxId, schema.shippingBoxes.id)
    )
    .groupBy(schema.shippingBoxes.measuringTaskId)
    .as("packed_items");

  return db
    .select({
      id: schema.measuringTasks.id,
      status: schema.measuringTasks.status,
      pickingOrderId: schema.pickingOrders.id,
      pickingOrderRef: schema.pickingOrders.refNo,
      supplierName: schema.suppliers.name,
      totalItems: sql<number>`coalesce(${totalItemsSubquery.totalItems}, 0)`.mapWith(Number),
      packedItems: sql<number>`coalesce(${packedItemsSubquery.packedItems}, 0)`.mapWith(Number),
    })
    .from(schema.measuringTasks)
    .innerJoin(
      schema.pickingOrders,
      eq(schema.measuringTasks.pickingOrderId, schema.pickingOrders.id)
    )
    .leftJoin(schema.suppliers, eq(schema.pickingOrders.supplierId, schema.suppliers.id))
    .leftJoin(
      totalItemsSubquery,
      eq(totalItemsSubquery.pickingOrderId, schema.pickingOrders.id)
    )
    .leftJoin(
      packedItemsSubquery,
      eq(packedItemsSubquery.measuringTaskId, schema.measuringTasks.id)
    )
    .where(eq(schema.measuringTasks.status, "pending"));
}

export async function getMeasuringTaskDetail(
  db: PgliteDatabase<typeof schema>,
  measuringTaskId: string
): Promise<MeasuringTaskDetail | undefined> {
  return db.query.measuringTasks.findFirst({
    where: eq(schema.measuringTasks.id, measuringTaskId),
    with: {
      pickingOrder: {
        with: {
          supplier: true,
          items: {
            with: {
              part: true,
              allocations: {
                with: {
                  inventoryLot: { with: { part: true } },
                },
              },
            },
          },
        },
      },
      shippingBoxes: {
        with: {
          items: { with: { part: true } },
        },
      },
    },
  }) as Promise<MeasuringTaskDetail | undefined>;
}

export async function createShippingBox(
  db: PgliteDatabase<typeof schema>,
  measuringTaskId: string
): Promise<typeof schema.shippingBoxes.$inferSelect> {
  const task = await db.query.measuringTasks.findFirst({
    where: eq(schema.measuringTasks.id, measuringTaskId),
  });
  if (!task) throw new Error("Measuring task not found");

  const [box] = await db
    .insert(schema.shippingBoxes)
    .values({
      id: uuid(),
      pickingOrderId: task.pickingOrderId,
      measuringTaskId,
      status: "open",
      createdAt: new Date(),
    })
    .returning();

  if (!box) throw new Error("Failed to create shipping box");
  return box;
}

export async function addItemToShippingBox(
  db: PgliteDatabase<typeof schema>,
  shippingBoxId: string,
  pickingItemId: string,
  qty: number
): Promise<typeof schema.shippingBoxItems.$inferSelect> {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error("Qty must be a positive integer");
  }

  return db.transaction(async (tx) => {
    const [box] = await tx
      .select()
      .from(schema.shippingBoxes)
      .where(eq(schema.shippingBoxes.id, shippingBoxId));
    if (!box) throw new Error("Shipping box not found");
    if (box.status !== "open") throw new Error("Shipping box is not open");

    const [pickingItem] = await tx
      .select()
      .from(schema.pickingItems)
      .where(eq(schema.pickingItems.id, pickingItemId));
    if (!pickingItem) throw new Error("Picking item not found");
    if (pickingItem.pickingOrderId !== box.pickingOrderId) {
      throw new Error("Picking item does not belong to this order");
    }
    if (qty > pickingItem.pickedQty) {
      throw new Error("Qty exceeds picked quantity");
    }

    const [packedResult] = await tx
      .select({
        total: sql<number>`coalesce(sum(${schema.shippingBoxItems.qty}), 0)`.mapWith(Number),
      })
      .from(schema.shippingBoxItems)
      .where(eq(schema.shippingBoxItems.pickingItemId, pickingItemId));
    const packedQty = packedResult?.total ?? 0;
    if (packedQty + qty > pickingItem.pickedQty) {
      throw new Error("Total packed quantity would exceed picked quantity");
    }

    const [item] = await tx
      .insert(schema.shippingBoxItems)
      .values({
        id: uuid(),
        shippingBoxId,
        pickingItemId,
        partId: pickingItem.partId,
        qty,
      })
      .returning();

    if (!item) throw new Error("Failed to add item to shipping box");
    return item;
  });
}

function normalizeWeight(value: number | string | null | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value === "string") {
    const num = Number(value);
    if (Number.isNaN(num)) throw new Error("Weight must be a number");
    return num;
  }
  return value;
}

function normalizeString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === "") return null;
  return value;
}

export async function updateShippingBox(
  db: PgliteDatabase<typeof schema>,
  shippingBoxId: string,
  fields: ShippingBoxUpdateFields
): Promise<typeof schema.shippingBoxes.$inferSelect> {
  const set: Partial<typeof schema.shippingBoxes.$inferInsert> = {};
  if ("grossWeight" in fields) set.grossWeight = normalizeWeight(fields.grossWeight);
  if ("netWeight" in fields) set.netWeight = normalizeWeight(fields.netWeight);
  if ("destinationCountry" in fields) {
    set.destinationCountry = normalizeString(fields.destinationCountry);
  }
  if ("boxSize" in fields) set.boxSize = normalizeString(fields.boxSize);

  const [box] = await db
    .update(schema.shippingBoxes)
    .set(set)
    .where(eq(schema.shippingBoxes.id, shippingBoxId))
    .returning();
  if (!box) throw new Error("Shipping box not found");
  return box;
}

export async function closeShippingBox(
  db: PgliteDatabase<typeof schema>,
  shippingBoxId: string,
  actorId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const [box] = await tx
      .select()
      .from(schema.shippingBoxes)
      .where(eq(schema.shippingBoxes.id, shippingBoxId));
    if (!box) throw new Error("Shipping box not found");
    if (box.status !== "open") throw new Error("Shipping box is not open");

    const [itemCount] = await tx
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.shippingBoxItems)
      .where(eq(schema.shippingBoxItems.shippingBoxId, shippingBoxId));
    if (!itemCount || itemCount.count === 0) {
      throw new Error("Cannot close an empty shipping box");
    }

    await tx
      .update(schema.shippingBoxes)
      .set({ status: "closed" })
      .where(eq(schema.shippingBoxes.id, shippingBoxId));

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "shipping_box",
      entityId: shippingBoxId,
      fromState: box.status,
      toState: "closed",
      actorId,
      metadata: null,
      createdAt: new Date(),
    });
  });
}

export async function completeMeasuringTask(
  db: PgliteDatabase<typeof schema>,
  measuringTaskId: string,
  actorId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const task = await tx.query.measuringTasks.findFirst({
      where: eq(schema.measuringTasks.id, measuringTaskId),
      with: {
        pickingOrder: { with: { items: true } },
        shippingBoxes: { with: { items: true } },
      },
    });
    if (!task) throw new Error("Measuring task not found");
    if (task.status !== "pending") throw new Error("Measuring task is not pending");

    const openBox = task.shippingBoxes.find((b) => b.status !== "closed");
    if (openBox) throw new Error("All shipping boxes must be closed before completing");

    const items = task.pickingOrder?.items ?? [];
    for (const item of items) {
      const packedQty = task.shippingBoxes
        .flatMap((b) => b.items)
        .filter((i) => i.pickingItemId === item.id)
        .reduce((sum, i) => sum + i.qty, 0);
      if (packedQty !== item.pickedQty) {
        throw new Error(`Picking item ${item.id} is not fully packed`);
      }
    }

    await tx
      .update(schema.measuringTasks)
      .set({ status: "completed" })
      .where(eq(schema.measuringTasks.id, measuringTaskId));

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "measuring_task",
      entityId: measuringTaskId,
      fromState: task.status,
      toState: "completed",
      actorId,
      metadata: null,
      createdAt: new Date(),
    });
  });
}
