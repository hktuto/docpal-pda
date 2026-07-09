// ------------------------------------------------------------------
// Shared service-layer DTOs. No Drizzle imports here.
// ------------------------------------------------------------------

export type UserRole = "operator" | "admin";

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  createdAt: Date;
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  qrcodeTemplate: string | null;
  qrcodeQtyEncoding: string | null;
}

export interface SupplierQrcodeTemplate {
  code: string;
  qrcodeTemplate: string;
  qrcodeQtyEncoding: string | null;
}

export interface Part {
  id: string;
  partNo: string;
  internalCode: string | null;
  description: string | null;
  defaultCoo: string | null;
}

// ------------------------------------------------------------------
// Receiving
// ------------------------------------------------------------------

export type ReceivingOrderStatus = "pending" | "in_hand" | "clear";

export type ReceivingFilter = "all" | "pending" | "in_hand" | "clear";

export interface ReceivingOrderSummary {
  id: string;
  refNo: string;
  status: ReceivingOrderStatus;
  deliveryDate: string | null;
  supplierName: string | null;
  remainingItems: number;
  pendingPickingOrders: number;
}

export interface ReceivingItemWithMismatch extends ReceivingItem {
  mismatch: ReceivingItemMismatch | null;
}

export interface ReceivingOrderDetail {
  id: string;
  refNo: string;
  status: ReceivingOrderStatus;
  deliveryDate: Date | null;
  supplier: Supplier | null;
  invoices: Array<Omit<ReceivingInvoice, "items"> & { items: ReceivingItemWithMismatch[] }>;
  remainingItems: number;
  allocatedByItem: Record<string, number>;
  pickingRows: PickingByReceivingRow[];
  packagesByItem: Record<string, DisplayPackage[]>;
  boxesByOrder: Record<string, DisplayBox[]>;
  transitionLogs: Record<string, TransitionLog[]>;
}

export interface ReceivingInvoice {
  id: string;
  receivingOrderId: string;
  invoiceNo: string;
  supplierId: string | null;
  items: ReceivingItem[];
}

export interface ReceivingItem {
  id: string;
  receivingInvoiceId: string;
  partId: string;
  poNo: string | null;
  poLine: string | null;
  qty: number;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  boxId: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  part: Part | null;
}

// ------------------------------------------------------------------
// Mismatches
// ------------------------------------------------------------------

export const mismatchReasons = [
  "not_found",
  "damaged",
  "qty_mismatch",
  "wrong_part",
  "over_shipment",
  "quality_rejection",
] as const;

export type MismatchReason = (typeof mismatchReasons)[number];

export type MismatchStatus = "pending" | "confirmed" | "cancelled";

export interface ReceivingItemMismatch {
  id: string;
  receivingInvoiceItemId: string;
  reason: MismatchReason;
  mismatchQty: number | null;
  wrongPartNo: string | null;
  note: string | null;
  status: MismatchStatus;
  effectiveReceivedQty: number;
  previousReceivedQty: number;
  reportedBy: string | null;
  reportedAt: Date;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  cancelledBy: string | null;
  cancelledAt: Date | null;
}

export interface ReportMismatchInput {
  reason: MismatchReason;
  mismatchQty?: number | null;
  wrongPartNo?: string | null;
  note?: string;
}

// ------------------------------------------------------------------
// Picking (receiving detail only)
// ------------------------------------------------------------------

export interface PickingByReceivingRow {
  picking_order_id: string;
  picking_order_ref: string;
  picking_order_status: string;
  picking_order_ship_to: string | null;
  picking_item_id: string;
  required_qty: number;
  picked_qty: number;
  scanned_qty: number;
  boxed_qty: number;
  part_id: string;
  part_no: string;
  shelf_code: string | null;
  box_id: string | null;
  date_code: string | null;
  lot_code: string | null;
  coo: string | null;
  cow: string | null;
  allocated_qty: number;
  allocation_id: string;
}

export interface DisplayPackage {
  id: string;
  pickingItemId: string;
  pickingOrderId: string;
  qty: number;
  shippingBoxId: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  createdAt: Date | string;
}

export interface DisplayBox {
  id: string;
  pickingOrderId: string;
  status: string;
}

export interface TransitionLog {
  id: string;
  entityId: string;
  fromState: string | null;
  toState: string;
  metadata: string | null;
  createdAt: Date | string;
  actorName: string | null;
}

export interface GroupedItem {
  id: string;
  part_id: string;
  part_no: string | null;
  required_qty: number;
  picked_qty: number;
  scanned_qty: number;
  boxed_qty: number;
  locations: Array<{
    shelf_code: string | null;
    box_id: string | null;
    date_code: string | null;
    lot_code: string | null;
    coo: string | null;
    cow: string | null;
    allocated_qty: number;
  }>;
}

