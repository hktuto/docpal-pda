/**
 * Typed wrappers over useApi for the backend's flow endpoints (non-`/admin`
 * reads the console needs: picking / receiving / shipping) plus the admin
 * flow-edit PATCHes. DTOs mirror the backend rows (camelCase JSON).
 */

// ---- picking ----

export interface PickingOrderRow {
  id: string;
  orderNo: string;
  status: string;
  pickingOrderType: string | null;
  remark: string | null;
  poNo: string | null;
  shipTo: string | null;
  customerCode: string | null;
  deliveryDate: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  prioritySeq: number;
  workingBy: string | null;
  workingByName: string | null;
  itemCount: number;
  totalQty: number;
  pickedQty: number;
  allocationStatus: string;
  allocatedQty: number;
  /** Unresolved outdated date-code scan warnings on this order. */
  outdatedWarningCount: number;
  createdDate: string;
  lastUpdateDate: string;
}

export interface PickingItemRow {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  qty: number;
  pickedQty: number;
  allocatedQty: number;
  lineId: string | null;
  lineNumber: number | null;
  shipmentNumber: number | null;
  status: string;
  allocations: {
    id: string;
    qty: number;
    boxId: string | null;
    receivingInvoiceItemId: string | null;
    receivingOrderId: string | null;
    lot: {
      id: string;
      shelfCode: string | null;
      /** shelves.display_name for shelfCode — presentation-only alias. */
      shelfDisplayName?: string | null;
      /** shelves.warning for shelfCode — advisory operator warning. */
      shelfWarning: string | null;
      boxId: string | null;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
      totalQty: number;
      allocatedQty: number;
      availableQty: number;
    } | null;
    receiving: {
      orderId: string;
      batchNo: string;
      invoiceNo: string | null;
      partNo: string | null;
      poNo: string | null;
      receivedQty: number | null;
      dateCode: string | null;
    } | null;
  }[];
  packages: { id: string; qty: number; dateCode: string | null; lotCode: string | null; verified: boolean; verifyVerified: boolean; shippingBoxId: string | null }[];
}

export interface PickingOrderDetail extends Omit<PickingOrderRow, "itemCount" | "totalQty" | "pickedQty" | "prioritySeq" | "workingBy" | "workingByName"> {
  issueReason: string | null;
  issueQty: number | null;
  issuePackSize: number | null;
  issueNote: string | null;
  issueRemark: string | null;
  issueReportedAt: string | null;
  issueReportedBy: string | null;
  issueReportedByName: string | null;
  items: PickingItemRow[];
  boxes: { id: string; status: string; boxSize: string | null; grossWeight: number | null; netWeight: number | null; destinationCountry: string | null; packageCount: number; shippedAt: string | null }[];
}

/** Admin-editable picking order fields (PATCH /admin/picking-orders/:id). */
export interface PickingOrderEditFields {
  deliveryDate?: string | null;
  shipTo?: string | null;
  orgId?: number | null;
  subInventoryCode?: string | null;
}

/** org_info row from GET /admin/sub-inventories (location-pair picker). */
export interface SubInventoryRow {
  orgId: number;
  secondaryInventoryName: string;
  subinvDescription: string | null;
  officeCode: string | null;
}

/** country_list row from GET /admin/countries (ship-to picker: show name, store code). */
export interface CountryRow {
  id: string;
  code: string;
  name: string;
}

// ---- receiving ----

export interface AllocateAllSummary {
  demands: number;
  fullyAllocated: number;
  partiallyAllocated: number;
  allocationsCreated: number;
  allocationsRemoved: number;
  skippedReceivingSources: number;
}

export interface AllocationRunSummary {
  demands: number;
  fullyAllocated: number;
  partiallyAllocated: number;
  allocationsCreated: number;
  allocationsRemoved: number;
  skippedReceivingSources: number;
  changed: boolean;
  durationMs: number;
}

