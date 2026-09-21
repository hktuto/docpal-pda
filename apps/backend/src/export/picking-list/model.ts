// Picking-list document model (spec
// docs/superpowers/specs/2026-09-21-admin-excel-export-renderer-separation-design.md):
// the semantic structure of the picking list — what it says, not where it
// lands. The unallocated shortfall (qty − Σ allocs.qty) is NOT pre-baked
// into the model — the renderer derives it.

export interface PickingListDocument {
  head: {
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
