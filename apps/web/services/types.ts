// ------------------------------------------------------------------
// Shared service-layer DTOs. No Drizzle imports here.
// ------------------------------------------------------------------

export interface User {
  id: string;
  username: string;
  displayName: string;
  /** Permission group codes from the JWT session (GET /auth/me). */
  groupCodes: string[];
  // Nullable: the HTTP API auth payload has no created_at column.
  createdAt: Date | null;
}

export interface SupplierQrcodeTemplate {
  code: string;
  qrcodeTemplate: string;
  qrcodeQtyEncoding: string | null;
}

// ------------------------------------------------------------------
// Receiving — DTOs matching apps/backend (:3002), see
// docs/backend/api-design.md §Receiving. All reads are nested; statuses
// are plain strings (the backend treats them as an evolving enum:
// pending | provisional_received | in_hand | clear).
// ------------------------------------------------------------------

export type ReceivingFilter = "all" | "pending" | "provisional_received" | "in_hand" | "clear";

export interface ReceivingOrderListRow {
  id: string;
  batchNo: string;
  status: string;
  deliveryDate: string | null;
  dateCode: string | null;
  supplierCode: string | null;
  supplierName: string | null;
  orgId: number;
  subInventoryCode: string | null;
  invoiceCount: number;
  itemCount: number;
  remainingItems: number;
  pendingPickingOrders: number;
}

export interface ReceivingOrderSupplier {
  id: string;
  code: string | null;
  name: string | null;
  shortName: string | null;
  profile: {
    name: string | null;
    qrTemplate: string | null;
    qtyEncoding: string | null;
    remark: string | null;
  } | null;
}

export interface ReceivingOrderDetail {
  id: string;
  batchNo: string;
  status: string;
  deliveryDate: string | null;
  dateCode: string | null;
  orgId: number;
  subInventoryCode: string | null;
  arrivedAt: string | null;
  arrivedBy: string | null;
  createdAt: string;
  updatedAt: string;
  supplier: ReceivingOrderSupplier | null;
  invoices: ReceivingInvoice[];
}

export interface ReceivingInvoice {
  id: string;
  invoiceNo: string;
  supplierId: string | null;
  wclCompanyName: string | null;
  totalQty: number | null;
  totalCtn: number | null;
  deliveryDate: string | null;
  orgId: number;
  subInventoryCode: string | null;
  createdAt: string;
  updatedAt: string;
  items: ReceivingItem[];
}

export interface ReceivingItem {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  poNo: string | null;
  poLine: string | null;
  lineQty: number;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  ctnNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  subInventoryCode: string | null;
  allocatedQty: number;
  part: {
    id: string;
    partNo: string;
    wclItemNo: string | null;
    description: string | null;
    defaultCoo: string | null;
  };
  mismatch: ReceivingItemMismatch | null;
}

// ------------------------------------------------------------------
// Mismatches — flat columns on the receiving invoice item (no separate
// mismatch table, no status/reporter: confirm writes a transition log,
// cancel clears the flag).
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

export interface ReceivingItemMismatch {
  reason: MismatchReason | null;
  mismatchQty: number | null;
  wrongPartNo: string | null;
  note: string | null;
}

export interface ReportMismatchInput {
  reason: MismatchReason;
  mismatchQty?: number | null;
  wrongPartNo?: string | null;
  note?: string;
}

// ------------------------------------------------------------------
// Picking section of a receiving order (GET /receiving-orders/:id/picking)
// — nested: orders embed items (allocations / packages / transition logs)
// and their shipping boxes.
// ------------------------------------------------------------------

export interface ReceivingPickingSection {
  pickingOrders: ReceivingPickingOrder[];
}

export interface ReceivingPickingOrder {
  id: string;
  orderNo: string;
  status: string;
  shipTo: string | null;
  customerCode: string | null;
  items: ReceivingPickingItem[];
  boxes: ReceivingPickingBox[];
}

export interface ReceivingPickingItem {
  id: string;
  partNo: string;
  qty: number;
  pickedQty: number;
  allocatedQty: number;
  allocations: ReceivingPickingAllocation[];
  packages: ReceivingPickingPackage[];
  transitionLogs: ReceivingPickingLog[];
}

