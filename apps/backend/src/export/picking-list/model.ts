// Picking-list document model (spec
// docs/superpowers/specs/2026-09-21-admin-excel-export-renderer-separation-design.md):
// the semantic structure of the picking list — what it says, not where it
// lands. The unallocated shortfall (qty − Σ allocs.qty) is NOT pre-baked
// into the model — the renderer derives it.

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
  // picking_items.part_no — the WCL item no (business key), NOT the
  // manufacturer's part no; mfrPartNo carries that.
  partNo: string;
  mfrPartNo: string | null; // parts master part_no (real manufacturer part no)
  qty: number;
  allocatedQty: number;
  pickedQty: number;
  allocs: PickingListAlloc[]; // already merged by location/date-code/COO key
  // Unmerged per picking-item rows (orderNo from additional_data->>'order_no',
  // lineNumber from picking_items.line_number). The default (HK) layout merges
  // same-part lines into one block and ignores this; warehouse variants that
  // print one product row per order line (e.g. SZ) use it.
  lines: PickingListLine[];
}

export interface PickingListLine {
  orderNo: string | null; // upstream customer order no (additional_data passthrough)
  lineNumber: number | null; // upstream Oracle line number
  mfrPartNo: string | null; // same parts-master lookup as the group's
  // Customer refs from the DocPal oracle order-item-refs API — SZ layout
  // only, filled by route-level enrichment after data assembly; null when
  // the line has no order_no or the API was unreachable.
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
