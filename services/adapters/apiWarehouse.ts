import type {
  WarehouseService,
  CreateWarehouseServiceOptions,
} from "../warehouse";

export function createApiWarehouseService(
  _options: CreateWarehouseServiceOptions
): WarehouseService {
  const notImplemented = async (): Promise<never> => {
    throw new Error("not implemented");
  };

  return {
    getReceivingOrders: notImplemented,
    getReceivingOrder: notImplemented,
    confirmReceivingOrderArrived: notImplemented,
    getActiveMismatch: notImplemented,
    reportMismatch: notImplemented,
    editMismatch: notImplemented,
    confirmMismatch: notImplemented,
    cancelMismatch: notImplemented,
    getPickingOrdersByReceivingOrder: notImplemented,
    getPickingItemTransitionLogs: notImplemented,
    createShippingBoxForPickingOrder: notImplemented,
    addPackageToBox: notImplemented,
    removePackageFromBox: notImplemented,
    removeScannedPackage: notImplemented,
    getPickingOrders: notImplemented,
    getPickingOrder: notImplemented,
    finishPickingOrder: notImplemented,
    reportPickingOrderIssues: notImplemented,
    scanAllocation: notImplemented,
    applyOcrPick: notImplemented,
    addAllUnboxedPackagesToBox: notImplemented,
    cancelShippingBox: notImplemented,
    getPutAwayCandidates: notImplemented,
    getPutAwayLots: notImplemented,
    getPutAwayScans: notImplemented,
    getShelfBoxesForReceivingOrder: notImplemented,
    getShelves: notImplemented,
    recordPutAwayScan: notImplemented,
    assignPutAwayScanToBox: notImplemented,
    removePutAwayScanFromBox: notImplemented,
    removePutAwayScannedPiece: notImplemented,
    createShelfBox: notImplemented,
    closeShelfBox: notImplemented,
    cancelShelfBox: notImplemented,
    getMeasuringTasks: notImplemented,
    getMeasuringTask: notImplemented,
    getShippingBoxForMeasuring: notImplemented,
    findMatchingUnverifiedPackage: notImplemented,
    verifyPickingPackage: notImplemented,
    updateShippingBox: notImplemented,
    closeShippingBox: notImplemented,
    completeMeasuringTask: notImplemented,
    getShelvesWithBoxes: notImplemented,
    getShelfBoxes: notImplemented,
    getShelfBox: notImplemented,
    verifyShelfBoxItem: notImplemented,
    markShelfBoxVerified: notImplemented,
    getSuppliersWithInventoryStats: notImplemented,
    getPartsBySupplier: notImplemented,
    getInventoryLotsForParts: notImplemented,
  };
}
