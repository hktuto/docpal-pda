// Shipper document model (spec
// docs/superpowers/specs/2026-09-21-admin-excel-export-renderer-separation-design.md):
// the semantic structure of the shipper document — what it says, not where
// it lands. Data assembly (data.ts) builds this; renderers (render/*.ts)
// decide row geometry.

export interface ShipperDocument {
  mode: "live" | "finished";
  head: {
    batchNo: string;
    supplierCode: string | null;
    supplierName: string | null;
    deliveryDate: string; // yyyy-mm-dd or ""
    totalCtn: number | null;
  };
  slotCount: number; // widest group's slot count (0 = no allocations)
  groups: ShipperGroup[];
}

export interface ShipperGroup {
  partKey: string; // COALESCE(wcl_item_no, part_no)
  // one per carton; raw components, the renderer picks/joins the first cell
  blockItems: { invoiceNo: string | null; drawingNo: string | null; ctnNo: string | null; qty: number }[];
  slots: ShipperSlot[]; // live: merged per-item slots; finished: package slots
  relatedAllocated: number; // live mode only (0 in finished)
  totalQty: number;
  allocatedTotal: number;
  orderLevel: {
    // present only when whole-order allocations exist (live)
    slots: ShipperSlot[];
  } | null;
}

export interface ShipperSlot {
  customer: string; // label ?? code ?? order_no
  orderRef: string; // order_no || po_no
  qty: number;
  prioritySeq: number;
  orderNo: string;
}
