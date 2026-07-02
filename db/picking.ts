import { eq, and, sql, inArray } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";
import { tryMarkReceivingOrderClear } from "./receiving";

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
      measuringTask: true,
      items: {
        with: {
          part: true,
          allocations: {
            with: {
              inventoryLot: { with: { part: true } },
              receivingInvoiceItem: { with: { invoice: { with: { receivingOrder: true } } } },
            },
          },
          packages: true,
        },
      },
      shippingBoxes: {
        with: {
          packages: { with: { pickingItem: { with: { part: true } } } },
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
  coo: string | null,
  cow: string | null,
  tx?: PgliteDatabase<typeof schema>
): Promise<string> {
  if (tx) return materialize(tx);
  return db.transaction(materialize);

  async function materialize(tx: PgliteDatabase<typeof schema>): Promise<string> {
    const allocation = await tx.query.allocations.findFirst({
      where: eq(schema.allocations.id, allocationId),
      with: { pickingItem: true, receivingInvoiceItem: { with: { invoice: true } } },
    });

    if (!allocation) throw new Error("Allocation not found");
    if (!allocation.receivingInvoiceItemId) throw new Error("Allocation is not against a receiving item");
    if (qty <= 0 || qty > allocation.qty) throw new Error("Invalid materialize quantity");

    const invoiceItem = allocation.receivingInvoiceItem!;

    // Always create a dedicated receiving-area lot for this allocation so that
    // source accounting in scanAllocationToPackage stays tied to the original invoice item.
    const lotId = uuid();
    await tx.insert(schema.inventoryLots).values({
      id: lotId,
      partId: invoiceItem.partId,
      dateCode,
      lotCode,
      coo,
      cow,
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
  }
}

export async function scanAllocationToPackage(
  db: PgliteDatabase<typeof schema>,
  allocationId: string,
  qty: number,
  actorId: string,
  tx?: PgliteDatabase<typeof schema>
): Promise<string> {
  if (tx) return scan(tx);
  return db.transaction(scan);

  async function scan(tx: PgliteDatabase<typeof schema>): Promise<string> {
    const allocation = await tx.query.allocations.findFirst({
      where: eq(schema.allocations.id, allocationId),
      with: { pickingItem: true, inventoryLot: true, receivingInvoiceItem: true },
    });

    if (!allocation) throw new Error("Allocation not found");
    if (qty <= 0 || qty > allocation.qty) throw new Error("Invalid scan quantity");

    const item = allocation.pickingItem;
    const lot = allocation.inventoryLot;

    const scannedResult = await tx
      .select({
        total: sql<number>`coalesce(sum(${schema.pickingPackages.qty}), 0)`.mapWith(Number),
      })
      .from(schema.pickingPackages)
      .where(eq(schema.pickingPackages.pickingItemId, item.id));
    const scannedNotBoxed = scannedResult[0]?.total ?? 0;
    const alreadyCommitted = item.pickedQty + scannedNotBoxed;
    if (alreadyCommitted + qty > item.qty) {
      throw new Error("Scan quantity exceeds required quantity");
    }

    let sourceType: (typeof schema.packageSourceType)[number];
    let sourceId: string;
    let dateCode: string | null = null;
    let lotCode: string | null = null;
    let coo: string | null = null;
    let cow: string | null = null;

    if (lot) {
      if (lot.allocatedQty < qty) throw new Error("Insufficient allocated quantity");
      if (lot.totalQty < qty) throw new Error("Insufficient lot quantity");

      await tx
        .update(schema.inventoryLots)
        .set({
          totalQty: sql`${schema.inventoryLots.totalQty} - ${qty}`,
          allocatedQty: sql`${schema.inventoryLots.allocatedQty} - ${qty}`,
        })
        .where(eq(schema.inventoryLots.id, lot.id));

      // For receiving-area lots, distribute the scanned qty across source invoice items.
      if (lot.shelfCode === null && lot.boxId === null) {
        const sources = await tx.query.inventoryLotSources.findMany({
          where: eq(schema.inventoryLotSources.inventoryLotId, lot.id),
          orderBy: (ils, { asc }) => [asc(ils.id)],
        });

        const totalSourceQty = sources.reduce((sum, s) => sum + s.qty, 0);
        if (totalSourceQty < qty) throw new Error("Insufficient source quantity");

        let remaining = qty;
        const affectedReceivingItemIds: string[] = [];
        for (const source of sources) {
          if (remaining <= 0) break;
          const apply = Math.min(remaining, source.qty);
          await tx
            .update(schema.receivingInvoiceItems)
            .set({
              pickedQty: sql`${schema.receivingInvoiceItems.pickedQty} + ${apply}`,
            })
            .where(eq(schema.receivingInvoiceItems.id, source.receivingInvoiceItemId));

          await tx
            .update(schema.inventoryLotSources)
            .set({ qty: sql`${schema.inventoryLotSources.qty} - ${apply}` })
            .where(eq(schema.inventoryLotSources.id, source.id));
          affectedReceivingItemIds.push(source.receivingInvoiceItemId);
          remaining -= apply;
        }

        const orderIds = await tx
          .selectDistinct({ receivingOrderId: schema.receivingInvoices.receivingOrderId })
          .from(schema.receivingInvoiceItems)
          .innerJoin(
            schema.receivingInvoices,
            eq(schema.receivingInvoiceItems.receivingInvoiceId, schema.receivingInvoices.id)
          )
          .where(inArray(schema.receivingInvoiceItems.id, affectedReceivingItemIds));

        for (const row of orderIds) {
          if (row.receivingOrderId) {
            await tryMarkReceivingOrderClear(tx, row.receivingOrderId, actorId);
          }
        }
      }

      sourceType = "inventory_lot";
      sourceId = lot.id;
      dateCode = lot.dateCode;
      lotCode = lot.lotCode;
      coo = lot.coo;
      cow = lot.cow;
    } else if (allocation.receivingInvoiceItem) {
      const invoiceItem = allocation.receivingInvoiceItem;
      const available = invoiceItem.receivedQty - invoiceItem.pickedQty - invoiceItem.putAwayQty;
      if (available < qty) throw new Error("Insufficient receiving quantity");

      await tx
        .update(schema.receivingInvoiceItems)
        .set({ pickedQty: sql`${schema.receivingInvoiceItems.pickedQty} + ${qty}` })
        .where(eq(schema.receivingInvoiceItems.id, invoiceItem.id));

      const [invoice] = await tx
        .select()
        .from(schema.receivingInvoices)
        .where(eq(schema.receivingInvoices.id, invoiceItem.receivingInvoiceId));
      if (invoice?.receivingOrderId) {
        await tryMarkReceivingOrderClear(tx, invoice.receivingOrderId, actorId);
      }

      sourceType = "receiving_invoice_item";
      sourceId = invoiceItem.id;
      dateCode = invoiceItem.dateCode;
      lotCode = invoiceItem.lotCode;
      coo = invoiceItem.coo;
      cow = invoiceItem.cow;
    } else {
      throw new Error("Allocation has no source");
    }

    // Reduce allocation instead of deleting so the receiving-side picking view
    // can keep showing the historical link after a full scan.
    await tx
      .update(schema.allocations)
      .set({ qty: sql`${schema.allocations.qty} - ${qty}` })
      .where(eq(schema.allocations.id, allocationId));

    await tx
      .update(schema.pickingItems)
      .set({ allocatedQty: sql`${schema.pickingItems.allocatedQty} - ${qty}` })
      .where(eq(schema.pickingItems.id, item.id));

    const packageId = uuid();
    await tx.insert(schema.pickingPackages).values({
      id: packageId,
      pickingItemId: item.id,
      pickingOrderId: item.pickingOrderId,
      sourceType,
      sourceId,
      qty,
      shippingBoxId: null,
      dateCode,
      lotCode,
      coo,
      cow,
      createdAt: new Date(),
    });

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "picking_item",
      entityId: item.id,
      fromState: "picking",
      toState: "scanned",
      actorId,
      metadata: JSON.stringify({ allocationId, qty, packageId }),
      createdAt: new Date(),
    });

    return packageId;
  }
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

function getIsoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

export async function createShippingBoxForPickingOrder(
  db: PgliteDatabase<typeof schema>,
  pickingOrderId: string,
  actorId: string,
  locationCode = "HK1"
): Promise<string> {
  return db.transaction(async (tx) => {
    const order = await tx.query.pickingOrders.findFirst({
      where: eq(schema.pickingOrders.id, pickingOrderId),
    });
    if (!order) throw new Error("Picking order not found");
    if (order.status === "finished") throw new Error("Picking order is already finished");

    const now = new Date();
    const week = String(getIsoWeek(now)).padStart(2, "0");
    const year = String(now.getFullYear() % 100).padStart(2, "0");
    const prefix = `BOX-${locationCode}-${week}${year}`;

    const existing = await tx
      .select({ id: schema.shippingBoxes.id })
      .from(schema.shippingBoxes)
      .where(sql`${schema.shippingBoxes.id} LIKE ${prefix + "%"}`);

    let maxSeq = 0;
    const regex = new RegExp(`^${prefix.replace(/[-]/g, "\\-")}([0-9]{6})$`);
    for (const row of existing) {
      const match = row.id.match(regex);
      if (match) maxSeq = Math.max(maxSeq, parseInt(match[1], 10));
    }
    const boxId = `${prefix}${String(maxSeq + 1).padStart(6, "0")}`;

    await tx.insert(schema.shippingBoxes).values({
      id: boxId,
      pickingOrderId,
      status: "open",
      createdAt: now,
    });

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "shipping_box",
      entityId: boxId,
      fromState: null,
      toState: "open",
      actorId,
      metadata: JSON.stringify({ pickingOrderId }),
      createdAt: now,
    });

    return boxId;
  });
}