export interface GroupedOrder {
  id: string;
  ref_no: string;
  status: string;
  items: GroupedItem[];
}

// ------------------------------------------------------------------
// OCR scan matching
// ------------------------------------------------------------------

export interface OcrParsedFields {
  partNo: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  qty: number;
}

export interface ReceivingCandidate {
  receivingInvoiceItemId: string;
  partId: string;
  partNo: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  availableQty: number;
}

export interface PickingCandidate {
  pickingOrderId: string;
  pickingOrderRefNo: string;
  pickingItemId: string;
  partId: string;
  shipTo: string | null;
  requiredQty: number;
  pickedQty: number;
  remainingQty: number;
}

// ------------------------------------------------------------------
// Picking
// ------------------------------------------------------------------

export type PickingOrderStatus = "pending" | "picking" | "finished" | "issue";

export const pickingIssueReasons = [
  "insufficient_stock",
  "cannot_divide",
  "merge",
  "other",
] as const;

export type PickingIssueReason = (typeof pickingIssueReasons)[number];

export interface PickingOrderSummary {
  id: string;
  refNo: string;
  status: PickingOrderStatus;
  deliveryDate: string | null;
  supplierName: string | null;
  shipTo: string | null;
  totalQty: number;
}

export interface PickingItem {
  id: string;
  pickingOrderId: string;
  partId: string;
  qty: number;
  pickedQty: number;
  allocatedQty: number;
  requiredDateCode: string | null;
  sourceShelfCode: string | null;
  part: Part | null;
  allocations: PickingAllocation[];
  packages: PickingPackage[];
}

export interface PickingAllocation {
  id: string;
  pickingItemId: string;
  qty: number;
  inventoryLot: {
    id: string;
    partId: string;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    cow: string | null;
    shelfCode: string | null;
    boxId: string | null;
  } | null;
  receivingOrder: { id: string; refNo: string } | null;
  pickingItem: {
    id: string;
    part: Part | null;
  } | null;
}

export interface PickingPackage {
  id: string;
  pickingItemId: string;
  pickingOrderId: string;
  qty: number;
  shippingBoxId: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  createdAt: Date | string;
}

export interface ShippingBox {
  id: string;
  pickingOrderId: string;
  status: string;
  packages: PickingPackage[];
}

export interface PickingOrderDetail {
  id: string;
  refNo: string;
  status: PickingOrderStatus;
  deliveryDate: Date | null;
  supplier: Supplier | null;
  poNo: string | null;
  shipTo: string | null;
  destinationCountry: string | null;
  requiredDateCodeNotice: string | null;
  items: PickingItem[];
  shippingBoxes: ShippingBox[];
  measuringTask: { id: string; status: string } | null;
  issueReason: PickingIssueReason | null;
  issueQty: number | null;
  issuePackSize: number | null;
  issueNote: string | null;
  issueRemark: string | null;
  issueReportedAt: Date | string | null;
  issueReportedBy: string | null;
  issueReportedByUser: { displayName: string } | null;
}

export interface PickingItemTransitionLog {
  id: string;
  entityId: string;
  fromState: string | null;
  toState: string;
  metadata: string | null;
  createdAt: Date | string;
  actorName: string | null;
}

export interface ApplyOcrPickInput {
  receivingOrderId: string;
  pickingItemId: string;
  qty: number;
  dateCode?: string | null;
  lotCode?: string | null;
  coo?: string | null;
  cow?: string | null;
}

export interface ReportPickingIssueEntry {
  orderId: string;
  remark?: string | null;
}

export interface ReportPickingIssuesInput {
  reason: PickingIssueReason;
  qty?: number | null;
  packSize?: number | null;
  note?: string | null;
}

export interface ReportPickingIssuesResult {
  reported: number;
  skipped: number;
}

// ------------------------------------------------------------------
// Put-away
// ------------------------------------------------------------------

export interface PutAwayCandidate {
  id: string;
  refNo: string;
  status: string;
  supplierName: string | null;
  availableQty: number;
}

export interface PutAwayLot {
  receivingInvoiceItemId: string;
  partId: string;
  partNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  totalQty: number;
  availableQty: number;
  scannedQty: number;
  boxedQty: number;
}

export interface PutAwayScan {
  id: string;
  receivingInvoiceItemId: string;
  partId: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfBoxId: string | null;
  verified: boolean;
  verifiedAt: Date | null;
  createdAt: Date;
}

export interface ShelfBoxItem {
  id: string;
  partId: string;
  part: { partNo: string | null };
  qty: number;
  verified: boolean;
}

export interface ShelfBox {
  id: string;
  receivingOrderId: string;
  shelfCode: string | null;
  status: string;
  createdAt: Date;
  items: ShelfBoxItem[];
}

export interface Shelf {
  code: string;
  zone: string | null;
}

// ------------------------------------------------------------------
// Measuring
// ------------------------------------------------------------------

