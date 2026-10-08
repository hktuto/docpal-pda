import type {
  ReceivingFilter,
  ReceivingOrderListQuery,
  PickingOrderListQuery,
  ListPage,
  ReceivingOrderListRow,
  ReceivingOrderDetail,
  ReceivingPickingSection,
  ReceivingScanInput,
  ReceivingScanResult,
  ReceivingItemMismatch,
  ReportMismatchInput,
  PickingOrderListRow,
  PickingOrderDetail,
  PickingWorkLock,
  ScanPickingItemInput,
  PickingShelfStockQuery,
  ShippingBoxUpdateInput,
  ReportPickingIssueEntry,
  ReportPickingIssuesResult,
  PutAwayCandidate,
  PutAwayDetail,
  PutAwayTaskDetail,
  PutAwayTaskListRow,
  PutAwayScanResult,
  ScanPickingItemResult,
  ScanIntoShippingBoxResult,
  Shelf,
  MeasuringBoxListRow,
  MeasuringBoxDetail,
  VerifyTaskListRow,
  VerifyTaskDetail,
  FlowConfig,
  GoodsVerifyTaskListRow,
  GoodsVerifyTaskDetail,
  GoodsVerifyTaskFilters,
  StockSearchFilters,
  StockSearchResult,
  StockSearchPageResult,
  StockSearchOptions,
  StockSearchSummary,
  SupplierListRow,
  CountryRow,
  SupplierQrcodeTemplate,
  BoxSearchResult,
  LabelsData,
  AdHocPutAwayItem,
  AdHocPutAwayResult,
  AdHocPutAwayLocation,
} from "./types";
import { createBackendWarehouseService } from "./adapters/backendWarehouse";

export interface WarehouseService {
  // Receiving
  getReceivingOrders(filter: ReceivingFilter, query?: ReceivingOrderListQuery): Promise<ListPage<ReceivingOrderListRow>>;
  getReceivingOrder(id: string): Promise<ReceivingOrderDetail>;
  confirmReceivingOrderArrived(id: string): Promise<void>;
  scanReceiving(orderId: string, input: ReceivingScanInput): Promise<ReceivingScanResult>;

  // Mismatches (item-keyed: every call addresses the receiving invoice ITEM id)
  getActiveMismatch(itemId: string): Promise<ReceivingItemMismatch | null>;
  reportMismatch(itemId: string, input: ReportMismatchInput): Promise<void>;
  editMismatch(itemId: string, input: ReportMismatchInput): Promise<void>;
  confirmMismatch(itemId: string): Promise<void>;
  cancelMismatch(itemId: string): Promise<void>;

  // Picking (receiving detail view — nested orders with items/boxes/logs embedded)
  getPickingOrdersByReceivingOrder(id: string): Promise<ReceivingPickingSection>;

