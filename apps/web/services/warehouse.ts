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
  ShelfBox,
  Shelf,
  MeasuringTaskListRow,
  MeasuringTaskDetail,
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
  verifyPackage(packageId: string): Promise<void>;
  createShippingBoxForPickingOrder(pickingOrderId: string, boxId?: string): Promise<void>;
  updateShippingBox(id: string, fields: ShippingBoxUpdateInput): Promise<void>;
  addPackageToBox(packageId: string, boxId: string): Promise<void>;
  removePackageFromBox(boxId: string, packageId: string): Promise<void>;
  addAllUnboxedPackagesToBox(boxId: string): Promise<number>;
  cancelShippingBox(id: string): Promise<void>;
  closeShippingBox(id: string): Promise<void>;
  finishPickingOrder(
    id: string
  ): Promise<{ id: string; pickingOrderId: string; status: string }>;
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

  // Measuring — the consolidated detail (task + order + boxes with
  // packages) feeds both the task page and the box page; box measurement
  // reuses the picking verbs above (verifyPackage / updateShippingBox /
  // closeShippingBox). Scanned labels are matched to packages client-side.
  getMeasuringTasks(status?: string): Promise<MeasuringTaskListRow[]>;
  getMeasuringTask(id: string): Promise<MeasuringTaskDetail>;
  completeMeasuringTask(id: string): Promise<void>;

  // Verify — the second measuring pass (GET /verify-tasks* mirrors
  // /measuring-tasks*). Reopen flips a closed box back to open (packages
  // un-verified) so the worker can re-measure during a pending verify task.
  getVerifyTasks(status?: string): Promise<VerifyTaskListRow[]>;
  getVerifyTask(id: string): Promise<VerifyTaskDetail>;
  completeVerifyTask(id: string): Promise<void>;
  reopenShippingBox(boxId: string): Promise<void>;

  // Flow-step config (GET /config) — which home tiles the backend's
  // FLOW_STEPS_DISABLED env var disables.
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
}

export interface CreateWarehouseServiceOptions {
  apiBaseUrl?: string;
}

export function createWarehouseService(
  options: CreateWarehouseServiceOptions
): WarehouseService {
  return createBackendWarehouseService(options);
}
