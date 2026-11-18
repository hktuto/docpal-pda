// Customer refs enrichment for the SZ picking-list layout: cust_po_no +
// cust_part_no per picking line, keyed by (order_no, wcl_item_no) from the
// DocPal oracle order-item-refs API. Called by the picking-list routes AFTER
// data assembly, only on the SZ instance — the HK layout doesn't print these.
//
// Fail-soft by design: the picking list is an operational document, so a
// DocPal outage must not break the download — on any error the fields stay
// null and the sheet prints with blank customer-ref columns (the failure is
// logged for follow-up).

import { docpalBaseUrl, docpalFetchTimeoutMs } from "../../config.js";
import type { PickingListDocument } from "./model.js";

interface RefItem {
  order_no?: string;
  wcl_item_no?: string;
  cust_po_no?: string;
  cust_part_no?: string;
}

export async function enrichCustRefs(doc: PickingListDocument): Promise<void> {
  const base = docpalBaseUrl();
  if (!base) return;

  // Distinct (order_no, wcl_item_no) pairs — lines without an order_no have
  // nothing to look up. The wcl_item_no is the group's partNo (picking_items
  // stores the business key, not the manufacturer part no).
  const keys = new Map<string, { order_no: string; wcl_item_no: string }>();
  for (const g of doc.groups) {
    for (const l of g.lines) {
      if (!l.orderNo) continue;
      keys.set(`${l.orderNo}${g.partNo}`, { order_no: l.orderNo, wcl_item_no: g.partNo });
    }
  }
  if (keys.size === 0) return;

  const started = Date.now();
  try {
    const res = await fetch(`${base}/apis/v1/ms/oracle/order-info/order-item-refs`, {
      method: "POST",
      headers: { accept: "*/*", "Content-Type": "application/json" },
      body: JSON.stringify({ items: [...keys.values()] }),
      signal: AbortSignal.timeout(docpalFetchTimeoutMs),
    });
    if (!res.ok) {
      console.error(`[docpal] order-item-refs -> ${res.status} in ${Date.now() - started}ms (cust refs left blank)`);
      return;
    }
    const data = (await res.json()) as { items?: RefItem[] };
    const byKey = new Map(
      (data.items ?? [])
        .filter((i) => i.order_no && i.wcl_item_no)
        .map((i) => [`${i.order_no}${i.wcl_item_no}`, i])
    );
    for (const g of doc.groups) {
      for (const l of g.lines) {
        if (!l.orderNo) continue;
        const hit = byKey.get(`${l.orderNo}${g.partNo}`);
        l.custPoNo = hit?.cust_po_no ?? null;
        l.custPartNo = hit?.cust_part_no ?? null;
      }
    }
  } catch (err) {
    console.error(`[docpal] order-item-refs failed after ${Date.now() - started}ms (cust refs left blank):`, err);
  }
}