export interface ConfirmArrivalResult {
  id: string;
  batchNo: string;
  status: string;
  allocation: AllocationRunSummary | null;
}

export interface ReceivingOrderRow {
  id: string;
  batchNo: string;
  /** Order name per the warehouse's receivingOrderNameTemplate flow config. */
  displayName?: string;
  status: string;
  deliveryDate: string | null;
  dateCode: string | null;
  supplierCode: string | null;
  supplierName: string | null;
  orgId: number;
  /** Org office code from org_info (display form of orgId). */
  orgCode: string | null;
  invoiceCount: number;
  invoiceNos: string | null;
  itemCount: number;
  remainingItems: number;
  pendingPickingOrders: number;
  createdDate: string;
  lastUpdateDate: string;
}

export interface ReceivingItemAllocation {
  id: string;
  qty: number;
  manual: boolean;
  pickingItemId: string;
  pickingOrderId: string;
  orderNo: string;
  orderStatus: string;
}

export interface ReceivingItemRow {
  id: string;
  receivingInvoiceId: string;
  partNo: string;
  wclItemNo: string | null;
  poNo: string | null;
  poLine: string | null;
  lineQty: number | null;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  ctnNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  allocatedQty: number;
  /** Item's stock partition (re-stamped by receivingSubInventoryRules at confirm-arrival). */
  orgId: number | null;
  subInventoryCode: string | null;
  /** Allocation rows sourced from this receiving item. */
  allocations: ReceivingItemAllocation[];
  /** Passthrough jsonb from the upstream order sync (optional). */
  orderData?: Record<string, unknown> | null;
  /** Item-level upstream extras jsonb (e.g. drawing_no). */
  additionalData?: Record<string, unknown> | null;
  mismatch: { reason: string | null; mismatchQty: number | null; wrongPartNo: string | null; note: string | null } | null;
}

export interface ReceivingOrderDetail {
  id: string;
  batchNo: string;
  /** Order name per the warehouse's receivingOrderNameTemplate flow config. */
  displayName?: string;
  status: string;
  deliveryDate: string | null;
  dateCode: string | null;
  orgId: number;
  supplier: { id: string; code: string; name: string; shortName: string | null } | null;
  invoices: {
    id: string;
    invoiceNo: string;
    totalQty: number | null;
    totalCtn: number | null;
    deliveryDate: string | null;
    orgId: number;
    items: ReceivingItemRow[];
  }[];
}

// ---- shipping (per-box: closed, unshipped boxes ready to ship) ----

export interface ShippingBoxRow {
  boxId: string;
  orderNos: string[];
  shipTos: string[];
  destinationCountry: string | null;
  boxSize: string | null;
  grossWeight: number | null;
  netWeight: number | null;
  packageCount: number;
  closedAt: string;
}

export interface ShippingBoxDetail {
  box: {
    boxId: string;
    pickingOrderId: string | null;
    status: string;
    boxSize: string | null;
    grossWeight: number | null;
    netWeight: number | null;
    destinationCountry: string | null;
    shippedAt: string | null;
    shippedBy: string | null;
    createdDate: string;
  };
  packages: { id: string; qty: number; dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null; verified: boolean; partNo: string; wclItemNo: string | null }[];
  orders: { id: string; orderNo: string; status: string; shipTo: string | null; customerCode: string | null; poNo: string | null }[];
}

// ---- stock search ----

export interface StockSearchPart {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  description: string | null;
  onHandQty: number;
}

export interface StockSearchLot {
  /** Lot PK for the history drill-down (/admin/inventory-lots/:id/history). */
  lotId: string;
  partNo: string;
  wclItemNo: string | null;
  description: string | null;
  brand: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  drawingNo: string | null;
  shelfCode: string | null;
  shelfDisplayName?: string | null;
  zone: string | null;
  boxId: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  /** Org office code from org_info (display form of orgId). */
  officeCode?: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
}

export interface StockSearchResult {
  parts: StockSearchPart[];
  lots: StockSearchLot[];
}

