import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "../../db.js";
import { queryAll, queryGet } from "../../db/query.js";
import { computeItemShelfSuggestions } from "../../db/putaway.js";
import { putAwayConfig } from "../../config.js";

// Admin picking-list download (spec
// docs/superpowers/specs/2026-09-07-admin-receiving-picking-list-design.md):
// a shipper-style xlsx per receiving order — receipts grouped by part, each
// receipt a 3-row block (customer names / recommended shelf + order numbers /
// the item row as `invoice_no ctn_no` with per-slot allocated qtys).

interface OrderHeadRow {
  batchNo: string;
  deliveryDate: Date | null;
  supplierName: string | null;
  totalCtn: number | null;
}

interface ItemRow {
  id: string;
  invoiceNo: string;
  poNo: string | null;
  poLine: string | null;
  partKey: string;
  partNo: string;
  wclItemNo: string | null;
  ctnNo: string | null;
  receivedQty: number;
  orgId: number | null;
  subInventoryCode: string | null;
}

interface AllocRow {
  itemId: string | null;
  demandPartNo: string | null;
  orderId: string;
  orderNo: string;
  poNo: string | null;
  prioritySeq: number;
  customerCode: string | null;
  customerLabel: string | null;
  qty: number;
}


function ymd(d: Date | null): string {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

export const adminReceivingPickingListRoute = new Hono();

adminReceivingPickingListRoute.get("/receiving-orders/:id/picking-list", async (c) => {
  const id = c.req.param("id");

  const head = await queryGet<OrderHeadRow>(
    db,
    sql`
      SELECT
        ro.batch_no AS "batchNo",
        ro.delivery_date AS "deliveryDate",
        s.name AS "supplierName",
        (SELECT SUM(ri.total_ctn)::int FROM receiving_invoices ri WHERE ri.receiving_order_id = ro.id) AS "totalCtn"
      FROM receiving_orders ro
      LEFT JOIN suppliers s ON s.code = ro.supplier_code
      WHERE ro.id = ${id}
    `
  );
  if (!head) throw new HTTPException(404, { message: "receiving_order_not_found" });

  const items = await queryAll<ItemRow>(
    db,
    sql`
      SELECT
        rii.id,
        ri.invoice_no AS "invoiceNo",
        rii.po_no AS "poNo",
        rii.po_line AS "poLine",
        COALESCE(rii.wcl_item_no, rii.part_no) AS "partKey",
        rii.part_no AS "partNo",
        rii.wcl_item_no AS "wclItemNo",
        rii.ctn_no AS "ctnNo",
        rii.received_qty AS "receivedQty",
        rii.org_id AS "orgId",
        rii.sub_inventory_code AS "subInventoryCode"
      FROM receiving_invoice_items rii
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      WHERE ri.receiving_order_id = ${id}
      ORDER BY COALESCE(rii.wcl_item_no, rii.part_no), rii.po_no, rii.po_line, rii.ctn_no, rii.id
    `
  );

  // Item-level allocations (receiving line carries ctn_no → boxed source).
  const itemAllocs = await queryAll<AllocRow>(
    db,
    sql`
      SELECT
        a.receiving_invoice_item_id AS "itemId",
        NULL AS "demandPartNo",
        po.id AS "orderId", po.order_no AS "orderNo", po.po_no AS "poNo",
        po.priority_seq AS "prioritySeq",
        po.customer_code AS "customerCode", cp.label AS "customerLabel",
        SUM(a.qty)::int AS qty
      FROM allocations a
      JOIN picking_items pi ON pi.id = a.picking_item_id
      JOIN picking_orders po ON po.id = pi.picking_order_id
      LEFT JOIN customer_profiles cp ON cp.code = po.customer_code
      JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      WHERE ri.receiving_order_id = ${id}
      GROUP BY a.receiving_invoice_item_id, po.id, po.order_no, po.po_no, po.priority_seq, po.customer_code, cp.label
    `
  );

  // Order-level allocations (receiving line without ctn_no → whole-order
  // source, allocate.ts:53-55). Matched back to a part group in JS via the
  // allocate.ts part-key rule (demand part_no = source part_no OR wcl_item_no).
  const orderAllocs = await queryAll<AllocRow>(
    db,
    sql`
      SELECT
        NULL AS "itemId",
        pi.part_no AS "demandPartNo",
        po.id AS "orderId", po.order_no AS "orderNo", po.po_no AS "poNo",
        po.priority_seq AS "prioritySeq",
        po.customer_code AS "customerCode", cp.label AS "customerLabel",
        SUM(a.qty)::int AS qty
      FROM allocations a
      JOIN picking_items pi ON pi.id = a.picking_item_id
      JOIN picking_orders po ON po.id = pi.picking_order_id
      LEFT JOIN customer_profiles cp ON cp.code = po.customer_code
      WHERE a.receiving_order_id = ${id} AND a.receiving_invoice_item_id IS NULL
      GROUP BY pi.part_no, po.id, po.order_no, po.po_no, po.priority_seq, po.customer_code, cp.label
    `
  );

  // Shipper 3-row block layout: allocation columns are PER-ROW slots, not a
  // global column per picking order (each receipt's order set differs, so
  // global columns would sprawl). Every receipt prints as:
  //   row 1: customer name per slot
  //   row 2: recommended shelf above the part name + order_no per slot
  //   row 3: `invoice_no ctn_no` | part | qty | per-slot allocated qty
  // Slot count = the widest row's allocation count.
  interface SlotAlloc {
    customer: string; // customer name (fallback code / order_no)
    orderRef: string; // order_no (fallback po_no)
    qty: number;
    prioritySeq: number;
    orderNo: string;
  }

  function toSlot(a: AllocRow): SlotAlloc {
    return {
      customer: a.customerLabel ?? a.customerCode ?? a.orderNo,
      orderRef: a.orderNo || (a.poNo ?? ""),
      qty: a.qty,
      prioritySeq: a.prioritySeq,
      orderNo: a.orderNo,
    };
  }

  const bySlotOrder = (x: SlotAlloc, y: SlotAlloc) =>
    x.prioritySeq - y.prioritySeq || x.orderNo.localeCompare(y.orderNo);

  const allocsByItem = new Map<string, SlotAlloc[]>();
  for (const a of itemAllocs) {
    const list = allocsByItem.get(a.itemId!) ?? [];
    list.push(toSlot(a));
    allocsByItem.set(a.itemId!, list);
  }
  for (const list of allocsByItem.values()) list.sort(bySlotOrder);

  // Group items by part, preserving the query's ordering.
  const groups: { partKey: string; items: ItemRow[]; orderAllocs: SlotAlloc[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.partKey === item.partKey) last.items.push(item);
    else groups.push({ partKey: item.partKey, items: [item], orderAllocs: [] });
  }
  // Whole-order (no ctn_no) allocations attach to their part group via the
  // allocate.ts part-key rule (demand part_no = source part_no OR wcl_item_no).
  for (const group of groups) {
    const byOrder = new Map<string, SlotAlloc>();
    for (const a of orderAllocs) {
      if (!group.items.some((i) => i.partNo === a.demandPartNo || i.wclItemNo === a.demandPartNo)) continue;
      const slot = byOrder.get(a.orderId);
      if (slot) slot.qty += a.qty;
      else byOrder.set(a.orderId, toSlot(a));
    }
    group.orderAllocs = [...byOrder.values()].sort(bySlotOrder);
  }

  // Recommended put-away shelf per part (same ranking as the put-away task
  // detail; off when flow config putAway.suggestShelf="off").
  const suggestions =
    putAwayConfig().suggestShelf !== "off"
      ? await computeItemShelfSuggestions(
          db,
          items.map((i) => ({
            partNo: i.partNo,
            itemOrgId: i.orgId,
            itemSubInventoryCode: i.subInventoryCode,
          }))
        )
      : new Map<string, { shelfCode: string | null }>();

  let slotCount = 0;
  for (const group of groups) {
    slotCount = Math.max(slotCount, group.orderAllocs.length);
    for (const item of group.items) slotCount = Math.max(slotCount, allocsByItem.get(item.id)?.length ?? 0);
  }

  const aoa: (string | number)[][] = [];
  aoa.push([`Picking List — ${head.batchNo}${head.supplierName ? ` (${head.supplierName})` : ""}`]);
  aoa.push([`Date: ${ymd(head.deliveryDate)}`]);
  aoa.push([`Total Ctn: ${head.totalCtn ?? ""}`]);
  aoa.push([]);
  aoa.push(["Invoice / Ctn", "Part Number", "Qty", "Total Qty", ...Array(slotCount).fill("Customer"), "Balance"]);
  aoa.push(["", "Shelf", "", "", ...Array(slotCount).fill("Order No"), ""]);

  // A 3-row block: customer names / shelf + order refs / the receipt itself.
  // `totalBalance` (totalQty, balance) lands on the block's item row when
  // `last` — i.e. the closing row of the part group.
  function pushBlock(
    partKey: string,
    invoiceCtn: string,
    shelf: string,
    qty: number | "",
    allocs: SlotAlloc[],
    totalBalance: [number, number] | null
  ) {
    const pad = <T>(fn: (a: SlotAlloc) => T | ""): (T | "")[] =>
      Array.from({ length: slotCount }, (_, i) => (allocs[i] ? fn(allocs[i]) : ""));
    aoa.push(["", "", "", "", ...pad((a) => a.customer), ""]);
    aoa.push(["", shelf, "", "", ...pad((a) => a.orderRef), ""]);
    aoa.push([
      invoiceCtn,
      partKey,
      qty,
      totalBalance ? totalBalance[0] : "",
      ...pad((a) => a.qty),
      totalBalance ? totalBalance[1] : "",
    ]);
  }

  groups.forEach((group, gi) => {
    const totalQty = group.items.reduce((s, i) => s + i.receivedQty, 0);
    const allocatedTotal =
      group.items.reduce(
        (s, i) => s + (allocsByItem.get(i.id) ?? []).reduce((t, a) => t + a.qty, 0),
        0
      ) + group.orderAllocs.reduce((s, a) => s + a.qty, 0);

    // Whole-order allocations cover no-ctn items of the group in row order
    // (they aren't pinned to a line) — used only to decide whether a receipt
    // is fully allocated (fully allocated → no shelf suggestion needed).
    let orderLevelRemaining = group.orderAllocs.reduce((s, a) => s + a.qty, 0);

    group.items.forEach((item, idx) => {
      const itemAllocsList = allocsByItem.get(item.id) ?? [];
      let covered = itemAllocsList.reduce((s, a) => s + a.qty, 0);
      if (!item.ctnNo && orderLevelRemaining > 0) {
        const extra = Math.min(orderLevelRemaining, Math.max(0, item.receivedQty - covered));
        covered += extra;
        orderLevelRemaining -= extra;
      }
      const shelf = covered >= item.receivedQty ? "" : (suggestions.get(item.partNo)?.shelfCode ?? "");
      const last = idx === group.items.length - 1 && group.orderAllocs.length === 0;
      pushBlock(
        item.partKey,
        [item.invoiceNo, item.ctnNo].filter(Boolean).join(" "),
        shelf,
        item.receivedQty,
        itemAllocsList,
        last ? [totalQty, totalQty - allocatedTotal] : null
      );
    });

    // Whole-order (no ctn_no) allocations can't be pinned to a carton row —
    // they close the group as their own block so the Balance still adds up.
    if (group.orderAllocs.length > 0) {
      pushBlock(group.partKey, "(order-level)", "", "", group.orderAllocs, [
        totalQty,
        totalQty - allocatedTotal,
      ]);
    }

    if (gi < groups.length - 1) aoa.push([]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 20 }, // Invoice / Ctn
    { wch: 26 }, // Part Number
    { wch: 10 }, // Qty
    { wch: 10 }, // Total Qty
    ...Array.from({ length: slotCount }, () => ({ wch: 18 })), // Customer / Order No slots
    { wch: 10 }, // Balance
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Picking List");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const fileName = `picking-list-${head.batchNo}.xlsx`;
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Content-Length": String(buf.length),
    },
  });
});
