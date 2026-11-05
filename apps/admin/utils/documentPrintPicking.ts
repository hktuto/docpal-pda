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
}

export interface PickingListGroup {
  partNo: string;
  qty: number;
  allocatedQty: number;
  pickedQty: number;
  allocs: PickingListAlloc[]; // already merged by location/date-code/COO key
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
const widthSum = PICKING_COLUMN_WIDTHS.reduce((s, w) => s + w, 0);

const BLANK_ROW: (string | number)[] = PICKING_COLUMN_HEADERS.map(() => "");

export function pickingListDocToPrintDoc(doc: PickingListDocument): PrintDocument {
  const { head } = doc;

  const rows: (string | number)[][] = [];
  for (const [groupIdx, group] of doc.groups.entries()) {
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
    if (groupIdx < doc.groups.length - 1) rows.push([...BLANK_ROW]); // blank separator between part blocks
  }

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
      columns: PICKING_COLUMN_HEADERS.map((header, i) => ({
        header,
        weight: PICKING_COLUMN_WIDTHS[i] / widthSum,
        align: PICKING_RIGHT_ALIGNED.has(header) ? ("right" as const) : ("left" as const),
      })),
      rows,
      totals: [
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