/** Filters shared by /stock-search and /stock-search/summary. */
export interface StockSearchParams {
  supplierCode?: string[];
  partNo?: string;
  drawingNo?: string;
  shelfCode?: string[];
  zone?: string[];
  brand?: string[];
  /** Exact location pairs as "orgId:subInventoryCode" strings (the combined
   *  location dropdown values) — matched as (org, sub-inventory) pairs, not
   *  as independent org/sub-inventory dimensions. */
  location?: string[];
  dateCodeFrom?: string;
  dateCodeTo?: string;
}

/** Opt-in server paging for /stock-search — any `page` switches the response
 *  to StockSearchPage. `sort` is a lots-table column key (backend whitelist). */
export interface StockSearchPageParams extends StockSearchParams {
  page: number;
  pageSize: number;
  sort?: string;
  dir?: "asc" | "desc";
}

/** Paged lot rows (no `parts` — a whole-result aggregate the admin doesn't use). */
export interface StockSearchPage {
  rows: StockSearchLot[];
  total: number;
}

function stockSearchQuery(params: StockSearchParams & Partial<StockSearchPageParams>): string {
  const qs = new URLSearchParams();
  for (const v of params.supplierCode ?? []) qs.append("supplierCode", v);
  if (params.partNo) qs.set("partNo", params.partNo);
  if (params.drawingNo) qs.set("drawingNo", params.drawingNo);
  for (const v of params.shelfCode ?? []) qs.append("shelfCode", v);
  for (const v of params.zone ?? []) qs.append("zone", v);
  for (const v of params.brand ?? []) qs.append("brand", v);
  for (const v of params.location ?? []) qs.append("location", v);
  if (params.dateCodeFrom) qs.set("dateCodeFrom", params.dateCodeFrom);
  if (params.dateCodeTo) qs.set("dateCodeTo", params.dateCodeTo);
  if (params.page !== undefined) qs.set("page", String(params.page));
  if (params.pageSize !== undefined) qs.set("pageSize", String(params.pageSize));
  if (params.sort) qs.set("sort", params.sort);
  if (params.dir) qs.set("dir", params.dir);
  return qs.toString();
}

/** Stock totals for the summary header (follows the search filters). */
export interface StockSearchSummary {
  partCount: number;
  lotCount: number;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
  shelfCount: number;
  lastUpdateDate: string | null;
  /** Outdated threshold in force (flow config outdatedStockYears). */
  outdatedYears: number;
  outdatedPartCount: number;
  outdatedLotCount: number;
  outdatedQty: number;
}

/** Distinct filter values present in the current stock (for dropdowns). */
export interface StockSearchOptions {
  brands: string[];
  zones: string[];
  shelves: { code: string; displayName?: string | null; zone: string | null }[];
  locations: { orgId: number | null; subInventoryCode: string | null; description: string | null; officeCode: string | null }[];
}

// ---- issues ----

export interface MismatchListRow {
  itemId: string;
  receivingOrderId: string;
  batchNo: string;
  invoiceId: string;
  invoiceNo: string;
  partNo: string;
  wclItemNo: string | null;
  supplierCode: string | null;
  reason: string | null;
  mismatchQty: number | null;
  wrongPartNo: string | null;
  note: string | null;
}

// ---- outdated date-code scan warnings (spec 2026-10-07) ----

export interface OutdatedWarningRow {
  id: string;
  orderKind: "picking" | "putaway";
  orderId: string;
  orderNo: string | null;
  orderItemId: string | null;
  packageId: string | null;
  supplierCode: string;
  supplierName: string | null;
  wclItemNo: string | null;
  partNo: string | null;
  dateCode: string;
  limitMonths: number;
  qty: number | null;
  scannedBy: string;
  scannedByName: string | null;
  scannedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
}

export interface OutdatedWarningListParams {
  /** Absent = all. */
  resolved?: boolean;
  orderKind?: "picking" | "putaway";
}

