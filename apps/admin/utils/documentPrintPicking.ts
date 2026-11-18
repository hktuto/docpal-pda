/**
 * PickingListDocument (backend picking-list document model) → PrintDocument.
 *
 * The document JSON comes from GET /admin/picking-orders/:id/picking-list-document
 * (see utils/flowApi.ts getPickingListDocument); the model mirrors
 * apps/backend/src/export/picking-list/model.ts, declared locally in the
 * same style as the other flowApi DTOs. The row semantics mirror the xlsx
 * renderer (apps/backend/src/export/picking-list/render/default.ts):
 *   - 12 columns: Part Number | Item Qty | Allocated Qty | Picked Qty |
 *     Source | Location (Shelf) | Box | Date Code | Lot Code | COO / COW |
 *     Source Org / Sub-Inv | Alloc Qty;
 *   - a group's first row carries the 4 item columns, continuations blank;
 *   - lot alloc → Source "Shelf", coo/cow and orgId/subInventory joined " / ";
 *   - receiving alloc → Source "Receiving {batchNo}", Location "(dock)";
 *   - UNALLOCATED footer row when group.qty > Σ alloc.qty (shortfall in the
 *     last column); "(no allocation)" single row when a group has no allocs;
 *   - a thin blank separator row between groups.
 *
 * Warehouse variants: the document JSON carries the instance's warehouse
 * (WAREHOUSE_CODE; attached by the backend route). "sz" renders the SZ
 * layout instead — one product row per picking item line (lines NOT merged
 * by part_no), columns Part No | WCL Item No | Order No | Line No | …
 * mirroring apps/backend/src/export/picking-list/render/sz.ts, and no
 * totals row. Anything else keeps the default merged layout above.
 */
import type { PrintDocument } from "~/utils/documentPrint";

// ---- backend model mirror (apps/backend/src/export/picking-list/model.ts) ----

export interface PickingListDocument {
  head: {
    orderId: string; // picking_orders.id — QR order-link payload
    orderNo: string;
    poNo: string | null;
    customerCode: string | null;
    shipTo: string | null;
    orgId: number | null;
    subInventoryCode: string | null;
    status: string;
    allocationStatus: string;
    remark: string | null;
  };
  generatedAt: string; // ISO timestamp, set by data assembly
  groups: PickingListGroup[]; // items already merged by part_no, first-seen order
  // Instance warehouse (WAREHOUSE_CODE env, attached by the route — NOT part
  // of the semantic document). Client-side renderers (the admin PNG print)
  // branch on it to mirror the warehouse-scoped xlsx layout ("sz" = per-line
  // SZ layout); absent/"hk" keeps the merged default layout.
  warehouse?: string;
}

export interface PickingListGroup {
  partNo: string; // the WCL item no (picking_items.part_no)
  mfrPartNo: string | null; // parts master part_no (real manufacturer part no)
  qty: number;
  allocatedQty: number;
  pickedQty: number;
  allocs: PickingListAlloc[]; // already merged by location/date-code/COO key
  lines: PickingListLine[]; // unmerged per picking-item rows (SZ layout)
}

export interface PickingListLine {
  orderNo: string | null; // upstream customer order no (additional_data passthrough)
  lineNumber: number | null; // upstream Oracle line number
  mfrPartNo: string | null;
  // Customer refs from the DocPal oracle order-item-refs API (SZ only; null
  // when the line has no order_no or the API was unreachable).
  custPoNo: string | null;
  custPartNo: string | null;
  qty: number;
  allocatedQty: number;
  pickedQty: number;
  allocs: PickingListAlloc[]; // this line's allocations, merged by location key
}

export type PickingListAlloc =
  | {
      kind: "lot";
      shelfCode: string | null;
      boxId: string | null;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
      orgId: number | null;
      subInventoryCode: string | null;
      qty: number;
    }
  | { kind: "receiving"; receivingBatchNo: string | null; qty: number };

// ---- renderer column mirror (render/default.ts colWidths, normalized) ----

const PICKING_COLUMN_WIDTHS = [26, 10, 12, 10, 18, 16, 12, 12, 12, 12, 18, 10];
const PICKING_COLUMN_HEADERS = [
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
];
const PICKING_RIGHT_ALIGNED = new Set(["Item Qty", "Allocated Qty", "Picked Qty", "Alloc Qty"]);

const BLANK_ROW: (string | number)[] = PICKING_COLUMN_HEADERS.map(() => "");

// SZ layout (apps/backend/src/export/picking-list/render/sz.ts): one product
// row per picking item — same-part lines are NOT merged — each carrying
// Part No / WCL Item No / Order No / Line No.
const SZ_COLUMN_WIDTHS = [20, 26, 18, 8, 16, 18, 10, 12, 10, 18, 16, 12, 12, 12, 12, 18, 10];
const SZ_COLUMN_HEADERS = [
  "Part No",
  "WCL Item No",
  "Order No",
  "Line No",
  "Cust PO No",
  "Cust Part No",
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
];

