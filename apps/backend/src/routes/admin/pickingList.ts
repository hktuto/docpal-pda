import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { inArray, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "../../db.js";
import { queryAll, queryGet } from "../../db/query.js";

// Admin picking-list download (spec
// docs/superpowers/specs/2026-09-14-admin-picking-list-download-design.md;
// mirrors the receiving shipper, 2026-09-14-admin-receiving-shipper-download-design.md):
// a flat one-row-per-allocation xlsx telling the picker, per item, where to
// get the allocated stock (shelf / box / lot) or which receiving order it is
// coming from (dock pick). Read-only — no in-request recompute; the detail
// page has an explicit Reallocate action.

interface OrderHeadRow {
  orderNo: string;
  poNo: string | null;
  customerCode: string | null;
  shipTo: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  status: string;
  allocationStatus: string;
}

interface ItemRow {
  id: string;
  partNo: string;
  qty: number;
  allocatedQty: number;
  pickedQty: number;
}

interface AllocRow {
  pickingItemId: string;
  qty: number;
  lotId: string | null;
  shelfCode: string | null;
  boxId: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  lotOrgId: number | null;
  lotSubInventoryCode: string | null;
  receivingBatchNo: string | null;
}

export const adminPickingListRoute = new Hono();

adminPickingListRoute.get("/picking-orders/:id/picking-list", async (c) => {
  const id = c.req.param("id");

  const head = await queryGet<OrderHeadRow>(
    db,
    sql`
      SELECT
        po.order_no AS "orderNo",
        po.po_no AS "poNo",
        po.customer_code AS "customerCode",
        po.ship_to AS "shipTo",
        po.org_id AS "orgId",
        po.sub_inventory_code AS "subInventoryCode",
        po.status,
        po.allocation_status AS "allocationStatus"
      FROM picking_orders po
      WHERE po.id = ${id}
    `
  );
  if (!head) throw new HTTPException(404, { message: "picking_order_not_found" });

  const items = await queryAll<ItemRow>(
    db,
    sql`
      SELECT
        pi.id, pi.part_no AS "partNo",
        pi.qty, pi.allocated_qty AS "allocatedQty", pi.picked_qty AS "pickedQty"
      FROM picking_items pi
      WHERE pi.picking_order_id = ${id}
      ORDER BY pi.created_date, pi.id
    `
  );
  const itemIds = items.map((i) => i.id);

  const allocations = itemIds.length
    ? await queryAll<AllocRow>(
        db,
        sql`
          SELECT
            a.picking_item_id AS "pickingItemId", a.qty,
            il.id AS "lotId",
            il.shelf_code AS "shelfCode", il.box_id AS "boxId",
            il.date_code AS "dateCode", il.lot_code AS "lotCode",
            il.coo, il.cow,
            il.org_id AS "lotOrgId", il.sub_inventory_code AS "lotSubInventoryCode",
            COALESCE(ro_direct.batch_no, ro_item.batch_no) AS "receivingBatchNo"
          FROM allocations a
          LEFT JOIN inventory_lots il ON il.id = a.inventory_lot_id
          LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
          LEFT JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          LEFT JOIN receiving_orders ro_item ON ro_item.id = ri.receiving_order_id
          LEFT JOIN receiving_orders ro_direct ON ro_direct.id = a.receiving_order_id
          WHERE ${inArray(sql`a.picking_item_id`, itemIds)} AND a.qty > 0
          ORDER BY a.picking_item_id, il.shelf_code NULLS LAST, il.box_id NULLS LAST, a.created_date, a.id
        `
      )
    : [];

  const allocsByItem = new Map<string, AllocRow[]>();
  for (const a of allocations) {
    const list = allocsByItem.get(a.pickingItemId) ?? [];
    list.push(a);
    allocsByItem.set(a.pickingItemId, list);
  }

  const aoa: (string | number)[][] = [];
  aoa.push([`Picking List — ${head.orderNo}`]);
  aoa.push(["Order No", head.orderNo]);
  aoa.push(["PO No", head.poNo ?? ""]);
  aoa.push(["Customer", head.customerCode ?? ""]);
  aoa.push(["Ship To", head.shipTo ?? ""]);
  aoa.push(["Org / Sub-Inventory", [head.orgId ?? "", head.subInventoryCode ?? ""].join(" / ")]);
  aoa.push(["Status", head.status]);
  aoa.push(["Allocation Status", head.allocationStatus]);
  aoa.push(["Generated At", new Date().toISOString()]);
  aoa.push([]);
  aoa.push([
    "Part Number",
    "Item Qty",
    "Allocated Qty",
    "Picked Qty",
    "Source",
    "Location (Shelf)",
    "Box",
    "Date Code",
    "Lot Code",
    "COO / COW",
    "Source Org / Sub-Inv",
    "Alloc Qty",
  ]);

  for (const [itemIdx, item] of items.entries()) {
    const itemBase: (string | number)[] = [item.partNo, item.qty, item.allocatedQty, item.pickedQty];
    const blankBase: (string | number)[] = ["", "", "", ""];
    const allocs = allocsByItem.get(item.id) ?? [];
    if (allocs.length === 0) {
      aoa.push([...itemBase, "(no allocation)", "", "", "", "", "", "", ""]);
      continue;
    }
    let allocSum = 0;
    // Item columns only on the item's first row; continuation rows and the
    // UNALLOCATED footer carry just the allocation info.
    let first = true;
    for (const a of allocs) {
      const base = first ? itemBase : blankBase;
      first = false;
      allocSum += a.qty;
      if (a.lotId) {
        aoa.push([
          ...base,
          "Shelf",
          a.shelfCode ?? "",
          a.boxId ?? "",
          a.dateCode ?? "",
          a.lotCode ?? "",
          [a.coo ?? "", a.cow ?? ""].join(" / "),
          [a.lotOrgId ?? "", a.lotSubInventoryCode ?? ""].join(" / "),
          a.qty,
        ]);
      } else {
        aoa.push([
          ...base,
          `Receiving ${a.receivingBatchNo ?? ""}`.trim(),
          "(dock)",
          "",
          "",
          "",
          "",
          "",
          a.qty,
        ]);
      }
    }
    if (item.qty > allocSum) {
      aoa.push([...blankBase, "UNALLOCATED", "", "", "", "", "", "", item.qty - allocSum]);
    }
    if (itemIdx < items.length - 1) aoa.push([]); // blank separator between item blocks
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (const addr of Object.keys(ws)) {
    if (addr.startsWith("!")) continue;
    const cell = ws[addr];
    if (cell.t === "n") cell.z = "#,##0";
  }
  ws["!cols"] = [
    { wch: 26 }, // Part Number
    { wch: 10 }, // Item Qty
    { wch: 12 }, // Allocated Qty
    { wch: 10 }, // Picked Qty
    { wch: 18 }, // Source
    { wch: 16 }, // Location (Shelf)
    { wch: 12 }, // Box
    { wch: 12 }, // Date Code
    { wch: 12 }, // Lot Code
    { wch: 12 }, // COO / COW
    { wch: 18 }, // Source Org / Sub-Inv
    { wch: 10 }, // Alloc Qty
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Picking List");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const fileName = `picking-list-${head.orderNo}.xlsx`;
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Content-Length": String(buf.length),
    },
  });
});