// ---- part availability (stock lots + open receiving sources for a part) ----

export interface PartAvailabilityStockRow {
  lotId: string;
  orgId: number | null;
  subInventoryCode: string | null;
  shelfCode: string | null;
  shelfDisplayName?: string | null;
  boxId: string | null;
  partNo: string;
  wclItemNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
}

export interface PartAvailabilityReceivingRow {
  receivingOrderId: string;
  batchNo: string;
  supplierCode: string | null;
  status: string;
  invoiceNo: string;
  receivingInvoiceItemId: string;
  lineQty: number | null;
  receivedQty: number;
  putAwayQty: number;
  pickedQty: number;
  orgId: number | null;
  subInventoryCode: string | null;
  ctnNo: string | null;
  dateCode: string | null;
}

export interface PartAvailability {
  stock: PartAvailabilityStockRow[];
  receiving: PartAvailabilityReceivingRow[];
}

// ---- part demand (open picking items needing a part) ----

export interface PartDemandRow {
  pickingOrderId: string;
  orderNo: string;
  orderStatus: string;
  deliveryDate: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  pickingItemId: string;
  partNo: string;
  qty: number;
  pickedQty: number;
  allocatedQty: number;
  remainingQty: number;
}

export interface PartDemand {
  demand: PartDemandRow[];
}

// ---- flow config (warehouse_config row "flow") ----

export interface SubInventoryPatternRuleRow {
  /** po_no glob pattern: "*" matches any run — "319*" prefix, "*W" suffix. */
  poNoPattern: string;
  /** sub_inventory_code stamped on matching items. */
  subInventoryCode: string;
}

export interface SubInventoryRuleGroupRow {
  /** Item org_ids the group applies to. */
  orgIds: number[];
  /** Ordered glob patterns, first match wins. */
  patterns: SubInventoryPatternRuleRow[];
  /** Stamped when the org matches but no pattern does; null = leave unchanged. */
  default: string | null;
}

export interface FromSubinventoryOrgGroupRow {
  /** Converted org_id used for allocation matching. */
  orgId: number;
  /** Exact additional_data.from_subinventory codes (case-sensitive). */
  fromSubinventories: string[];
}

export interface FlowConfigState {
  /** Effective config currently in force on the backend. */
  config: {
    steps: Record<string, { enabled: boolean }>;
    pickingAllocation: { allowDockStock: boolean };
    putAway: { autoCreateTasks: boolean; suggestShelf: "existing-stock" | "off" };
    /** Org partitions this warehouse accepts; [] = all orgs (no filtering). */
    allowedOrgIds: number[];
    /** Stock age threshold (years) for the stock-search outdated count. */
    outdatedStockYears: number;
    /** Confirm-arrival sub-inventory defaulting rule groups. */
    receivingSubInventoryRules: SubInventoryRuleGroupRow[];
    /** Transfer-order from_subinventory → org conversion groups. */
    pickingFromSubinventoryOrgs: FromSubinventoryOrgGroupRow[];
    /** Display template for lot date code / lot code / COO / COW. */
    dateCodeDisplayTemplate: string;
    /** Display template for the receiving order name (list/detail titles). */
    receivingOrderNameTemplate: string;
    /** Per-PDA-list {title, meta} display templates (fully resolved). */
    pdaListTemplates: Record<string, { title: string; meta: string }>;
    /** PDA view config overrides as stored (validated partial). */
    pdaViewConfig?: {
      lists?: Record<string, { title?: string; meta?: string[]; chip?: string }>;
      receivingDetail?: { defaultGrouping?: string; itemFields?: string[]; expandedFields?: string[] };
      pickingDetail?: { itemFields?: string[]; expandedFields?: string[] };
      putAwayDetail?: { itemFields?: string[]; expandedFields?: string[] };
    };
    /** Picking shelf-scan mode ("off" | "require-match" | "require-any"). */
    pickingShelfScan: "off" | "require-match" | "require-any";
  };
  /** Raw warehouse_config row value (partial JSON as stored). */
  stored: Record<string, unknown>;
  /** True when the FLOW_CONFIG env override is active — DB edits don't apply. */
  envOverride: boolean;
  /** PUT only: false when the env override blocked runtime apply. */
  applied?: boolean;
}

