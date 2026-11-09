import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db.js";
import { pickingOrders, pickingItems } from "../../db/schema/picking.js";
import { subInventories } from "../../db/schema/master.js";
import { newId } from "../../db/id.js";
import { allocateForPickingOrder, awaitAllocationTask } from "../../db/allocate.js";
import { mapDbError, optInt, optStr, reqInt, reqStr } from "./crud.js";

// VMI picking order creator — the admin "New VMI" upload (spec
// 2026-11-09-vmi-picking-excel-upload-design.md). The browser decodes the
// VMI_Template_*.xlsx client-side (utils/vmiExcel.ts) and posts one order per
// VMI Ref.No group. Mirrors test-create minus the [TEST] remark; these are
// real orders and pickingOrderType is fixed to 'vmi'.

export const adminVmiPickingOrderRoute = new Hono();

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

// POST /admin/picking-orders/vmi-create — batch-create VMI picking orders.
adminVmiPickingOrderRoute.post("/picking-orders/vmi-create", async (c) => {
  const body = await readJson(c);

  const ordersRaw = body.orders;
  if (!Array.isArray(ordersRaw) || ordersRaw.length === 0)
    throw new HTTPException(400, { message: "orders must be a non-empty array" });

  const orders = ordersRaw.map((raw, i) => {
    if (typeof raw !== "object" || raw === null)
      throw new HTTPException(400, { message: `orders[${i}] must be an object` });
    const o = raw as Record<string, unknown>;
    const itemsRaw = o.items;
    if (!Array.isArray(itemsRaw) || itemsRaw.length === 0)
      throw new HTTPException(400, { message: `orders[${i}].items must be a non-empty array` });
    const items = (itemsRaw as Record<string, unknown>[]).map((item, j) => {
      const partNo = reqStr(item, "partNo");
      const qty = reqInt(item, "qty");
      if (qty <= 0) throw new HTTPException(400, { message: `orders[${i}].items[${j}].qty must be > 0` });
      return { partNo, qty, lineNumber: optInt(item, "lineNumber"), customerItem: optStr(item, "customerItem") };
    });
    return {
      orderNo: reqStr(o, "orderNo"),
      orgId: reqInt(o, "orgId"),
      subInventoryCode: reqStr(o, "subInventoryCode"),
      customerCode: optStr(o, "customerCode"),
      shipTo: optStr(o, "shipTo"),
      poNo: optStr(o, "poNo"),
      items,
    };
  });

  // Double-upload guard: order_no is not unique in the table (upstream dedups
  // on its own ids), so VMI batches reject any ref that already exists —
  // creating it twice would double-reserve stock.
  const dupes = await db
    .select({ orderNo: pickingOrders.orderNo })
    .from(pickingOrders)
    .where(inArray(pickingOrders.orderNo, orders.map((o) => o.orderNo)));
  if (dupes.length > 0)
    throw new HTTPException(409, {
      message: `order(s) already exist: ${[...new Set(dupes.map((d) => d.orderNo))].join(", ")}`,
    });

  // Validate every distinct org + sub-inventory pair (composite FK).
  const pairs = new Map<string, { orgId: number; code: string }>();
  for (const o of orders) pairs.set(`${o.orgId}\u0000${o.subInventoryCode}`, { orgId: o.orgId, code: o.subInventoryCode });
  for (const p of pairs.values()) {
    const found = await db
      .select({ id: subInventories.id })
      .from(subInventories)
      .where(and(eq(subInventories.orgId, p.orgId), eq(subInventories.secondaryInventoryName, p.code)))
      .limit(1);
    if (found.length === 0)
      throw new HTTPException(400, { message: `orgId ${p.orgId} + subInventoryCode "${p.code}" is not a valid pair` });
  }

  const created: { id: string; orderNo: string }[] = [];
  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      for (const o of orders) {
        const orderId = newId();
        await tx.insert(pickingOrders).values({
          id: orderId,
          orderNo: o.orderNo,
          customerCode: o.customerCode,
          orgId: o.orgId,
          subInventoryCode: o.subInventoryCode,
          shipTo: o.shipTo,
          poNo: o.poNo,
          prioritySeq: 0,
          pickingOrderType: "vmi",
          status: "pending",
          allocationStatus: "unallocated",
          createdDate: now,
          lastUpdateDate: now,
        });
        for (const [j, item] of o.items.entries()) {
          await tx.insert(pickingItems).values({
            id: newId(),
            pickingOrderId: orderId,
            partNo: item.partNo,
            qty: item.qty,
            pickedQty: 0,
            allocatedQty: 0,
            lineNumber: item.lineNumber ?? j + 1,
            status: "pending",
            additionalData: item.customerItem ? { customerItem: item.customerItem } : null,
            createdDate: now,
            lastUpdateDate: now,
          });
        }
        created.push({ id: orderId, orderNo: o.orderNo });
      }
    });
  } catch (e) {
    mapDbError(e);
  }

  // Allocate each new order synchronously (scoped run) like test-create —
  // a failure leaves the order unallocated until Re-allocate.
  for (const o of created) {
    try {
      await awaitAllocationTask(db, "vmi order create", (runnerDb) => allocateForPickingOrder(runnerDb, o.id));
    } catch (err) {
      console.error("allocation after VMI order create failed; order stays unallocated until Re-allocate", err);
    }
  }

  return c.json({ created }, 200);
});
