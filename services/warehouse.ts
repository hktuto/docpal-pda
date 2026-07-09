import type {
  ReceivingFilter,
  ReceivingOrderSummary,
  ReceivingOrderDetail,
  ReceivingItemMismatch,
  ReportMismatchInput,
  PickingByReceivingRow,
  TransitionLog,
  PickingOrderSummary,
  PickingOrderDetail,
  ReportPickingIssueEntry,
  ReportPickingIssuesInput,
  ReportPickingIssuesResult,
  ApplyOcrPickInput,
  PutAwayCandidate,
  PutAwayLot,
  PutAwayScan,
  ShelfBox,
  Shelf,
  MeasuringTaskSummary,
  MeasuringTaskDetail,
  ShippingBoxForMeasuring,
  BoxMeasurementsInput,
  PackageVerificationInput,
  MeasuringPackage,
  ShelfWithBoxCount,
  GoodsVerifyShelfBoxSummary,
  GoodsVerifyShelfBoxDetail,
  StockSearchSupplierWithStats,
  StockSearchPart,
  StockSearchInventoryLot,
} from "./types";
import { createPgliteWarehouseService } from "./adapters/pgliteWarehouse";
import { createApiWarehouseService } from "./adapters/apiWarehouse";

export interface WarehouseService {
  // Receiving
  getReceivingOrders(filter: ReceivingFilter): Promise<ReceivingOrderSummary[]>;
  getReceivingOrder(id: string): Promise<ReceivingOrderDetail>;
  confirmReceivingOrderArrived(id: string): Promise<void>;

  // Mismatches
  getActiveMismatch(itemId: string): Promise<ReceivingItemMismatch | null>;
  reportMismatch(itemId: string, input: ReportMismatchInput): Promise<void>;
  editMismatch(mismatchId: string, input: ReportMismatchInput): Promise<void>;
  confirmMismatch(mismatchId: string): Promise<void>;
  cancelMismatch(mismatchId: string): Promise<void>;

  // Picking (receiving detail view)
  getPickingOrdersByReceivingOrder(id: string): Promise<PickingByReceivingRow[]>;
  getPickingItemTransitionLogs(ids: string[]): Promise<TransitionLog[]>;
  createShippingBoxForPickingOrder(pickingOrderId: string): Promise<void>;
  addPackageToBox(packageId: string, boxId: string): Promise<void>;
  removePackageFromBox(packageId: string): Promise<void>;
  removeScannedPackage(packageId: string): Promise<void>;

  // Picking
  getPickingOrders(): Promise<PickingOrderSummary[]>;
  getPickingOrder(id: string): Promise<PickingOrderDetail>;
  finishPickingOrder(id: string): Promise<void>;
  reportPickingOrderIssues(
    entries: ReportPickingIssueEntry[],
    input: ReportPickingIssuesInput
  ): Promise<ReportPickingIssuesResult>;
  scanAllocation(id: string, qty: number): Promise<string>;
  applyOcrPick(input: ApplyOcrPickInput): Promise<void>;
  addAllUnboxedPackagesToBox(boxId: string): Promise<number>;
  cancelShippingBox(id: string): Promise<void>;

  // Put-away
  getPutAwayCandidates(): Promise<PutAwayCandidate[]>;
  getPutAwayLots(receivingOrderId: string): Promise<PutAwayLot[]>;
  getPutAwayScans(receivingOrderId: string): Promise<PutAwayScan[]>;
  getShelfBoxesForReceivingOrder(receivingOrderId: string): Promise<ShelfBox[]>;
  getShelves(): Promise<Shelf[]>;
  recordPutAwayScan(
    receivingInvoiceItemId: string,
    qty: number,
    dateCode: string | null,
    lotCode: string | null,
    coo: string | null,
    cow: string | null
  ): Promise<PutAwayScan>;
  assignPutAwayScanToBox(scanId: string, boxId: string): Promise<void>;
  removePutAwayScanFromBox(scanId: string): Promise<void>;
  removePutAwayScannedPiece(scanId: string): Promise<void>;
  createShelfBox(receivingOrderId: string, shelfCode: string): Promise<ShelfBox>;
  closeShelfBox(id: string): Promise<void>;
  cancelShelfBox(id: string): Promise<void>;

  // Measuring
  getMeasuringTasks(): Promise<MeasuringTaskSummary[]>;
  getMeasuringTask(id: string): Promise<MeasuringTaskDetail>;
  getShippingBoxForMeasuring(id: string): Promise<ShippingBoxForMeasuring>;
  findMatchingUnverifiedPackage(
    boxId: string,
    input: PackageVerificationInput,
    targetPackageId?: string
  ): Promise<MeasuringPackage | null>;
  verifyPickingPackage(packageId: string): Promise<void>;
  updateShippingBox(id: string, fields: BoxMeasurementsInput): Promise<void>;
  closeShippingBox(id: string): Promise<void>;
  completeMeasuringTask(id: string): Promise<void>;

  // Goods verify
  getShelvesWithBoxes(): Promise<ShelfWithBoxCount[]>;
  getShelfBoxes(shelfCode: string): Promise<GoodsVerifyShelfBoxSummary[]>;
  getShelfBox(id: string): Promise<GoodsVerifyShelfBoxDetail>;
  verifyShelfBoxItem(shelfBoxId: string, partId: string): Promise<void>;
  markShelfBoxVerified(id: string): Promise<void>;

  // Stock search
  getSuppliersWithInventoryStats(): Promise<StockSearchSupplierWithStats[]>;
  getPartsBySupplier(supplierId: string): Promise<StockSearchPart[]>;
  getInventoryLotsForParts(partIds: string[]): Promise<StockSearchInventoryLot[]>;
}

export interface CreateWarehouseServiceOptions {
  adapter: "pglite" | "api";
  getActorId: () => string | undefined;
  apiBaseUrl?: string;
}

export function createWarehouseService(
  options: CreateWarehouseServiceOptions
): WarehouseService {
  if (options.adapter === "pglite") {
    return createPgliteWarehouseService(options);
  }
  return createApiWarehouseService(options);
}