// ---- audit logs (transaction_logs rows for an order + its child entities) ----

export interface TransactionLogRow {
  id: string;
  entityType: string;
  entityId: string;
  fromState: string | null;
  toState: string;
  actorId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown>;
  createdDate: string;
}

export interface OrderLogsParams {
  page: number;
  pageSize: number;
  q: string;
  sort: string;
  dir: "asc" | "desc";
}

export interface ReceivingPutAwayLogRow {
  id: string;
  itemId: string;
  partNo: string;
  wclItemNo: string | null;
  qty: number;
  shelfCode: string | null;
  boxId: string | null;
  lotId: string | null;
  actorId: string | null;
  actorName: string | null;
  createdDate: string;
}

export interface OrderLogsPage {
  rows: TransactionLogRow[];
  total: number;
  /** Receiving orders only: the order's put-away ledger entries
   *  (item → shelf/box → actor), oldest first. */
  putAway?: ReceivingPutAwayLogRow[];
}

// ---- lot history (stock-search drill-down) ----

export interface LotHistorySummary {
  id: string;
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
  createdDate: string;
}

export interface LotHistorySource {
  receivingInvoiceItemId: string;
  receivingOrderId: string;
  batchNo: string;
  partNo: string;
  qty: number;
  createdDate: string;
}

export interface LotHistoryMovement {
  id: string;
  txnType: string;
  qtyType: string;
  qtyDelta: number;
  shelfCode: string | null;
  boxId: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  referenceType: string | null;
  referenceId: string | null;
  receivingInvoiceItemId: string | null;
  actorId: string | null;
  actorName: string | null;
  txnReason: string | null;
  metadata: Record<string, unknown>;
  txnAt: string;
  pickingOrderId: string | null;
  pickingOrderNo: string | null;
  shippingBoxId: string | null;
  receivingBatchNo: string | null;
}

export interface LotHistory {
  lot: LotHistorySummary;
  sources: LotHistorySource[];
  movements: LotHistoryMovement[];
}

function logsQuery(p: OrderLogsParams): string {
  const qs = new URLSearchParams();
  qs.set("page", String(p.page));
  qs.set("pageSize", String(p.pageSize));
  if (p.q) qs.set("q", p.q);
  if (p.sort) qs.set("sort", p.sort);
  qs.set("dir", p.dir);
  return `?${qs}`;
}

/** List filters/paging for /picking-orders and /receiving-orders (both return
 *  { rows, total }; page/pageSize convert to limit/offset, omitted = full
 *  list). `sort` is a backend-whitelisted column key. */
export interface OrderListParams {
  status?: string;
  /** Picking only: order types, any-of (comma-joined for the wire). */
  type?: string[];
  search?: string;
  /** Receiving only: hide orders with no invoices (upstream placeholders). */
  hasInvoices?: boolean;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: "asc" | "desc";
}