  // Picking — nested detail read; mutations mirror the backend verbs
  // one-to-one (docs/backend/api-design.md §Picking). The shipping-box
  // verbs are shared with the receiving picking tab and the measuring flow.
  getPickingOrders(query?: PickingOrderListQuery): Promise<ListPage<PickingOrderListRow>>;
  getPickingOrder(id: string): Promise<PickingOrderDetail>;
  scanPickingItem(
    itemId: string,
    input: ScanPickingItemInput
  ): Promise<ScanPickingItemResult>;
  // require-match scan-time presence check: stock of the part at the shelf.
  getPickingShelfStock(query: PickingShelfStockQuery): Promise<{ qty: number }>;
  removeScannedPackage(packageId: string): Promise<void>;
  // Whole-box exact-match claim: reuse a shelf carton as the shipping box.
  claimShelfBox(orderId: string, shelfBoxId: string): Promise<{ shippingBoxId: string; packageIds: string[] }>;
  verifyPackage(packageId: string, qty?: number): Promise<void>;
  createShippingBoxForPickingOrder(pickingOrderId: string, boxId?: string): Promise<void>;
  updateShippingBox(id: string, fields: ShippingBoxUpdateInput): Promise<void>;
  addPackageToBox(packageId: string, boxId: string): Promise<void>;
  removePackageFromBox(boxId: string, packageId: string): Promise<void>;
  addAllUnboxedPackagesToBox(boxId: string): Promise<number>;
  cancelShippingBox(id: string): Promise<void>;
  closeShippingBox(id: string): Promise<void>;
  // Cross-order packing: scan ANY order's item barcode straight into this
  // open box (404 no_matching_picking_item / 409 ambiguous_picking_item).
  // dateCode = the label's parsed date code (drives the backend's outdated
  // date-code warning on this path).
  scanIntoShippingBox(
    shippingBoxId: string,
    input: { barcode: string; qty?: number; dateCode?: string | null }
  ): Promise<ScanIntoShippingBoxResult>;
  // Explicit finish: all items fully boxed → order finished. Boxing the
  // last package also auto-finishes (no task is created either way).
  finishPickingOrder(id: string): Promise<{ id: string; status: string }>;
  reportPickingOrderIssues(
    entries: ReportPickingIssueEntry[]
  ): Promise<ReportPickingIssuesResult>;

  // Page-driven work lock: acquire/refresh while the order page is open
  // (throws ApiError 409 with body {error: "lock_held", holderName} when held
  // by another user); release is fire-and-forget on page leave.
  acquirePickingWorkLock(id: string): Promise<PickingWorkLock>;
  releasePickingWorkLock(id: string): void;

  // Put-away — one aggregate read replaces the old lots/scans/boxes stitch;
  // scan matching stays client-side (QR templates), mutations are per-verb.
  getPutAwayCandidates(): Promise<PutAwayCandidate[]>;
  getPutAwayDetail(receivingOrderId: string): Promise<PutAwayDetail>;
  // Put-away tasks (GET /put-away-tasks*) — the auto-created work queue used
  // when the backend's putAway.autoCreateTasks config is on; the detail is
  // the same aggregate plus the task row and per-item shelf hints.
  listPutAwayTasks(status?: string): Promise<PutAwayTaskListRow[]>;
  getPutAwayTaskDetail(id: string): Promise<PutAwayTaskDetail>;
  getShelves(): Promise<Shelf[]>;
  // Scans with a shelfCode commit straight onto that shelf in the same tx
  // (the order's invisible box there is found-or-created backend-side — spec
  // 2026-10-06); without one the scan waits in the pending (staging) list.
  recordPutAwayScan(
    receivingOrderId: string,
    receivingInvoiceItemId: string,
    qty: number,
    dateCode: string | null,
    lotCode: string | null,
    coo: string | null,
    cow: string | null,
    shelfCode?: string | null,
    /** Supplier-template serial (e.g. iC-Haus LTS); the backend rejects a
     *  repeat serial on the same order with 409 label_already_scanned. */
    serialNo?: string | null
  ): Promise<PutAwayScanResult>;
  // Commit pending scans onto a shelf in one tx (all of them, or just the
  // given scanIds for the pending list's per-row "Add to shelf").
  commitPutAwayToShelf(
    receivingOrderId: string,
    shelfCode: string,
    scanIds?: string[]
  ): Promise<{ count: number; qty: number }>;
  removePutAwayScannedPiece(scanId: string): Promise<void>;
  /** Reverse a committed scan: the stock leaves the shelf (lot + ledger
   *  reversal); 409 lot_has_pick_allocations when the lot feeds picks. */
  removePutAwayScanFromShelf(scanId: string, boxId: string): Promise<void>;

  // Measuring — box-scoped (no tasks): the list is the open boxes with
  // ≥1 package (any order); the detail is one box plus its packages. Box
  // measurement reuses the shared picking verbs above (verifyPackage /
  // updateShippingBox / closeShippingBox) — closing IS completion.
  // Scanned labels are matched to packages client-side.
  getMeasuringBoxes(): Promise<MeasuringBoxListRow[]>;
  getMeasuringBox(boxId: string): Promise<MeasuringBoxDetail>;

