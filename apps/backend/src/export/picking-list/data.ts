// Picking-list data assembly (spec
// docs/superpowers/specs/2026-09-21-admin-excel-export-renderer-separation-design.md):
// queries + grouping/merging moved verbatim from
// src/routes/admin/pickingList.ts. Behavior spec:
// docs/superpowers/specs/2026-09-14-admin-picking-list-download-design.md
// (mirrors the receiving shipper, 2026-09-14-admin-receiving-shipper-download-design.md).
// Read-only — no in-request recompute; the detail page has an explicit
// Reallocate action.

import { HTTPException } from "hono/http-exception";
import { inArray, sql } from "drizzle-orm";
import type { AppDb } from "../../db.js";
import { queryAll, queryGet } from "../../db/query.js";
import type { PickingListAlloc, PickingListDocument } from "./model.js";

interface OrderHeadRow {
  orderNo: string;
  poNo: string | null;
  customerCode: string | null;
  shipTo: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  status: string;
  allocationStatus: string;
  remark: string | null;
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

export async function loadPickingListDocument(db: AppDb, id: string): Promise<PickingListDocument> {
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
        po.allocation_status AS "allocationStatus",
        po.remark
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

  // Merge items sharing a part number into one block (first-seen order):
  // summed qty columns, allocation rows from all lines concatenated.
  const groups: { partNo: string; qty: number; allocatedQty: number; pickedQty: number; itemIds: string[] }[] = [];
  const groupByPart = new Map<string, (typeof groups)[number]>();
  for (const item of items) {
    let g = groupByPart.get(item.partNo);
    if (!g) {
      g = { partNo: item.partNo, qty: 0, allocatedQty: 0, pickedQty: 0, itemIds: [] };
      groupByPart.set(item.partNo, g);
      groups.push(g);
    }
    g.qty += item.qty;
    g.allocatedQty += item.allocatedQty;
    g.pickedQty += item.pickedQty;
    g.itemIds.push(item.id);
  }

  // Within a part block, allocations from the same location + date code +
  // COO merge into one row with a summed qty (same rule as the admin
  // grouped items view): lot sources keyed by shelf+box/dateCode/coo,
  // receiving sources by receiving order + carton + date code.
  function allocKey(a: AllocRow): string {
    if (a.lotId) {
      return ["lot", a.shelfCode ?? "", a.boxId ?? "", a.dateCode ?? "", a.coo ?? ""].join("|");
    }
    return ["rec", a.receivingBatchNo ?? "", a.boxId ?? "", a.dateCode ?? ""].join("|");
  }
  function mergeAllocs(list: AllocRow[]): AllocRow[] {
    const merged = new Map<string, AllocRow>();
    for (const a of list) {
      const key = allocKey(a);
      const existing = merged.get(key);
      if (existing) existing.qty += a.qty;
      else merged.set(key, { ...a });
    }
    return [...merged.values()];
  }

  return {
    head: { ...head },
    generatedAt: new Date().toISOString(),
    groups: groups.map((group) => ({
      partNo: group.partNo,
      qty: group.qty,
      allocatedQty: group.allocatedQty,
      pickedQty: group.pickedQty,
      allocs: mergeAllocs(group.itemIds.flatMap((itemId) => allocsByItem.get(itemId) ?? [])).map(
        (a): PickingListAlloc =>
          a.lotId
            ? {
                kind: "lot",
                shelfCode: a.shelfCode,
                boxId: a.boxId,
                dateCode: a.dateCode,
                lotCode: a.lotCode,
                coo: a.coo,
                cow: a.cow,
                orgId: a.lotOrgId,
                subInventoryCode: a.lotSubInventoryCode,
                qty: a.qty,
              }
            : { kind: "receiving", receivingBatchNo: a.receivingBatchNo, qty: a.qty }
      ),
    })),
  };
}