export interface ReceivingPickingAllocation {
  id: string;
  qty: number;
  lot: {
    shelfCode: string | null;
    boxId: string | null;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    cow: string | null;
  } | null;
  receivingInvoiceItemId: string | null;
  receivingOrderId: string | null;
  boxId: string | null;
}

export interface ReceivingPickingPackage {
  id: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  verified: boolean;
  shippingBoxId: string | null;
}

export interface ReceivingPickingLog {
  fromState: string | null;
  toState: string;
  actorId: string | null;
  createdAt: string;
}

export interface ReceivingPickingBox {
  id: string;
  status: string;
  boxSize: string | null;
  grossWeight: number | null;
  netWeight: number | null;
}

// ------------------------------------------------------------------
// Receiving scan (POST /receiving-orders/:id/scan). Server-side
// parse/match: on 409 the ApiError body carries
// {message: "no_match" | "multiple_matches", candidates: ReceivingScanCandidate[]}.
// ------------------------------------------------------------------

export interface ReceivingScanInput {
  raw?: string;
  partNo?: string;
  qty?: number;
  dateCode?: string;
  lotCode?: string;
  coo?: string;
  cow?: string;
  ctnNo?: string;
  serialNo?: string;
}

export interface ReceivingScanCandidate {
  /** Receiving invoice item id. */
  id: string;
  partNo: string;
  wclItemNo: string | null;
  lineQty: number;
  receivedQty: number;
}