async function refreshPickingItemPickedQty(
  tx: PgliteDatabase<typeof schema>,
  pickingItemId: string
) {
  const result = await tx
    .select({
      total: sql<number>`coalesce(sum(${schema.pickingPackages.qty}), 0)`.mapWith(Number),
    })
    .from(schema.pickingPackages)
    .where(
      and(
        eq(schema.pickingPackages.pickingItemId, pickingItemId),
        sql`${schema.pickingPackages.shippingBoxId} is not null`
      )
    );
  const boxedQty = result[0]?.total ?? 0;
  await tx
    .update(schema.pickingItems)
    .set({ pickedQty: boxedQty })
    .where(eq(schema.pickingItems.id, pickingItemId));
}

export async function addPackageToBox(
  db: PgliteDatabase<typeof schema>,
  packageId: string,
  shippingBoxId: string,
  actorId: string
) {
  return db.transaction(async (tx) => {
    const pkg = await tx.query.pickingPackages.findFirst({
      where: eq(schema.pickingPackages.id, packageId),
      with: { pickingItem: true },
    });
    if (!pkg) throw new Error("Package not found");
    if (pkg.shippingBoxId) throw new Error("Package is already in a box");

    const box = await tx.query.shippingBoxes.findFirst({
      where: eq(schema.shippingBoxes.id, shippingBoxId),
    });
    if (!box) throw new Error("Box not found");
    if (box.status !== "open") throw new Error("Box is not open");
    if (box.pickingOrderId !== pkg.pickingOrderId) {
      throw new Error("Package does not belong to this picking order");
    }

    await tx
      .update(schema.pickingPackages)
      .set({ shippingBoxId })
      .where(eq(schema.pickingPackages.id, packageId));

    await refreshPickingItemPickedQty(tx, pkg.pickingItemId);

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "picking_item",
      entityId: pkg.pickingItemId,
      fromState: "scanned",
      toState: "boxed",
      actorId,
      metadata: JSON.stringify({ packageId, shippingBoxId, qty: pkg.qty }),
      createdAt: new Date(),
    });

    await maybeAutoFinishPickingOrder(db, pkg.pickingOrderId, actorId, tx);
  });
}

