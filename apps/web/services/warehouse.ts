import type {
  ReceivingFilter,
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
  ShippingBoxUpdateInput,
  ReportPickingIssueEntry,
  ReportPickingIssuesResult,
  PutAwayCandidate,
  PutAwayDetail,
  PutAwayScan,
  PutAwayTaskDetail,
  PutAwayTaskListRow,
  ShelfBox,
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
  SupplierListRow,
  SupplierQrcodeTemplate,
  BoxSearchResult,
  LabelsData,
} from "./types";
import { createBackendWarehouseService } from "./adapters/backendWarehouse";

export interface WarehouseService {
  // Receiving
  getReceivingOrders(filter: ReceivingFilter): Promise<ReceivingOrderListRow[]>;
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
  getPickingOrders(status?: string): Promise<PickingOrderListRow[]>;
  getPickingOrder(id: string): Promise<PickingOrderDetail>;
  scanPickingItem(
    itemId: string,
    input: ScanPickingItemInput
  ): Promise<{ packageIds: string[] }>;
  removeScannedPackage(packageId: string): Promise<void>;
  // Whole-box exact-match claim: reuse a shelf carton as the shipping box.
  claimShelfBox(orderId: string, shelfBoxId: string): Promise<{ shippingBoxId: string; packageIds: string[] }>;
  verifyPackage(packageId: string): Promise<void>;
  createShippingBoxForPickingOrder(pickingOrderId: string, boxId?: string): Promise<void>;
  updateShippingBox(id: string, fields: ShippingBoxUpdateInput): Promise<void>;
  addPackageToBox(packageId: string, boxId: string): Promise<void>;
  removePackageFromBox(boxId: string, packageId: string): Promise<void>;
  addAllUnboxedPackagesToBox(boxId: string): Promise<number>;
  cancelShippingBox(id: string): Promise<void>;
  closeShippingBox(id: string): Promise<void>;
  // Cross-order packing: scan ANY order's item barcode straight into this
  // open box (404 no_matching_picking_item / 409 ambiguous_picking_item).
  scanIntoShippingBox(
    shippingBoxId: string,
    input: { barcode: string; qty?: number }
  ): Promise<{ packageIds: string[] }>;
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
  recordPutAwayScan(
    receivingOrderId: string,
    receivingInvoiceItemId: string,
    qty: number,
    dateCode: string | null,
    lotCode: string | null,
    coo: string | null,
    cow: string | null,
    shelfBoxId?: string | null
  ): Promise<PutAwayScan>;
  assignPutAwayScanToBox(scanId: string, boxId: string): Promise<void>;
  addAllUnboxedScansToBox(boxId: string): Promise<number>;
  removePutAwayScanFromBox(scanId: string, boxId: string): Promise<void>;
  removePutAwayScannedPiece(scanId: string): Promise<void>;
  createShelfBox(receivingOrderId: string, shelfCode: string, boxId?: string): Promise<ShelfBox>;
  closeShelfBox(id: string): Promise<void>;
  cancelShelfBox(id: string): Promise<void>;

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

  // Demo reset (dev only)
  resetDemoData(): Promise<void>;

  // Stock search — one aggregate read (GET /stock-search) replaces the old
  // suppliers → parts → lots cascade; zero-qty lots come back by design.
  // The admin suppliers CRUD read doubles as the filter dropdown list
  // (same trick as getShelves).
  searchStock(filters?: StockSearchFilters): Promise<StockSearchResult>;
  getSuppliers(): Promise<SupplierListRow[]>;

  // Box lookup for the /box QR page — searches both box tables by id
  // substring (a bare daily seq like "0007" matches).
  searchBoxes(q: string): Promise<BoxSearchResult[]>;

  // Printable-label data for the /print-labels page (GET /labels-data).
  getLabelsData(): Promise<LabelsData>;
}

export interface CreateWarehouseServiceOptions {
  apiBaseUrl?: string;
}

export function createWarehouseService(
  options: CreateWarehouseServiceOptions
): WarehouseService {
  return createBackendWarehouseService(options);
}
