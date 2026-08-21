// ------------------------------------------------------------------
// Shared service-layer DTOs. No Drizzle imports here.
// ------------------------------------------------------------------

export interface User {
  id: string;
  username: string;
  displayName: string;
  /** Permission group codes from the JWT session (GET /auth/me). */
  groupCodes: string[];
  // Nullable: the HTTP API auth payload may omit createdDate.
  createdDate: Date | null;
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
  arrivedAt: string | null;
  arrivedBy: string | null;
  createdDate: string;
  lastUpdateDate: string;
  supplier: ReceivingOrderSupplier | null;
  invoices: ReceivingInvoice[];
}

export interface ReceivingInvoice {
  id: string;
  invoiceNo: string;
  supplierCode: string | null;
  wclCompanyName: string | null;
  totalQty: number | null;
  totalCtn: number | null;
  deliveryDate: string | null;
  orgId: number;
  createdDate: string;
  lastUpdateDate: string;
  items: ReceivingItem[];
}

export interface ReceivingItem {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  poNo: string | null;
  poLine: string | null;
  /** Expected qty; null = unknown upstream. */
  lineQty: number | null;
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
  /** Free-form jsonb extras from the upstream sync (nullable). */
  additionalData: Record<string, unknown> | null;
  /** Passthrough jsonb from the upstream order sync (optional). */
  orderData?: Record<string, unknown> | null;
  part: {
    id: string;
    partNo: string;
    wclItemNo: string | null;
    description: string | null;
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
  wclItemNo: string | null;
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
  createdDate: string;
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
  /** Expected qty; null = unknown upstream. */
  lineQty: number | null;
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
  allocationStatus: string;
  allocatedQty: number;
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
  /** Upstream Oracle order-line identifiers (stringified bigint); null when
   *  the upstream order line is unknown. */
  lineId: string | null;
  lineNumber: number | null;
  shipmentNumber: number | null;
  /** Backend-maintained: pending | picked. */
  status: string;
  /** Free-form jsonb extras from the upstream sync (nullable). */
  additionalData: Record<string, unknown> | null;
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
  shippedAt: string | null;
  shippedBy: string | null;
}

/** Whole-box claim hint on GET /picking-orders/:id — a fully-claimable shelf
 *  box whose current contents exactly equal the order's remaining demand. */
export interface SuggestedShelfBox {
  id: string;
  shelfCode: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  contents: { partNo: string; qty: number }[];
}

/** GET /picking-orders/:id — nested: order (incl. issue fields) +
 *  items(allocations, packages) + boxes. */
export interface PickingOrderDetail {
  id: string;
  orderNo: string;
  status: string;
  allocationStatus: string;
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
  createdDate: string;
  lastUpdateDate: string;
  items: PickingItem[];
  boxes: PickingBox[];
  suggestedBox: SuggestedShelfBox | null;
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

/** PATCH /shipping-boxes/:id fields (weights in kg, decimals allowed). */
export interface ShippingBoxUpdateInput {
  boxSize?: string | null;
  netWeightKg?: number | string | null;
  grossWeightKg?: number | string | null;
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

/** GET /put-away-tasks?status= row — the auto-created put-away work queue
 *  (one task per receiving order, oldest first; pending | completed). Only
 *  exists when the backend's putAway.autoCreateTasks config is on; the
 *  candidates list above stays the manual-mode list source. */
export interface PutAwayTaskListRow {
  id: string;
  status: string;
  receivingOrderId: string;
  batchNo: string;
  supplierCode: string | null;
  supplierName: string | null;
  orgId: number;
  subInventoryCode: string | null;
  receivedItems: number;
  unboxedItems: number;
  createdDate: string;
}

/** Expected (receivable) invoice item; remainingQty = received − picked −
 *  putAway − allocated − staged. */
export interface PutAwayExpectedItem {
  /** Receiving invoice item id. */
  id: string;
  partNo: string;
  wclItemNo: string | null;
  /** Expected qty; null = unknown upstream. */
  lineQty: number | null;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  allocatedQty: number;
  remainingQty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  /** Advisory shelf suggestion from the backend's suggestShelf strategy —
   *  null when the part has no stock history or suggestions are off. */
  suggestedShelfCode?: string | null;
  /** An OPEN shelf box already containing the same part (part_no match, any
   *  date code) — set when suggestionReason is "same-part-box". */
  suggestedBoxId?: string | null;
  /** Which strategy produced the suggestion. */
  suggestionReason?: "same-part-box" | "same-part-stock" | "sub-inventory-shelf" | null;
}

/** Inventory lot materialized from this order (via inventory_lot_sources). */
export interface PutAwayLot {
  id: string;
  partNo: string;
  wclItemNo: string | null;
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
  wclItemNo: string | null;
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
  wclItemNo: string | null;
  qty: number;
  verified: boolean | null;
  verifiedAt: string | null;
}

export interface PutAwayBox {
  id: string;
  shelfCode: string | null;
  status: string;
  createdDate: string;
  items: PutAwayBoxItem[];
}

export interface PutAwayDetail {
  order: { id: string; batchNo: string; status: string };
  items: PutAwayExpectedItem[];
  lots: PutAwayLot[];
  scans: PutAwayScan[];
  boxes: PutAwayBox[];
}

/** GET /put-away-tasks/:id — the same aggregate as PutAwayDetail plus the
 *  task row; each item carries suggestedShelfCode (see PutAwayExpectedItem). */
export interface PutAwayTaskDetail extends PutAwayDetail {
  task: {
    id: string;
    status: string;
    receivingOrderId: string;
    createdDate: string;
  };
}

/** POST /shelf-boxes response (a real, non-staging box). */
export interface ShelfBox {
  id: string;
  receivingOrderId: string | null;
  shelfCode: string | null;
  status: string;
  createdDate: string;
}

/** GET /admin/shelves row (the admin CRUD read doubles as the PDA shelf list). */
export interface Shelf {
  code: string;
  zone: string | null;
  createdDate: string;
  lastUpdateDate: string;
}

// ------------------------------------------------------------------
// Measuring — box-scoped (docs/backend/api-design.md §Measuring). There
// are no measuring tasks anymore: GET /measuring-boxes lists the open
// boxes with ≥1 package (a box may hold packages from several picking
// orders), and closing the box — after measurements via the shared
// picking verbs (verifyPackage / updateShippingBox / closeShippingBox) —
// IS the measuring completion. Weights are kilograms (decimals).
// ------------------------------------------------------------------

/** GET /measuring-boxes row — open boxes with ≥1 package. */
export interface MeasuringBoxListRow {
  boxId: string;
  status: string;
  /** Order numbers of every picking order with packages in the box. */
  orderNos: string[];
  packageCount: number;
  verifiedCount: number;
  createdDate: string;
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
  /** Verify-step re-scan flag (set by verifyPackage during a pending verify task). */
  verifyVerified: boolean;
  partNo: string;
  wclItemNo: string | null;
}

/** GET /measuring-boxes/:id — the box plus its packages. */
export interface MeasuringBoxDetail {
  boxId: string;
  /** Informational "created for" order (boxes may span orders). */
  pickingOrderId: string;
  status: string;
  boxSize: string | null;
  /** Kilograms (decimals). */
  grossWeight: number | null;
  /** Kilograms (decimals). */
  netWeight: number | null;
  /** Auto-calculated net weight suggestion from the net-weight formula master (kg), null when no part has a formula. */
  suggestedNetWeightKg?: number | null;
  destinationCountry: string | null;
  shippedAt: string | null;
  createdDate: string;
  packages: MeasuringPackage[];
}

// ------------------------------------------------------------------
// Verify — the second measuring pass (picking → measuring → verify →
// shipping). One verify task per shipping box (GET /verify-tasks* is
// box-keyed: the list row carries the box id + its order numbers).
// ------------------------------------------------------------------

/** GET /verify-tasks?status= row. */
export interface VerifyTaskListRow {
  taskId: string;
  status: string;
  shippingBoxId: string;
  boxStatus: string;
  orderNos: string[];
  destinationCountry: string | null;
  packageCount: number;
  verifyVerifiedCount: number;
  createdDate: string;
}

/** GET /verify-tasks/:id — task + box + packages. */
export interface VerifyTaskDetail {
  task: {
    id: string;
    status: string;
    shippingBoxId: string;
    createdDate: string;
  };
  box: {
    id: string;
    pickingOrderId: string;
    status: string;
    boxSize: string | null;
    grossWeight: number | null;
    netWeight: number | null;
    destinationCountry: string | null;
    shippedAt: string | null;
    suggestedNetWeightKg?: number | null;
  };
  packages: MeasuringPackage[];
}

// ------------------------------------------------------------------
// Flow config — GET /config, driven by the backend's warehouse_config row
// "flow" (FLOW_CONFIG env override; legacy FLOW_STEPS_DISABLED deprecated).
// Disabled steps hide their home tile.
// ------------------------------------------------------------------

export type FlowStep =
  | "receiving"
  | "put-away"
  | "picking"
  | "goods-verify"
  | "measuring"
  | "verify"
  | "stock-search";

export interface FlowConfig {
  flowSteps: Record<FlowStep, boolean>;
  /** Resolved steps.put-away section: autoCreateTasks switches the PDA
   *  put-away list from derived candidates to the task queue; suggestShelf
   *  is the backend's shelf-hint strategy ("existing-stock" | "off"). */
  putAway: { autoCreateTasks: boolean; suggestShelf: string };
  /** Resolved steps.picking.allocation section: allowDockStock=false means
   *  only put-away stock allocates — receiving and picking are decoupled. */
  pickingAllocation: { allowDockStock: boolean };
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
  wclItemNo: string | null;
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
    createdDate: string;
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
 *  normalized substring, shelfCode exact, supplierCode traces the lot back to
 *  its receiving order). */
export interface StockSearchFilters {
  supplierCode?: string;
  partNo?: string;
  shelfCode?: string;
}

export interface StockSearchPart {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  description: string | null;
  onHandQty: number;
}

export interface StockSearchLot {
  partNo: string;
  wclItemNo: string | null;
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
  createdDate: string;
  orderNo: string | null;
}

// ---------------------------------------------------------------------------
// GET /labels-data — printable labels for the /print-labels page.
// ---------------------------------------------------------------------------

export interface LabelPartRow {
  partNo: string;
  qty: number;
  lotCode: string | null;
  dateCode: string | null;
  /** Raw scan value per the supplier QR template; null when unbuildable. */
  qrValue: string | null;
  /** Open picking orders demanding this part (for page filtering). */
  pickingOrderRefs: string[];
}

export interface LabelsData {
  generatedAt: string;
  shelfBoxes: {
    id: string;
    shelfCode: string | null;
    status: string;
    items: { partNo: string; qty: number }[];
  }[];
  shelfCodes: string[];
  receivingOrders: {
    batchNo: string;
    supplierCode: string | null;
    status: string;
    invoices: {
      invoiceNo: string;
      items: (LabelPartRow & {
        id: string;
        ctnNo: string | null;
        poNo: string | null;
        poLine: string | null;
      })[];
    }[];
  }[];
  /** Current shelf stock (boxed lots) — labels for picking from a shelf box. */
  shelfLots: (LabelPartRow & { boxId: string; shelfCode: string | null })[];
  /** One label per open-order allocation — the "pick ticket" with the exact
   *  qty the order takes from that source (a lot/carton split across orders
   *  gets one label per share). */
  pickLabels: (LabelPartRow & {
    orderNo: string;
    /** CTN <ctn_no> / <box> @ <shelf> / <shelf> / "receiving" display hint. */
    source: string;
  })[];
}
