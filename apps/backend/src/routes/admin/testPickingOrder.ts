import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../../db.js";
import { pickingOrders, pickingItems } from "../../db/schema/picking.js";
import { subInventories } from "../../db/schema/master.js";
import { newId } from "../../db/id.js";
import { scheduleAllocateAll } from "../../db/allocate.js";
import { eq, and } from "drizzle-orm";

// Test picking order creator — lets admin users create picking orders from
// scratch for testing different scenarios. Orders are marked with a [TEST]
// remark prefix so they can be identified and cleaned up later.

const TEST_REMARK_PREFIX = "[TEST]";

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

function reqStr(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.trim() === "")
    throw new HTTPException(400, { message: `${key} is required` });
  return v.trim();
}

function optStr(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HTTPException(400, { message: `${key} must be a string` });
  return v.trim() === "" ? null : v.trim();
}

function reqInt(body: Record<string, unknown>, key: string): number {
  const v = body[key];
  if (!Number.isInteger(v)) throw new HTTPException(400, { message: `${key} must be an integer` });
  return v as number;
}

function optInt(body: Record<string, unknown>, key: string): number | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v)) throw new HTTPException(400, { message: `${key} must be an integer` });
  return v as number;
}

export const adminTestPickingOrderRoute = new Hono();

// POST /admin/picking-orders/test-create — create a test picking order + items.
adminTestPickingOrderRoute.post("/picking-orders/test-create", async (c) => {
  const body = await readJson(c);

  const orderNo = reqStr(body, "orderNo");
  const orgId = reqInt(body, "orgId");
  const subInventoryCode = reqStr(body, "subInventoryCode");
  const customerCode = optStr(body, "customerCode");
  const shipTo = optStr(body, "shipTo");
  const poNo = optStr(body, "poNo");
  const deliveryDate = optStr(body, "deliveryDate");
  const prioritySeq = optInt(body, "prioritySeq") ?? 0;
  const pickingOrderType = optStr(body, "pickingOrderType");
  const remark = optStr(body, "remark");

  // Validate items
  const itemsRaw = body.items;
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0)
    throw new HTTPException(400, { message: "at least one item is required" });

  const items: { partNo: string; qty: number; lineNumber: number | null }[] = [];
  for (const [i, item] of (itemsRaw as Record<string, unknown>[]).entries()) {
    if (typeof item !== "object" || item === null)
      throw new HTTPException(400, { message: `items[${i}] must be an object` });
    const partNo = reqStr(item, "partNo");
    const qty = reqInt(item, "qty");
    if (qty <= 0) throw new HTTPException(400, { message: `items[${i}].qty must be > 0` });
    const lineNumber = optInt(item, "lineNumber");
    items.push({ partNo, qty, lineNumber });
  }

  // Validate org + sub-inventory pair exists
  const subInv = await db
    .select({ id: subInventories.id })
    .from(subInventories)
    .where(and(eq(subInventories.orgId, orgId), eq(subInventories.secondaryInventoryName, subInventoryCode)))
    .limit(1);
  if (subInv.length === 0)
    throw new HTTPException(400, { message: `orgId ${orgId} + subInventoryCode "${subInventoryCode}" is not a valid pair` });

  const orderId = newId();
  const now = new Date();
  const fullRemark = remark ? `${TEST_REMARK_PREFIX} ${remark}` : TEST_REMARK_PREFIX;

  await db.transaction(async (tx) => {
    await tx.insert(pickingOrders).values({
      id: orderId,
      orderNo,
      customerCode,
      orgId,
      subInventoryCode,
      shipTo,
      poNo,
      deliveryDate: deliveryDate ? new Date(deliveryDate) : null,
      prioritySeq,
      pickingOrderType,
      remark: fullRemark,
      status: "pending",
      allocationStatus: "unallocated",
      createdDate: now,
      lastUpdateDate: now,
    });

    for (const [i, item] of items.entries()) {
      await tx.insert(pickingItems).values({
        id: newId(),
        pickingOrderId: orderId,
        partNo: item.partNo,
        qty: item.qty,
        pickedQty: 0,
        allocatedQty: 0,
        lineNumber: item.lineNumber ?? i + 1,
        status: "pending",
        createdDate: now,
        lastUpdateDate: now,
      });
    }
  });

  // Schedule allocation so the order enters the pipeline like a real one
  scheduleAllocateAll(db, "test_order_create");

  return c.json(
    {
      id: orderId,
      orderNo,
      items: items.map((item, i) => ({
        id: `${orderId}-item-${i}`,
        partNo: item.partNo,
        qty: item.qty,
        lineNumber: item.lineNumber ?? i + 1,
      })),
    },
    200
  );
});

// GET /admin/picking-orders/:id/export — export order + items as a JSON template.
adminTestPickingOrderRoute.get("/picking-orders/:id/export", async (c) => {
  const orderId = c.req.param("id");

  const order = await db.select().from(pickingOrders).where(eq(pickingOrders.id, orderId)).limit(1);
  if (order.length === 0) throw new HTTPException(404, { message: "picking order not found" });

  const items = await db
    .select({
      partNo: pickingItems.partNo,
      qty: pickingItems.qty,
      lineNumber: pickingItems.lineNumber,
    })
    .from(pickingItems)
    .where(eq(pickingItems.pickingOrderId, orderId));

  const o = order[0];
  return c.json(
    {
      orderNo: o.orderNo,
      customerCode: o.customerCode,
      orgId: o.orgId,
      subInventoryCode: o.subInventoryCode,
      shipTo: o.shipTo,
      poNo: o.poNo,
      deliveryDate: o.deliveryDate,
      prioritySeq: o.prioritySeq,
      pickingOrderType: o.pickingOrderType,
      remark: o.remark?.startsWith(TEST_REMARK_PREFIX)
        ? o.remark.slice(TEST_REMARK_PREFIX.length).trim()
        : o.remark,
      items: items.map((item) => ({
        partNo: item.partNo,
        qty: item.qty,
        lineNumber: item.lineNumber,
      })),
    },
    200
  );
});

// DELETE /admin/picking-orders/:id/test — delete a test order (only if remark
// starts with [TEST]). Cascades to items → packages → allocations.
adminTestPickingOrderRoute.delete("/picking-orders/:id/test", async (c) => {
  const orderId = c.req.param("id");

  const order = await db
    .select({ id: pickingOrders.id, remark: pickingOrders.remark })
    .from(pickingOrders)
    .where(eq(pickingOrders.id, orderId))
    .limit(1);
  if (order.length === 0) throw new HTTPException(404, { message: "picking order not found" });

  const o = order[0];
  if (!o.remark?.startsWith(TEST_REMARK_PREFIX))
    throw new HTTPException(409, { message: "only test orders (remark starting with [TEST]) can be deleted via this endpoint" });

  // Delete items first (cascade should handle it, but be explicit for safety)
  await db.delete(pickingItems).where(eq(pickingItems.pickingOrderId, orderId));
  await db.delete(pickingOrders).where(eq(pickingOrders.id, orderId));

  return c.json({ deleted: true, id: orderId }, 200);
});