export async function removePackageFromBox(
  db: PgliteDatabase<typeof schema>,
  packageId: string,
  actorId: string
) {
  return db.transaction(async (tx) => {
    const pkg = await tx.query.pickingPackages.findFirst({
      where: eq(schema.pickingPackages.id, packageId),
      with: { pickingItem: true },
    });
    if (!pkg) throw new Error("Package not found");
    if (!pkg.shippingBoxId) throw new Error("Package is not in a box");

    const box = await tx.query.shippingBoxes.findFirst({
      where: eq(schema.shippingBoxes.id, pkg.shippingBoxId),
    });
    if (!box || box.status !== "open") {
      throw new Error("Box is not open");
    }

    const shippingBoxId = pkg.shippingBoxId;
    await tx
      .update(schema.pickingPackages)
      .set({ shippingBoxId: null, verified: false })
      .where(eq(schema.pickingPackages.id, packageId));

    await refreshPickingItemPickedQty(tx, pkg.pickingItemId);

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "picking_item",
      entityId: pkg.pickingItemId,
      fromState: "boxed",
      toState: "scanned",
      actorId,
      metadata: JSON.stringify({ packageId, shippingBoxId, qty: pkg.qty }),
      createdAt: new Date(),
    });
  });
}

export async function maybeAutoFinishPickingOrder(
  db: PgliteDatabase<typeof schema>,
  pickingOrderId: string,
  actorId: string,
  tx?: PgliteDatabase<typeof schema>
): Promise<void> {
  if (tx) return finish(tx);
  return db.transaction(finish);

  async function finish(tx: PgliteDatabase<typeof schema>): Promise<void> {
    const order = await tx.query.pickingOrders.findFirst({
      where: eq(schema.pickingOrders.id, pickingOrderId),
      with: { items: true },
    });

    if (!order || order.status === "finished") return;
    if (order.items.length === 0) return;

    const allPicked = order.items.every((i) => i.pickedQty >= i.qty);
    if (!allPicked) return;

    const now = new Date();

    await tx
      .update(schema.pickingOrders)
      .set({ status: "finished", updatedAt: now })
      .where(eq(schema.pickingOrders.id, pickingOrderId));

    const [task] = await tx
      .insert(schema.measuringTasks)
      .values({
        id: uuid(),
        pickingOrderId,
        status: "pending",
        createdAt: now,
      })
      .returning();

    if (task) {
      await tx
        .update(schema.shippingBoxes)
        .set({ measuringTaskId: task.id })
        .where(eq(schema.shippingBoxes.pickingOrderId, pickingOrderId));
    }

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "picking_order",
      entityId: pickingOrderId,
      fromState: "picking",
      toState: "finished",
      actorId,
      metadata: JSON.stringify({ auto: true }),
      createdAt: now,
    });
  }
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
    if (!allPicked) throw new Error("Not all items are fully boxed");

    const now = new Date();

    await tx
      .update(schema.pickingOrders)
      .set({ status: "finished", updatedAt: now })
      .where(eq(schema.pickingOrders.id, pickingOrderId));

    const [task] = await tx
      .insert(schema.measuringTasks)
      .values({
        id: uuid(),
        pickingOrderId,
        status: "pending",
        createdAt: now,
      })
      .returning();

    if (task) {
      await tx
        .update(schema.shippingBoxes)
        .set({ measuringTaskId: task.id })
        .where(eq(schema.shippingBoxes.pickingOrderId, pickingOrderId));
    }

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