export type MeasuringTaskStatus = "pending" | "completed";

export type BoxStatus = "open" | "closed" | "verified";

export interface MeasuringTaskSummary {
  id: string;
  status: MeasuringTaskStatus;
  pickingOrderId: string;
  pickingOrderRef: string | null;
  supplierName: string | null;
  totalItems: number;
  packedItems: number;
}

export interface MeasuringPickingOrder {
  id: string;
  refNo: string | null;
  supplierId: string | null;
  deliveryDate: Date | null;
  poNo: string | null;
  requiredDateCodeNotice: string | null;
  shipTo: string | null;
  destinationCountry: string | null;
  status: PickingOrderStatus;
  createdAt: Date;
  updatedAt: Date;
  supplier: Supplier | null;
  items: MeasuringPickingItem[];
}

export interface MeasuringPickingItem {
  id: string;
  pickingOrderId: string;
  partId: string;
  qty: number;
  pickedQty: number;
  requiredDateCode: string | null;
  sourceShelfCode: string | null;
  part: Part | null;
  allocations: MeasuringAllocation[];
}

export interface MeasuringAllocation {
  id: string;
  pickingItemId: string;
  inventoryLotId: string | null;
  qty: number;
  inventoryLot: {
    id: string;
    partId: string;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    cow: string | null;
    shelfCode: string | null;
    boxId: string | null;
    totalQty: number;
    allocatedQty: number;
    part: Part | null;
  } | null;
}

export interface MeasuringTaskDetail {
  id: string;
  status: MeasuringTaskStatus;
  pickingOrderId: string;
  createdAt: Date;
  pickingOrder: MeasuringPickingOrder | null;
  shippingBoxes: MeasuringShippingBox[];
}

export interface MeasuringShippingBox {
  id: string;
  pickingOrderId: string | null;
  measuringTaskId: string | null;
  status: BoxStatus;
  grossWeight: number | null;
  netWeight: number | null;
  destinationCountry: string | null;
  boxSize: string | null;
  createdAt: Date;
  packages: MeasuringPackage[];
}

export interface MeasuringPackage {
  id: string;
  pickingItemId: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  verified: boolean;
  pickingItem: {
    id: string;
    partId: string;
    part: Part | null;
  } | null;
}

export interface ShippingBoxForMeasuring {
  id: string;
  pickingOrderId: string | null;
  measuringTaskId: string | null;
  status: BoxStatus;
  grossWeight: number | null;
  netWeight: number | null;
  destinationCountry: string | null;
  boxSize: string | null;
  createdAt: Date;
  measuringTask: {
    id: string;
    status: MeasuringTaskStatus;
    pickingOrder: MeasuringPickingOrder | null;
  } | null;
  packages: MeasuringPackage[];
}

export interface BoxMeasurementsInput {
  grossWeight?: number | string | null;
  netWeight?: number | string | null;
  destinationCountry?: string | null;
  boxSize?: string | null;
}

export interface PackageVerificationInput {
  partNo: string;
  dateCode: string;
  lotCode: string;
  coo: string;
  cow: string;
  qty: number;
}

// ------------------------------------------------------------------
// Goods verify
// ------------------------------------------------------------------

export interface ShelfWithBoxCount {
  code: string;
  zone: string | null;
  boxCount: number;
}

export interface GoodsVerifyShelfBoxItem {
  id: string;
  shelfBoxId: string;
  partId: string;
  qty: number;
  verified: boolean;
  verifiedAt: Date | null;
  part: { partNo: string | null; description: string | null } | null;
}

export interface GoodsVerifyShelfBoxSummary {
  id: string;
  shelfCode: string | null;
  status: BoxStatus;
  itemCount: number;
  verifiedCount: number;
  lastCheckAt: Date | null;
  checkedToday: boolean;
}

export interface GoodsVerifyShelfBoxDetail {
  id: string;
  receivingOrderId: string | null;
  shelfCode: string | null;
  status: BoxStatus;
  createdAt: Date;
  shelf: { code: string; zone: string | null } | null;
  receivingOrder: { id: string; refNo: string } | null;
  items: GoodsVerifyShelfBoxItem[];
}

// ------------------------------------------------------------------
// Stock search
// ------------------------------------------------------------------

export interface StockSearchSupplier {
  id: string;
  code: string;
  name: string;
}

export interface StockSearchSupplierWithStats extends StockSearchSupplier {
  totalParts: number;
  partsWithInventory: number;
}

export interface StockSearchPart {
  id: string;
  partNo: string;
  internalCode: string | null;
  description: string | null;
  defaultCoo: string | null;
}

export interface StockSearchInventoryLot {
  partId: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfCode: string | null;
  boxId: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
  locationLabel: string;
}

export interface StockSearchSupplierPart {
  part: StockSearchPart;
  lots: StockSearchInventoryLot[];
  totalQty: number;
}