  // Verify — the second measuring pass, one task per shipping box
  // (GET /verify-tasks* is box-keyed). Reopen flips a closed box back to
  // open (packages un-verified) so the worker can re-measure during a
  // pending verify task.
  getVerifyTasks(status?: string): Promise<VerifyTaskListRow[]>;
  getVerifyTask(id: string): Promise<VerifyTaskDetail>;
  completeVerifyTask(id: string): Promise<void>;
  reopenShippingBox(boxId: string): Promise<void>;

  // Flow config (GET /config) — which home tiles the backend's flow config
  // (warehouse_config row "flow") disables, plus the picking allocation
  // policy (allowDockStock).
  getFlowConfig(): Promise<FlowConfig>;

  // Goods verify — task-based (docs/backend/api-design.md §Goods verify).
  // Tasks are generated by the backend day-end cron job (no client trigger);
  // verify is one call per task (countedQty optional; a mismatch corrects the
  // lot and writes an ADJUST ledger row server-side).
  getGoodsVerifyTasks(filters?: GoodsVerifyTaskFilters): Promise<GoodsVerifyTaskListRow[]>;
  getGoodsVerifyTask(id: string): Promise<GoodsVerifyTaskDetail>;
  verifyGoodsVerifyTask(id: string, countedQty?: number): Promise<GoodsVerifyTaskListRow>;

  // Supplier QR templates for client-side label parsing (GET /scan-templates)
  getSupplierQrTemplates(): Promise<SupplierQrcodeTemplate[]>;

  // Stock search — one aggregate read (GET /stock-search) replaces the old
  // suppliers → parts → lots cascade; zero-qty lots come back by design.
  // The filter set mirrors the admin console so both surfaces query the
  // same way. The admin suppliers CRUD read doubles as the supplier filter
  // dropdown (same trick as getShelves).
  searchStock(filters?: StockSearchFilters): Promise<StockSearchResult>;
  /** Paged lot rows (`?page=&pageSize=`) for the mobile load-more list. */
  searchStockPage(
    filters: StockSearchFilters,
    page: number,
    pageSize: number
  ): Promise<StockSearchPageResult>;
  // Distinct filter values present in the current stock (brands, zones,
  // shelves, locations) — locations are limited to the caller's user scope.
  getStockSearchOptions(): Promise<StockSearchOptions>;
  // Filtered totals (items / on-hand / available) for the summary strip.
  getStockSearchSummary(filters?: StockSearchFilters): Promise<StockSearchSummary>;
  getSuppliers(): Promise<SupplierListRow[]>;
  // Country list for the COO/COW dropdowns (admin CRUD read, code = ISO alpha-2).
  getCountries(): Promise<CountryRow[]>;

  // Box lookup for the /box QR page — searches both box tables by id
  // substring (a bare daily seq like "0007" matches).
  searchBoxes(q: string): Promise<BoxSearchResult[]>;

  // Printable-label data for the /print-labels page (GET /labels-data).
  getLabelsData(): Promise<LabelsData>;

  // Ad-hoc put-away (spec 2026-10-07-ad-hoc-put-away-design.md) — items
  // with no receiving order put away directly to a shelf. The PDA holds the
  // in-progress scan list in local state; the backend only sees the confirmed
  // batch.
  getAdHocPutAwayLocations(): Promise<AdHocPutAwayLocation[]>;
  commitAdHocPutAway(input: {
    supplierCode: string;
    shelfCode: string;
    items: AdHocPutAwayItem[];
  }): Promise<AdHocPutAwayResult>;
}

export interface CreateWarehouseServiceOptions {
  apiBaseUrl?: string;
}

export function createWarehouseService(
  options: CreateWarehouseServiceOptions
): WarehouseService {
  return createBackendWarehouseService(options);
}