export async function getPickingItemTransitionLogs(
  db: PgliteDatabase<typeof schema>,
  pickingItemIds: string[]
) {
  if (pickingItemIds.length === 0) return [];

  // UUIDs only contain hex and dashes, so simple quoting is safe here.
  // PGlite's Drizzle driver has trouble with multiple parameters inside IN (...),
  // so we inline the id list as raw SQL.
  const idList = pickingItemIds.map((id) => `'${id}'`).join(", ");
  const result = await db.execute(sql`
    SELECT
      tl.id,
      tl.entity_id,
      tl.from_state,
      tl.to_state,
      tl.metadata,
      tl.created_at,
      u.display_name AS actor_name
    FROM transition_logs tl
    LEFT JOIN users u ON u.id = tl.actor_id
    WHERE tl.entity_type = 'picking_item'
      AND tl.entity_id IN (${sql.raw(idList)})
    ORDER BY tl.created_at DESC
  `);

  return ((result.rows ?? []) as any[]).map((row) => ({
    id: row.id,
    entityId: row.entity_id,
    fromState: row.from_state,
    toState: row.to_state,
    metadata: row.metadata,
    createdAt: row.created_at,
    actorName: row.actor_name,
  }));
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
  scanned_qty: number;
  boxed_qty: number;
  part_id: string;
  part_no: string;
  shelf_code: string | null;
  box_id: string | null;
  date_code: string | null;
  lot_code: string | null;
  coo: string | null;
  cow: string | null;
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
        il.coo,
        il.cow,
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
        NULL AS coo,
        NULL AS cow,
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
    ),
    combined AS (
      SELECT * FROM lot_allocations
      UNION ALL
      SELECT * FROM invoice_allocations
    ),
    package_totals AS (
      SELECT
        picking_item_id,
        COALESCE(SUM(CASE WHEN shipping_box_id IS NULL THEN qty ELSE 0 END), 0) AS scanned_qty,
        COALESCE(SUM(CASE WHEN shipping_box_id IS NOT NULL THEN qty ELSE 0 END), 0) AS boxed_qty
      FROM picking_packages
      GROUP BY picking_item_id
    )
    SELECT
      c.picking_order_id,
      c.picking_order_ref,
      c.picking_order_status,
      c.picking_order_ship_to,
      c.picking_item_id,
      c.required_qty,
      c.picked_qty,
      COALESCE(pt.scanned_qty, 0) AS scanned_qty,
      COALESCE(pt.boxed_qty, 0) AS boxed_qty,
      c.part_id,
      c.part_no,
      c.shelf_code,
      c.box_id,
      c.date_code,
      c.lot_code,
      c.coo,
      c.cow,
      c.allocated_qty,
      c.allocation_id
    FROM combined c
    LEFT JOIN package_totals pt ON pt.picking_item_id = c.picking_item_id
    ORDER BY c.picking_order_ref, c.part_no;
  `);

  return (result.rows ?? []) as PickingByReceivingRow[];
}
