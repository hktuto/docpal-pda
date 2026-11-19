import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { docpalBaseUrl, docpalFetchTimeoutMs } from "../../config.js";

// DocPal customer part-number lookup for the Custom Print Label box labels
// (template rohs-7, apps/admin/pages/custom-print-label.vue): per line
// (order_no, wcl_item_no) the DocPal oracle order-item-refs API returns
// cust_part_no — printed as the box label's item partNumber. Same shape as the
// picking-list custRefs enrichment (src/export/picking-list/custRefs.ts), but
// client-initiated from the admin browser, which cannot reach DocPal directly.
//
// Fail-soft: a DocPal outage must not block label printing — lines come back
// with custPartNo: null (the label prints with an empty partNumber) and the
// failure is logged for follow-up.

interface RefLine {
  orderNo: string;
  wclItemNo: string;
}

interface RefResult extends RefLine {
  custPartNo: string | null;
}

interface DocPalRefItem {
  order_no?: string;
  wcl_item_no?: string;
  cust_part_no?: string;
}

export const adminCustPartRefsRoute = new Hono();

adminCustPartRefsRoute.post("/cust-part-refs", async (c) => {
  const text = await c.req.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  const lines = (body as { lines?: unknown }).lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new HTTPException(400, { message: "invalid_payload: lines must be a non-empty array" });
  }
  if (lines.length > 2000) {
    throw new HTTPException(400, { message: "invalid_payload: lines max 2000 per batch" });
  }
  for (const l of lines) {
    if (
      typeof l !== "object" ||
      l === null ||
      typeof (l as RefLine).orderNo !== "string" ||
      typeof (l as RefLine).wclItemNo !== "string"
    ) {
      throw new HTTPException(400, { message: "invalid_payload: each line must have string orderNo and wclItemNo" });
    }
  }

  // Distinct (orderNo, wclItemNo) pairs — the DocPal API is keyed per pair.
  const pairs = new Map<string, { order_no: string; wcl_item_no: string }>();
  for (const l of lines as RefLine[]) {
    pairs.set(`${l.orderNo}|${l.wclItemNo}`, { order_no: l.orderNo, wcl_item_no: l.wclItemNo });
  }

  const results = new Map<string, RefResult>();
  for (const [key, p] of pairs) {
    const [orderNo, wclItemNo] = key.split("|");
    results.set(key, { orderNo, wclItemNo, custPartNo: null });
  }

  const base = docpalBaseUrl();
  if (base) {
    const started = Date.now();
    try {
      const res = await fetch(`${base}/apis/v1/ms/oracle/order-info/order-item-refs`, {
        method: "POST",
        headers: { accept: "*/*", "Content-Type": "application/json" },
        body: JSON.stringify({ items: [...pairs.values()] }),
        signal: AbortSignal.timeout(docpalFetchTimeoutMs),
      });
      if (!res.ok) {
        console.error(`[docpal] order-item-refs -> ${res.status} in ${Date.now() - started}ms (cust part nos left blank)`);
      } else {
        const data = (await res.json()) as { items?: DocPalRefItem[] };
        for (const item of data.items ?? []) {
          if (!item.order_no || !item.wcl_item_no) continue;
          const key = `${item.order_no}|${item.wcl_item_no}`;
          const hit = results.get(key);
          if (hit && item.cust_part_no) hit.custPartNo = item.cust_part_no;
        }
      }
    } catch (err) {
      console.error(`[docpal] order-item-refs failed after ${Date.now() - started}ms (cust part nos left blank):`, err);
    }
  }

  return c.json({ results: [...results.values()] }, 200);
});