function orderListQuery(params: OrderListParams): string {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.type?.length) qs.set("type", params.type.join(","));
  if (params.search) qs.set("search", params.search);
  if (params.hasInvoices) qs.set("hasInvoices", "1");
  if (params.page !== undefined && params.pageSize !== undefined) {
    qs.set("limit", String(params.pageSize));
    qs.set("offset", String((Math.max(1, params.page) - 1) * params.pageSize));
  }
  if (params.sort) {
    qs.set("sort", params.sort);
    qs.set("dir", params.dir ?? "asc");
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export function useFlowApi() {
  const api = useApi();
  return {
    // Picking
    // The backend list endpoints return { rows, total } — the admin tables
    // page/sort/filter server-side; omit page/pageSize for the full list.
    listPickingOrders: (params: OrderListParams = {}) =>
      api.get<{ rows: PickingOrderRow[]; total: number }>(`/picking-orders${orderListQuery(params)}`),
    getPickingOrder: (id: string) => api.get<PickingOrderDetail>(`/picking-orders/${id}`),
    reorderPickingOrders: (orderIds: string[]) =>
      api.post<{ reordered: number }>(`/picking-orders/reorder`, { orderIds }),
    // Manual allocation triggers — both await the recompute in the request.
    allocateAll: () => api.post<AllocateAllSummary>(`/admin/allocation/run`, {}),
    reallocatePickingOrder: (id: string) =>
      api.post<{ allocation: AllocationRunSummary }>(`/admin/picking-orders/${id}/reallocate`, {}),
    // allocation is null when the scoped recompute fell back to the
    // background full recompute (same as confirm-arrival).
    reallocateReceivingOrder: (id: string) =>
      api.post<{ allocation: AllocationRunSummary | null }>(`/admin/receiving-orders/${id}/reallocate`, {}),
    removePickingAllocation: (orderId: string, itemId: string, allocationId: string) =>
      api.del<{ removed: number; qty: number }>(`/admin/picking-orders/${orderId}/items/${itemId}/allocations/${allocationId}`),
    addManualPickingAllocation: (
      orderId: string,
      itemId: string,
      body: { qty: number; inventoryLotId?: string; receivingInvoiceItemId?: string; override?: boolean }
    ) =>
      api.post<{ allocationId: string; qty: number }>(
        `/admin/picking-orders/${orderId}/items/${itemId}/allocations`,
        body
      ),
    // Order info edit: delivery date, ship-to (country code) and/or the
    // ship-from location pair (orgId + subInventoryCode, set together; both
    // null clears the pair) — one PATCH for the whole info section.
    updatePickingOrder: (id: string, fields: PickingOrderEditFields) =>
      api.patch(`/admin/picking-orders/${id}`, fields),
    // Admin status override (spec 2026-09-17-admin-picking-status-override-design.md):
    // any of pending/picking/issue/finished/shipped, no transition guards; a
    // live PDA work lock is force-cleared. changed=false when already the target.
    overridePickingOrderStatus: (id: string, status: string, reason?: string) =>
      api.patch<{ id: string; orderNo: string; status: string; previousStatus: string; changed: boolean }>(
        `/admin/picking-orders/${id}/status`,
        { status, ...(reason?.trim() ? { reason: reason.trim() } : {}) }
      ),
    listSubInventories: () => api.get<SubInventoryRow[]>("/admin/sub-inventories"),
    listCountries: () => api.get<CountryRow[]>("/admin/countries"),

    // Receiving
    listReceivingOrders: (params: OrderListParams = {}) =>
      api.get<{ rows: ReceivingOrderRow[]; total: number }>(`/receiving-orders${orderListQuery(params)}`),
    getReceivingOrder: (id: string) => api.get<ReceivingOrderDetail>(`/receiving-orders/${id}`),
    // confirm-arrival runs the scoped allocation recompute synchronously;
    // allocation is null when it fell back to the background full recompute.
    confirmReceivingArrival: (id: string) =>
      api.post<ConfirmArrivalResult>(`/receiving-orders/${id}/confirm-arrival`, {}),
    updateReceivingDeliveryDate: (id: string, deliveryDate: string | null) =>
      api.patch(`/admin/receiving-orders/${id}`, { deliveryDate }),
    // Admin status override: any of pending/provisional_received/in_hand/clear,
    // no transition guards. changed=false when already the target.
    overrideReceivingOrderStatus: (id: string, status: string, reason?: string) =>
      api.patch<{ id: string; batchNo: string; status: string; previousStatus: string; changed: boolean }>(
        `/admin/receiving-orders/${id}/status`,
        { status, ...(reason?.trim() ? { reason: reason.trim() } : {}) }
      ),
    updateReceivingItem: (
      id: string,
      fields: Partial<Record<"dateCode" | "lotCode" | "coo" | "cow" | "ctnNo", string | null>>
    ) => api.patch(`/admin/receiving-invoice-items/${id}`, fields),

    // Issues (actor comes from the JWT — the backend ignores any body actorId)
    listReceivingMismatches: () => api.get<MismatchListRow[]>("/admin/receiving-mismatches"),
    confirmReceivingMismatch: (itemId: string) =>
      api.post(`/receiving-invoice-items/${itemId}/mismatch/confirm`, {}),
    cancelReceivingMismatch: (itemId: string) =>
      api.post(`/receiving-invoice-items/${itemId}/mismatch/cancel`, {}),
    resolvePickingIssue: (orderId: string, resolutionNote?: string) => {
      const note = (resolutionNote ?? "").trim();
      return api.post(`/picking-orders/${orderId}/resolve-issue`, note ? { resolutionNote: note } : {});
    },
    reportPickingIssue: (
      orderId: string,
      entry: { reason: string; qty?: number; packSize?: number; note?: string; remark?: string }
    ) => api.post(`/picking-orders/report-issues`, { entries: [{ pickingOrderId: orderId, ...entry }] }),
    reportReceivingMismatch: (
      itemId: string,
      body: { reason: string; mismatchQty?: number; wrongPartNo?: string; note?: string }
    ) => api.post(`/receiving-invoice-items/${itemId}/mismatch`, body),
    removeReceivingItem: (itemId: string) => api.del(`/admin/receiving-invoice-items/${itemId}`),

    // Outdated date-code scan warnings (spec 2026-10-07): the list is newest
    // first; resolution is whole-order (stamps every unresolved row, completes
    // a held order) and returns how many rows were stamped.
    listOutdatedWarnings: (params: OutdatedWarningListParams = {}) => {
      const qs = new URLSearchParams();
      if (params.resolved !== undefined) qs.set("resolved", String(params.resolved));
      if (params.orderKind) qs.set("orderKind", params.orderKind);
      const s = qs.toString();
      return api.get<OutdatedWarningRow[]>(`/admin/outdated-warnings${s ? `?${s}` : ""}`);
    },
    resolveOrderOutdatedWarnings: (orderKind: "picking" | "putaway", orderId: string, note?: string) =>
      api.post<{ resolved: number }>(`/admin/outdated-warnings/resolve-order`, {
        orderKind,
        orderId,
        ...(note?.trim() ? { note: note.trim() } : {}),
      }),

    // Flow config (warehouse_config row "flow"; applies at runtime on save
    // unless the FLOW_CONFIG env override is active)
    getFlowConfig: () => api.get<FlowConfigState>("/admin/flow-config"),
    saveFlowConfig: (value: Record<string, unknown>) =>
      api.put<FlowConfigState>("/admin/flow-config", value),

    // Audit logs (server-paged)
    listReceivingOrderLogs: (orderId: string, params: OrderLogsParams) =>
      api.get<OrderLogsPage>(`/admin/receiving-orders/${orderId}/logs${logsQuery(params)}`),
    listPickingOrderLogs: (orderId: string, params: OrderLogsParams) =>
      api.get<OrderLogsPage>(`/admin/picking-orders/${orderId}/logs${logsQuery(params)}`),
    listLotHistory: (lotId: string) => api.get<LotHistory>(`/admin/inventory-lots/${lotId}/history`),

    // Stock search (multi-value filters — each value appended as a repeated
    // query param; the backend treats them as any-of)
    stockSearch: (params: StockSearchParams) =>
      api.get<StockSearchResult>(`/stock-search?${stockSearchQuery(params)}`),
    // Opt-in server-paged variant ({ rows, total }) — the lots table in
    // ungrouped mode; stockSearch (full) stays for group-by and Excel export.
    stockSearchPage: (params: StockSearchPageParams) =>
      api.get<StockSearchPage>(`/stock-search?${stockSearchQuery(params)}`),
    stockSearchOptions: () => api.get<StockSearchOptions>("/stock-search/options"),
    // Same filters as stockSearch ({} = overall totals).
    stockSearchSummary: (params: StockSearchParams = {}) =>
      api.get<StockSearchSummary>(`/stock-search/summary?${stockSearchQuery(params)}`),
    // Part availability for the picking-detail modal (stock lots + open
    // receiving sources, all orgs/sub-inventories).
    getPartAvailability: (partNo: string, wclItemNo?: string | null) => {
      const qs = new URLSearchParams();
      qs.set("partNo", partNo);
      if (wclItemNo) qs.set("wclItemNo", wclItemNo);
      return api.get<PartAvailability>(`/admin/part-availability?${qs}`);
    },
    // Open picking-order demand for a part (uncovered remaining qty > 0).
    getPartDemand: (partNo: string, wclItemNo?: string | null) => {
      const qs = new URLSearchParams();
      qs.set("partNo", partNo);
      if (wclItemNo) qs.set("wclItemNo", wclItemNo);
      return api.get<PartDemand>(`/admin/part-demand?${qs}`);
    },

    // Shipping (per-box — closed, unshipped boxes ready to ship)
    listShippingBoxes: () => api.get<ShippingBoxRow[]>("/shipping-orders"),
    getShippingBox: (boxId: string) =>
      api.get<ShippingBoxDetail>(`/shipping-orders/${boxId}`),
    // Marks each box shipped (POST /shipping-orders/:boxId/ship). Attempts all
    // ids; on any failure throws an Error whose `failed` property lists the
    // per-box failures ({ id, message }) so callers can surface them.
    shipShippingBoxes: async (boxIds: string[]): Promise<void> => {
      const failed: { id: string; message: string }[] = [];
      for (const id of boxIds) {
        try {
          await api.post(`/shipping-orders/${id}/ship`);
        } catch (e: any) {
          failed.push({ id, message: e?.message ?? String(e) });
        }
      }
      if (failed.length > 0) {
        const err = new Error(failed.map((f) => `${f.id}: ${f.message}`).join("; "));
        (err as any).failed = failed;
        throw err;
      }
    },
    // Batch status override on the picking order list: one PATCH per id (same
    // shipShippingBoxes contract — attempts every id, throws with `failed`
    // listing the per-order failures on partial failure).
    overridePickingOrdersStatus: async (ids: string[], status: string, reason?: string): Promise<void> => {
      const failed: { id: string; message: string }[] = [];
      for (const id of ids) {
        try {
          await api.patch(`/admin/picking-orders/${id}/status`, {
            status,
            ...(reason?.trim() ? { reason: reason.trim() } : {}),
          });
        } catch (e: any) {
          failed.push({ id, message: e?.message ?? String(e) });
        }
      }
      if (failed.length > 0) {
        const err = new Error(failed.map((f) => `${f.id}: ${f.message}`).join("; "));
        (err as any).failed = failed;
        throw err;
      }
    },
    // Batch status override on the receiving order list: one PATCH per id
    // (same overridePickingOrdersStatus contract — attempts every id, throws
    // with `failed` listing the per-order failures on partial failure).
    overrideReceivingOrdersStatus: async (ids: string[], status: string, reason?: string): Promise<void> => {
      const failed: { id: string; message: string }[] = [];
      for (const id of ids) {
        try {
          await api.patch(`/admin/receiving-orders/${id}/status`, {
            status,
            ...(reason?.trim() ? { reason: reason.trim() } : {}),
          });
        } catch (e: any) {
          failed.push({ id, message: e?.message ?? String(e) });
        }
      }
      if (failed.length > 0) {
        const err = new Error(failed.map((f) => `${f.id}: ${f.message}`).join("; "));
        (err as any).failed = failed;
        throw err;
      }
    },
  };
}