function buildDefaultRows(groups: PickingListGroup[]): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const [groupIdx, group] of groups.entries()) {
    const groupBase: (string | number)[] = [group.partNo, group.qty, group.allocatedQty, group.pickedQty];
    const blankBase: (string | number)[] = ["", "", "", ""];
    if (group.allocs.length > 0) {
      let allocSum = 0;
      let first = true;
      for (const a of group.allocs) {
        const base = first ? groupBase : blankBase;
        first = false;
        allocSum += a.qty;
        if (a.kind === "lot") {
          rows.push([
            ...base,
            "Shelf",
            a.shelfCode ?? "",
            a.boxId ?? "",
            a.dateCode ?? "",
            a.lotCode ?? "",
            [a.coo ?? "", a.cow ?? ""].join(" / "),
            [a.orgId ?? "", a.subInventoryCode ?? ""].join(" / "),
            a.qty,
          ]);
        } else {
          rows.push([...base, `Receiving ${a.receivingBatchNo ?? ""}`.trim(), "(dock)", "", "", "", "", "", a.qty]);
        }
      }
      if (group.qty > allocSum) {
        rows.push([...blankBase, "UNALLOCATED", "", "", "", "", "", "", group.qty - allocSum]);
      }
    } else {
      rows.push([...groupBase, "(no allocation)", "", "", "", "", "", "", ""]);
    }
    if (groupIdx < groups.length - 1) rows.push([...BLANK_ROW]); // blank separator between part blocks
  }
  return rows;
}

function buildSzRows(groups: PickingListGroup[]): (string | number)[][] {
  const rows: (string | number)[][] = [];
  const blankBase: (string | number)[] = ["", "", "", "", "", "", "", "", ""];
  for (const [groupIdx, group] of groups.entries()) {
    for (const line of group.lines) {
      const lineBase: (string | number)[] = [
        line.mfrPartNo ?? "",
        group.partNo,
        line.orderNo ?? "",
        line.lineNumber ?? "",
        line.custPoNo ?? "",
        line.custPartNo ?? "",
        line.qty,
        line.allocatedQty,
        line.pickedQty,
      ];
      if (line.allocs.length === 0) {
        rows.push([...lineBase, "(no allocation)", "", "", "", "", "", "", ""]);
        continue;
      }
      let allocSum = 0;
      let first = true;
      for (const a of line.allocs) {
        const base = first ? lineBase : blankBase;
        first = false;
        allocSum += a.qty;
        if (a.kind === "lot") {
          rows.push([
            ...base,
            "Shelf",
            a.shelfCode ?? "",
            a.boxId ?? "",
            a.dateCode ?? "",
            a.lotCode ?? "",
            [a.coo ?? "", a.cow ?? ""].join(" / "),
            [a.orgId ?? "", a.subInventoryCode ?? ""].join(" / "),
            a.qty,
          ]);
        } else {
          rows.push([...base, `Receiving ${a.receivingBatchNo ?? ""}`.trim(), "(dock)", "", "", "", "", "", a.qty]);
        }
      }
      if (line.qty > allocSum) {
        rows.push([...blankBase, "UNALLOCATED", "", "", "", "", "", "", line.qty - allocSum]);
      }
    }
    if (groupIdx < groups.length - 1) {
      rows.push(SZ_COLUMN_HEADERS.map(() => "")); // blank separator between part blocks
    }
  }
  return rows;
}

export function pickingListDocToPrintDoc(doc: PickingListDocument): PrintDocument {
  const { head } = doc;
  const isSz = doc.warehouse === "sz";
  const colHeaders = isSz ? SZ_COLUMN_HEADERS : PICKING_COLUMN_HEADERS;
  const colWidths = isSz ? SZ_COLUMN_WIDTHS : PICKING_COLUMN_WIDTHS;
  const colWidthSum = colWidths.reduce((s, w) => s + w, 0);
  const rows = isSz ? buildSzRows(doc.groups) : buildDefaultRows(doc.groups);

  return {
    title: `Picking List — ${head.orderNo}`,
    ref: head.orderNo,
    head: [
      ["Order No", head.orderNo],
      ["PO No", head.poNo ?? ""],
      ["Customer", head.customerCode ?? ""],
      ["Ship To", head.shipTo ?? ""],
      ["Org / Sub-Inventory", [head.orgId ?? "", head.subInventoryCode ?? ""].join(" / ")],
      ["Status", head.status],
      ["Allocation Status", head.allocationStatus],
      ["Remark", head.remark ?? ""],
      ["Generated At", doc.generatedAt],
    ],
    table: {
      columns: colHeaders.map((header, i) => ({
        header,
        weight: colWidths[i]! / colWidthSum,
        align: PICKING_RIGHT_ALIGNED.has(header) ? ("right" as const) : ("left" as const),
      })),
      rows,
      // The SZ xlsx has no totals row — the print mirrors it.
      totals: isSz ? [] : [
        "Total",
        doc.groups.reduce((s, g) => s + g.qty, 0),
        doc.groups.reduce((s, g) => s + g.allocatedQty, 0),
        doc.groups.reduce((s, g) => s + g.pickedQty, 0),
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ],
    },
    foot: [],
    qr: { payload: `warehouse://picking/${head.orderId}` },
    orientation: "landscape",
  };
}
