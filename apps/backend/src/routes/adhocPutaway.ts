import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import {
  commitAdHocPutAway,
  listAdHocPutAwayLocations,
  listAdHocPutAwayBrands,
  scheduleAllocateAll,
} from "../db/adhocPutaway.js";
import { actorFrom } from "../auth/middleware.js";

async function readJson<T>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

export const adHocPutAwayRoute = new Hono();

// Valid (org_id, sub_inventory_code) pairs for the PDA location selector.
adHocPutAwayRoute.get("/ad-hoc-put-away/locations", async (c) => {
  return c.json(await listAdHocPutAwayLocations(db), 200);
});

// Distinct brand values from parts for the PDA brand dropdown.
adHocPutAwayRoute.get("/ad-hoc-put-away/brands", async (c) => {
  return c.json(await listAdHocPutAwayBrands(db), 200);
});

// Commit an ad-hoc put-away batch (spec 2026-10-07-ad-hoc-put-away-design.md).
adHocPutAwayRoute.post("/ad-hoc-put-away", async (c) => {
  const body = await readJson<{
    brand?: string;
    shelfCode?: string;
    items?: Array<{
      partNo?: string;
      wclItemNo?: string | null;
      qty?: number;
      dateCode?: string | null;
      lotCode?: string | null;
      coo?: string | null;
      cow?: string | null;
      serialNo?: string | null;
      orgId?: number;
      subInventoryCode?: string;
    }>;
  }>(c);

  if (!body.brand) {
    throw new HTTPException(400, { message: "brand is required" });
  }
  if (!body.shelfCode) {
    throw new HTTPException(400, { message: "shelfCode is required" });
  }
  if (!body.items || !body.items.length) {
    throw new HTTPException(400, { message: "items must be a non-empty array" });
  }

  // Validate each item
  for (const item of body.items) {
    if (!item.partNo) {
      throw new HTTPException(400, { message: "each item requires partNo" });
    }
    if (!item.qty || item.qty <= 0) {
      throw new HTTPException(400, { message: "each item requires a positive qty" });
    }
    if (!item.orgId) {
      throw new HTTPException(400, { message: "each item requires orgId" });
    }
    if (!item.subInventoryCode) {
      throw new HTTPException(400, { message: "each item requires subInventoryCode" });
    }
  }

  try {
    const result = await commitAdHocPutAway(db, {
      brand: body.brand,
      shelfCode: body.shelfCode,
      items: body.items.map((i) => ({
        partNo: i.partNo!,
        wclItemNo: i.wclItemNo ?? null,
        qty: i.qty!,
        dateCode: i.dateCode ?? null,
        lotCode: i.lotCode ?? null,
        coo: i.coo ?? null,
        cow: i.cow ?? null,
        serialNo: i.serialNo ?? null,
        orgId: i.orgId!,
        subInventoryCode: i.subInventoryCode!,
      })),
      actorId: actorFrom(c).id,
    });
    // New stock may affect picking — re-run allocation in the background.
    scheduleAllocateAll(db, "ad-hoc put-away");
    return c.json(result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    if (message.startsWith("shelf_not_found:")) {
      throw new HTTPException(404, { message: "shelf_not_found" });
    }
    if (message.startsWith("part_not_found:")) {
      throw new HTTPException(404, { message: "part_not_found" });
    }
    if (message.startsWith("ad-hoc put-away requires")) {
      throw new HTTPException(400, { message });
    }
    throw err;
  }
});