export interface ReceivingScanResult extends ReceivingScanCandidate {
  ctnNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  serialNo: string | null;
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

// ------------------------------------------------------------------
// Picking — DTOs matching apps/backend (:3002), see
// docs/backend/api-design.md §Picking. All reads are nested (no client
// joins); statuses are plain strings (pending | picking | finished |
// issue). NOTE: after each scan the backend's allocateAll rebuilds an
// item's allocation rows with NEW ids until its packages are boxed —
// pages must re-fetch the detail after scan/box mutations instead of
// caching allocation ids.
// ------------------------------------------------------------------

export const pickingIssueReasons = [
  "insufficient_stock",
  "cannot_divide",
  "merge",
  "other",
] as const;

export type PickingIssueReason = (typeof pickingIssueReasons)[number];

/** GET /picking-orders?status= row. */
export interface PickingOrderListRow {
  id: string;
  orderNo: string;
  status: string;
  poNo: string | null;
  shipTo: string | null;
  customerCode: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  deliveryDate: string | null;
  prioritySeq: number;
  workingBy: string | null;
  workingByName: string | null;
  itemCount: number;
  totalQty: number;
  pickedQty: number;
}

export interface PickingWorkLock {
  orderId: string;
  workingBy: string;
}

export interface PickingAllocationLot {
  id: string;
  shelfCode: string | null;
  boxId: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
}

/** One allocation row (qty > 0). `lot` null = receiving-area source
 *  (receivingInvoiceItemId / receivingOrderId; boxId from the invoice item). */
export interface PickingAllocation {
  id: string;
  qty: number;
  lot: PickingAllocationLot | null;
  receivingInvoiceItemId: string | null;
  receivingOrderId: string | null;
  boxId: string | null;
}

export interface PickingPackage {
  id: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  verified: boolean;
  shippingBoxId: string | null;
  sourceType: string;
  sourceId: string;
}

export interface PickingItem {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  qty: number;
  pickedQty: number;
  allocatedQty: number;
  allocations: PickingAllocation[];
  packages: PickingPackage[];
}

export interface PickingBox {
  id: string;
  status: string;
  boxSize: string | null;
  grossWeight: number | null;
  netWeight: number | null;
  destinationCountry: string | null;
  packageCount: number;
}

/** GET /picking-orders/:id — nested: order (incl. issue fields) +
 *  measuringTask + items(allocations, packages) + boxes. */
export interface PickingOrderDetail {
  id: string;
  orderNo: string;
  status: string;
  deliveryDate: string | null;
  poNo: string | null;
  shipTo: string | null;
  customerCode: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  workingBy: string | null;
  workingByName: string | null;
  issueReason: string | null;
  issueQty: number | null;
  issuePackSize: number | null;
  issueNote: string | null;
  issueRemark: string | null;
  issueReportedAt: string | null;
  issueReportedBy: string | null;
  createdAt: string;
  updatedAt: string;
  measuringTask: { id: string; status: string } | null;
  items: PickingItem[];
  boxes: PickingBox[];
}

/** POST /picking-items/:id/scan body (the actor comes from the JWT). */
export interface ScanPickingItemInput {
  allocationId: string;
  qty: number;
  dateCode?: string | null;
  lotCode?: string | null;
  coo?: string | null;
  cow?: string | null;
}

/** PATCH /shipping-boxes/:id fields (grams, one unit everywhere). */
export interface ShippingBoxUpdateInput {
  boxSize?: string | null;
  netWeightG?: number | string | null;
  grossWeightG?: number | string | null;
  destinationCountry?: string | null;
}

/** POST /picking-orders/report-issues — per-order entries (the dialog's
 *  shared fields apply to each selected order). */
export interface ReportPickingIssueEntry {
  pickingOrderId: string;
  reason: PickingIssueReason;
  qty?: number | null;
  packSize?: number | null;
  note?: string | null;
  remark?: string | null;
}

export interface ReportPickingIssuesResult {
  reported: string[];
  skipped: string[];
}

// ------------------------------------------------------------------
// Put-away — DTOs matching apps/backend (:3002), see
// docs/backend/api-design.md §Put-away. The detail screen reads ONE
// aggregate (GET /receiving-orders/:id/put-away): the order's expected
// items, the materialized inventory lots, the staging scans, and the
// non-staging boxes with their item rows.
// ------------------------------------------------------------------

export interface PutAwayCandidate {
  id: string;
  batchNo: string;
  status: string;
  supplierCode: string | null;
  supplierName: string | null;
  orgId: number;
  subInventoryCode: string | null;
  receivedItems: number;
  unboxedItems: number;
}

/** Expected (receivable) invoice item; remainingQty = received − picked −
 *  putAway − allocated − staged. */
export interface PutAwayExpectedItem {
  /** Receiving invoice item id. */
  id: string;
  partNo: string;
  lineQty: number;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  allocatedQty: number;
  remainingQty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
}

/** Inventory lot materialized from this order (via inventory_lot_sources). */
export interface PutAwayLot {
  id: string;
  partNo: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfCode: string | null;
  boxId: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
}

/** A scan row sitting in the order's staging box (not yet assigned). */
export interface PutAwayScan {
  id: string;
  receivingInvoiceItemId: string | null;
  partNo: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
}

export interface PutAwayBoxItem {
  id: string;
  receivingInvoiceItemId: string | null;
  partNo: string;
  qty: number;
  verified: boolean | null;
  verifiedAt: string | null;
}

export interface PutAwayBox {
  id: string;
  shelfCode: string | null;
  status: string;
  createdAt: string;
  items: PutAwayBoxItem[];
}

export interface PutAwayDetail {
  order: { id: string; batchNo: string; status: string; subInventoryCode: string | null };
  items: PutAwayExpectedItem[];
  lots: PutAwayLot[];
  scans: PutAwayScan[];
  boxes: PutAwayBox[];
}

/** POST /shelf-boxes response (a real, non-staging box). */
export interface ShelfBox {
  id: string;
  receivingOrderId: string | null;
  shelfCode: string | null;
  status: string;
  createdAt: string;
}

/** GET /admin/shelves row (the admin CRUD read doubles as the PDA shelf list). */
export interface Shelf {
  code: string;
  zone: string | null;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------------
// Measuring — DTOs matching apps/backend (:3002), see
// docs/backend/api-design.md §Measuring. The consolidated detail is the
// one task/order/boxes read (packages carry part identity, so the box
// page matches scanned labels client-side); box measurement reuses the
// shared picking verbs (verifyPackage / updateShippingBox /
// closeShippingBox). Weights are integer grams.
// ------------------------------------------------------------------

/** GET /measuring-tasks?status= row (box counts computed server-side). */
export interface MeasuringTaskListRow {
  id: string;
  status: string;
  pickingOrderId: string;
  orderNo: string;
  shipTo: string | null;
  boxCount: number;
  closedBoxCount: number;
  createdAt: string;
}

/** Package row inside a measuring box (part identity embedded). */
export interface MeasuringPackage {
  id: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  verified: boolean;
  partNo: string;
  wclItemNo: string | null;
}

export interface MeasuringBox {
  id: string;
  status: string;
  boxSize: string | null;
  /** Integer grams. */
  grossWeight: number | null;
  /** Integer grams. */
  netWeight: number | null;
  destinationCountry: string | null;
  packages: MeasuringPackage[];
}

/** GET /measuring-tasks/:id — consolidated {task, order, boxes}. */
export interface MeasuringTaskDetail {
  task: {
    id: string;
    status: string;
    pickingOrderId: string;
    createdAt: string;
  };
  order: {
    id: string;
    orderNo: string;
    status: string;
    shipTo: string | null;
    customerCode: string | null;
    poNo: string | null;
  };
  boxes: MeasuringBox[];
}

// ------------------------------------------------------------------
// Goods verify — DTOs matching apps/backend (:3002), see
// docs/backend/api-design.md §Goods verify (task-based, concept 7).
// Day-end generation creates one pending task per lot moved that day
// (idempotent per task_date + lot); the queue is the work list and
// verify is one call per task — an optional countedQty corrects the
// lot's total_qty and writes an ADJUST ledger row server-side.
// Statuses are plain strings (pending | verified | skipped).
// ------------------------------------------------------------------

/** GET /goods-verify-tasks row (also the verify response shape). */
export interface GoodsVerifyTaskListRow {
  id: string;
  /** YYYY-MM-DD. */
  taskDate: string;
  shelfCode: string | null;
  boxId: string | null;
  partNo: string;
  wclItemNo: string | null;
  expectedQty: number;
  status: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

/** Query filters for GET /goods-verify-tasks (all optional, ANDed). */
export interface GoodsVerifyTaskFilters {
  /** YYYY-MM-DD. */
  date?: string;
  status?: string;
  shelfCode?: string;
}

export interface GoodsVerifyBoxItem {
  id: string;
  partNo: string;
  qty: number;
  verified: boolean | null;
  verifiedAt: string | null;
}

/** GET /goods-verify-tasks/:id — task + lot (batch + location + qtys;
 *  the lot's org derives from its shelf) + the shelf box with its items
 *  (null when the task has no box or the id is a legacy non-shelf-box id). */
export interface GoodsVerifyTaskDetail {
  task: GoodsVerifyTaskListRow & {
    inventoryLotId: string;
    description: string | null;
    createdAt: string;
  };
  lot: {
    id: string;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    cow: string | null;
    shelfCode: string | null;
    boxId: string | null;
    totalQty: number;
    allocatedQty: number;
    availableQty: number;
    orgId: number | null;
    subInventoryCode: string | null;
  };
  box: { id: string; status: string; items: GoodsVerifyBoxItem[] } | null;
}

// ------------------------------------------------------------------
// Stock search — DTOs matching apps/backend (:3002), see
// docs/backend/api-design.md §Stock search. One aggregate read
// (GET /stock-search) replaces the old suppliers → parts → lots
// cascade: `parts` is the distinct part list of the matching lots with
// onHandQty = Σ totalQty per part. Zero-qty lots are included by
// design. Read-only — no actorId.
// ------------------------------------------------------------------

/** Query filters for GET /stock-search (all optional, ANDed; partNo is a
 *  normalized substring, shelfCode exact, supplierId traces the lot back to
 *  its receiving order). */
export interface StockSearchFilters {
  supplierId?: string;
  partNo?: string;
  shelfCode?: string;
}

export interface StockSearchPart {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  description: string | null;
  defaultCoo: string | null;
  onHandQty: number;
}

export interface StockSearchLot {
  partNo: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfCode: string | null;
  boxId: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
}

export interface StockSearchResult {
  parts: StockSearchPart[];
  lots: StockSearchLot[];
}

/** GET /admin/suppliers row (the admin CRUD read doubles as the PDA
 *  supplier dropdown list — same trick as the shelf list). */
export interface SupplierListRow {
  id: string;
  code: string;
  name: string;
  shortName: string | null;
}

/** GET /boxes?q= row — one box from either box table (shipping or shelf),
 *  matched by id substring; orderNo is the owning order's number when set. */
export interface BoxSearchResult {
  kind: "shipping" | "shelf";
  id: string;
  status: string;
  createdAt: string;
  orderNo: string | null;
}
