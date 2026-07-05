import { and, eq, sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";
import { I18nError } from "~/composables/i18nError";

export interface PackageVerificationInput {
  partNo: string;
  dateCode: string;
  lotCode: string;
  coo: string;
  cow: string;
  qty: number;
}

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
          coo: string | null;
          cow: string | null;
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
    packages: Array<{
      id: string;
      pickingItemId: string;
      qty: number;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
      verified: boolean;
      pickingItem: {
        id: string;
        partId: string;
        part: typeof schema.parts.$inferSelect | null;
      } | null;
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
      packedItems: sql<number>`sum(${schema.pickingPackages.qty})`.as("packed_items"),
    })
    .from(schema.pickingPackages)
    .innerJoin(
      schema.shippingBoxes,
      eq(schema.pickingPackages.shippingBoxId, schema.shippingBoxes.id)
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
          packages: { with: { pickingItem: { with: { part: true } } } },
        },
      },
    },
  }) as Promise<MeasuringTaskDetail | undefined>;
}

export async function getShippingBoxForMeasuring(
  db: PgliteDatabase<typeof schema>,
  shippingBoxId: string
) {
  return db.query.shippingBoxes.findFirst({
    where: eq(schema.shippingBoxes.id, shippingBoxId),
    with: {
      measuringTask: {
        with: {
          pickingOrder: { with: { supplier: true } },
        },
      },
      packages: { with: { pickingItem: { with: { part: true } } } },
    },
  });
}

export type ShippingBoxForMeasuring = NonNullable<
  Awaited<ReturnType<typeof getShippingBoxForMeasuring>>
>;

export async function findMatchingUnverifiedPackage(
  db: PgliteDatabase<typeof schema>,
  shippingBoxId: string,
  input: PackageVerificationInput,
  targetPackageId?: string
) {
  const rows = await db.query.pickingPackages.findMany({
    where: and(
      eq(schema.pickingPackages.shippingBoxId, shippingBoxId),
      eq(schema.pickingPackages.verified, false)
    ),
    with: { pickingItem: { with: { part: true } } },
  });

  // Match semantics mirror receiving: empty values on either side act as wildcards,
  // and values are normalized consistently with OCR parsing.
  const normalize = (value: string | null | undefined) =>
    (value ?? "").toString().trim().toUpperCase().replace(/\s+/g, " ");
  const normalizeCode = (value: string | null | undefined) =>
    normalize(value)
      .replace(/O/g, "0")
      .replace(/I/g, "1")
      .replace(/L/g, "1")
      .replace(/Z/g, "2")
      .replace(/S/g, "5");

  const partNo = normalize(input.partNo);
  const dateCode = normalizeCode(input.dateCode);
  const lotCode = normalizeCode(input.lotCode);
  const coo = normalize(input.coo);
  const cow = normalize(input.cow);

  return (
    rows.find((pkg) => {
      if (targetPackageId && pkg.id !== targetPackageId) return false;
      if (!pkg.pickingItem?.part) return false;
      if (normalize(pkg.pickingItem.part.partNo) !== partNo) return false;
      const pkgDateCode = normalizeCode(pkg.dateCode);
      if (dateCode && pkgDateCode && dateCode !== pkgDateCode) return false;
      const pkgLotCode = normalizeCode(pkg.lotCode);
      if (lotCode && pkgLotCode && lotCode !== pkgLotCode) return false;
      const pkgCoo = normalize(pkg.coo);
      if (coo && pkgCoo && coo !== pkgCoo) return false;
      const pkgCow = normalize(pkg.cow);
      if (cow && pkgCow && cow !== pkgCow) return false;
      return pkg.qty === input.qty;
    }) ?? null
  );
}

export async function verifyPickingPackageForMeasuring(
  db: PgliteDatabase<typeof schema>,
  packageId: string,
  actorId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const pkg = await tx.query.pickingPackages.findFirst({
      where: eq(schema.pickingPackages.id, packageId),
      with: { shippingBox: { with: { measuringTask: true } } },
    });
    if (!pkg) throw new I18nError("package_not_found");
    if (!pkg.shippingBoxId) throw new I18nError("package_not_in_shipping_box");
    if (pkg.shippingBox?.status !== "open") throw new I18nError("box_is_not_open");
    if (pkg.shippingBox.measuringTask?.status !== "pending") {
      throw new I18nError("measuring_task_is_not_pending");
    }
    if (pkg.verified) throw new I18nError("package_already_verified");

    await tx
      .update(schema.pickingPackages)
      .set({ verified: true })
      .where(eq(schema.pickingPackages.id, packageId));

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "picking_package",
      entityId: packageId,
      fromState: "unverified",
      toState: "verified",
      actorId,
      metadata: JSON.stringify({ shippingBoxId: pkg.shippingBoxId }),
      createdAt: new Date(),
    });
  });
}

function normalizeWeight(value: number | string | null | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value === "string") {
    const num = Number(value);
    if (Number.isNaN(num)) throw new I18nError("weight_must_be_number");
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
  if (!box) throw new I18nError("shipping_box_not_found");
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
    if (!box) throw new I18nError("shipping_box_not_found");
    if (box.status !== "open") throw new I18nError("shipping_box_is_not_open");

    const packages = await tx
      .select()
      .from(schema.pickingPackages)
      .where(eq(schema.pickingPackages.shippingBoxId, shippingBoxId));
    if (packages.length === 0) {
      throw new I18nError("cannot_close_empty_shipping_box");
    }
    if (packages.some((p) => !p.verified)) {
      throw new I18nError("all_packages_must_be_verified");
    }

    if (
      box.grossWeight === null ||
      box.netWeight === null ||
      box.boxSize === null ||
      box.boxSize.trim() === "" ||
      box.destinationCountry === null ||
      box.destinationCountry.trim() === ""
    ) {
      throw new I18nError("box_measurements_incomplete");
    }
    if (box.grossWeight <= 0 || box.netWeight <= 0) {
      throw new I18nError("weights_must_be_greater_than_zero");
    }
    if (box.grossWeight < box.netWeight) {
      throw new I18nError("gross_weight_must_be_greater_than_or_equal_to_net_weight");
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
        shippingBoxes: { with: { packages: true } },
      },
    });
    if (!task) throw new I18nError("measuring_task_not_found");
    if (task.status !== "pending") throw new I18nError("measuring_task_is_not_pending");

    const openBox = task.shippingBoxes.find((b) => b.status !== "closed");
    if (openBox) throw new I18nError("all_shipping_boxes_must_be_closed");

    const packedByItem: Record<string, number> = {};
    for (const box of task.shippingBoxes) {
      for (const pkg of box.packages) {
        packedByItem[pkg.pickingItemId] = (packedByItem[pkg.pickingItemId] ?? 0) + pkg.qty;
      }
    }

    for (const item of task.pickingOrder?.items ?? []) {
      if ((packedByItem[item.id] ?? 0) !== item.pickedQty) {
        throw new I18nError("picking_item_not_fully_packed", { item_id: item.id });
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
