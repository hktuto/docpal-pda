import { sql, eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { useDb } from "~/composables/useDb";
import { availableReceivingQtySql, allocationsCte } from "~/db/helpers";
import {
  getReceivingOrderDetail,
  confirmReceivingOrderArrived as dbConfirmReceivingOrderArrived,
} from "~/db/receiving";
import {
  getActiveMismatchForItem,
  getActiveMismatchesForItems,
  reportReceivingItemMismatch,
  editReceivingItemMismatch,
  confirmReceivingItemMismatch,
  cancelReceivingItemMismatch,
} from "~/db/mismatch";
import {
  getPickingOrdersByReceivingOrder as dbGetPickingOrdersByReceivingOrder,
  getPickingItemTransitionLogs as dbGetPickingItemTransitionLogs,
  getPickingOrderDetail,
  createShippingBoxForPickingOrder as dbCreateShippingBoxForPickingOrder,
  addPackageToBox as dbAddPackageToBox,
  removePackageFromBox as dbRemovePackageFromBox,
  removeScannedPackage as dbRemoveScannedPackage,
  scanAllocationToPackage as dbScanAllocationToPackage,
  finishPickingOrder as dbFinishPickingOrder,
  reportPickingOrderIssues as dbReportPickingOrderIssues,
  cancelShippingBox as dbCancelShippingBox,
  addAllUnboxedPackagesToBox as dbAddAllUnboxedPackagesToBox,
} from "~/db/picking";
import {
  applyOcrPick as dbApplyOcrPick,
} from "~/db/ocrPicking";
import {
  getPutAwayCandidates as dbGetPutAwayCandidates,
  getPutAwayLots as dbGetPutAwayLots,
  getPutAwayScansForReceivingOrder as dbGetPutAwayScansForReceivingOrder,
  getShelfBoxesForReceivingOrder as dbGetShelfBoxesForReceivingOrder,
  recordPutAwayScan as dbRecordPutAwayScan,
  assignScanToBox as dbAssignScanToBox,
  removeScanFromBox as dbRemoveScanFromBox,
  removeScannedPiece as dbRemoveScannedPiece,
  createShelfBox as dbCreateShelfBox,
  closeShelfBox as dbCloseShelfBox,
  cancelShelfBox as dbCancelShelfBox,
} from "~/db/putAway";
import {
  getMeasuringTasks as dbGetMeasuringTasks,
  getMeasuringTaskDetail as dbGetMeasuringTaskDetail,
  getShippingBoxForMeasuring as dbGetShippingBoxForMeasuring,
  findMatchingUnverifiedPackage as dbFindMatchingUnverifiedPackage,
  verifyPickingPackageForMeasuring as dbVerifyPickingPackageForMeasuring,
  updateShippingBox as dbUpdateShippingBox,
  closeShippingBox as dbCloseShippingBox,
  completeMeasuringTask as dbCompleteMeasuringTask,
} from "~/db/measuring";
import {
  getShelvesWithBoxes as dbGetShelvesWithBoxes,
  getShelfBoxesByShelf as dbGetShelfBoxesByShelf,
  getShelfBoxDetail as dbGetShelfBoxDetail,
  verifyShelfBoxScans as dbVerifyShelfBoxScans,
  markShelfBoxVerified as dbMarkShelfBoxVerified,
} from "~/db/goodsVerify";
import {
  getSuppliersWithInventoryStats as dbGetSuppliersWithInventoryStats,
  getPartsBySupplierId as dbGetPartsBySupplierId,
  getInventoryLotsForParts as dbGetInventoryLotsForParts,
} from "~/db/stockSearch";
import { I18nError } from "~/composables/i18nError";
import type { CreateWarehouseServiceOptions, WarehouseService } from "../warehouse";
import type {
  Supplier,
  Part,
  ReceivingFilter,
  ReceivingOrderStatus,
  ReceivingOrderSummary,
  ReceivingOrderDetail,
  ReceivingItem,
  ReceivingItemWithMismatch,
  ReceivingItemMismatch,
  ReceivingInvoice,
  ReportMismatchInput,
  PickingByReceivingRow,
  TransitionLog,
  DisplayPackage,
  DisplayBox,
  PickingOrderStatus,
  PickingOrderSummary,
  PickingOrderDetail,
  PickingItem,
  PickingAllocation,
  PickingPackage,
  ShippingBox,
  ReportPickingIssueEntry,
  ReportPickingIssuesInput,
  ReportPickingIssuesResult,
  ApplyOcrPickInput,
  PutAwayCandidate,
  PutAwayLot,
  PutAwayScan,
  ShelfBox,
  ShelfBoxItem,
  Shelf,
  MeasuringTaskStatus,
  BoxStatus,
  MeasuringTaskSummary,
  MeasuringTaskDetail,
  MeasuringPickingOrder,
  MeasuringPickingItem,
  MeasuringAllocation,
  MeasuringShippingBox,
  MeasuringPackage,
  ShippingBoxForMeasuring,
  BoxMeasurementsInput,
  PackageVerificationInput,
  ShelfWithBoxCount,
  GoodsVerifyShelfBoxSummary,
  GoodsVerifyShelfBoxDetail,
  GoodsVerifyShelfBoxItem,
  StockSearchSupplierWithStats,
  StockSearchPart,
  StockSearchInventoryLot,
} from "../types";

type DbPickingOrderDetail = NonNullable<Awaited<ReturnType<typeof getPickingOrderDetail>>>;

function toSupplier(row: typeof schema.suppliers.$inferSelect): Supplier {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    qrcodeTemplate: row.qrcodeTemplate ?? null,
    qrcodeQtyEncoding: row.qrcodeQtyEncoding ?? null,
  };
}

function toPart(row: typeof schema.parts.$inferSelect): Part {
  return {
    id: row.id,
    partNo: row.partNo,
    internalCode: row.internalCode ?? null,
    description: row.description ?? null,
    defaultCoo: row.defaultCoo ?? null,
  };
}

function toReceivingItem(
  row: typeof schema.receivingInvoiceItems.$inferSelect & {
    part?: typeof schema.parts.$inferSelect | null;
  }
): ReceivingItem {
  return {
    id: row.id,
    receivingInvoiceId: row.receivingInvoiceId,
    partId: row.partId,
    poNo: row.poNo ?? null,
    poLine: row.poLine ?? null,
    qty: row.qty,
    receivedQty: row.receivedQty,
    pickedQty: row.pickedQty,
    putAwayQty: row.putAwayQty,
    boxId: row.boxId ?? null,
    dateCode: row.dateCode ?? null,
    lotCode: row.lotCode ?? null,
    coo: row.coo ?? null,
    cow: row.cow ?? null,
    part: row.part ? toPart(row.part) : null,
  };
}

function toReceivingItemMismatch(
  row: typeof schema.receivingItemMismatches.$inferSelect
): ReceivingItemMismatch {
  return {
    id: row.id,
    receivingInvoiceItemId: row.receivingInvoiceItemId,
    reason: row.reason,
    mismatchQty: row.mismatchQty ?? null,
    wrongPartNo: row.wrongPartNo ?? null,
    note: row.note ?? null,
    status: row.status,
    effectiveReceivedQty: row.effectiveReceivedQty,
    previousReceivedQty: row.previousReceivedQty,
    reportedBy: row.reportedBy ?? null,
    reportedAt: row.reportedAt,
    confirmedBy: row.confirmedBy ?? null,
    confirmedAt: row.confirmedAt ?? null,
    cancelledBy: row.cancelledBy ?? null,
    cancelledAt: row.cancelledAt ?? null,
  };
}

function toPickingPackage(pkg: DbPickingOrderDetail["items"][number]["packages"][number]): PickingPackage {
  return {
    id: pkg.id,
    pickingItemId: pkg.pickingItemId,
    pickingOrderId: pkg.pickingOrderId,
    qty: pkg.qty,
    shippingBoxId: pkg.shippingBoxId ?? null,
    dateCode: pkg.dateCode ?? null,
    lotCode: pkg.lotCode ?? null,
    coo: pkg.coo ?? null,
    cow: pkg.cow ?? null,
    createdAt: pkg.createdAt,
  };
}

function toPickingAllocation(
  allocation: DbPickingOrderDetail["items"][number]["allocations"][number]
): PickingAllocation {
  return {
    id: allocation.id,
    pickingItemId: allocation.pickingItemId,
    qty: allocation.qty,
    inventoryLot: allocation.inventoryLot
      ? {
          id: allocation.inventoryLot.id,
          partId: allocation.inventoryLot.partId,
          dateCode: allocation.inventoryLot.dateCode ?? null,
          lotCode: allocation.inventoryLot.lotCode ?? null,
          coo: allocation.inventoryLot.coo ?? null,
          cow: allocation.inventoryLot.cow ?? null,
          shelfCode: allocation.inventoryLot.shelfCode ?? null,
          boxId: allocation.inventoryLot.boxId ?? null,
        }
      : null,
    receivingOrder: allocation.receivingOrder
      ? {
          id: allocation.receivingOrder.id,
          refNo: allocation.receivingOrder.refNo,
        }
      : null,
    pickingItem: allocation.pickingItem
      ? {
          id: allocation.pickingItem.id,
          part: allocation.pickingItem.part ? toPart(allocation.pickingItem.part) : null,
        }
      : null,
  };
}

function toPickingItem(item: DbPickingOrderDetail["items"][number]): PickingItem {
  return {
    id: item.id,
    pickingOrderId: item.pickingOrderId,
    partId: item.partId,
    qty: item.qty,
    pickedQty: item.pickedQty,
    allocatedQty: item.allocatedQty,
    requiredDateCode: item.requiredDateCode ?? null,
    sourceShelfCode: item.sourceShelfCode ?? null,
    part: item.part ? toPart(item.part) : null,
    allocations: item.allocations.map(toPickingAllocation),
    packages: item.packages.map(toPickingPackage),
  };
}

function toShippingBox(box: DbPickingOrderDetail["shippingBoxes"][number]): ShippingBox {
  return {
    id: box.id,
    pickingOrderId: box.pickingOrderId,
    status: box.status,
    packages: box.packages.map(toPickingPackage),
  };
}

function toPickingOrderDetail(data: DbPickingOrderDetail): PickingOrderDetail {
  return {
    id: data.id,
    refNo: data.refNo,
    status: data.status as PickingOrderStatus,
    deliveryDate: data.deliveryDate ?? null,
    supplier: data.supplier ? toSupplier(data.supplier) : null,
    poNo: data.poNo ?? null,
    shipTo: data.shipTo ?? null,
    destinationCountry: data.destinationCountry ?? null,
    requiredDateCodeNotice: data.requiredDateCodeNotice ?? null,
    items: data.items.map(toPickingItem),
    shippingBoxes: data.shippingBoxes.map(toShippingBox),
    measuringTask: data.measuringTask
      ? { id: data.measuringTask.id, status: data.measuringTask.status }
      : null,
    issueReason: data.issueReason ?? null,
    issueQty: data.issueQty ?? null,
    issuePackSize: data.issuePackSize ?? null,
    issueNote: data.issueNote ?? null,
    issueRemark: data.issueRemark ?? null,
    issueReportedAt: data.issueReportedAt ?? null,
    issueReportedBy: data.issueReportedBy ?? null,
    issueReportedByUser: data.issueReportedByUser
      ? { displayName: data.issueReportedByUser.displayName }
      : null,
  };
}

function toPutAwayCandidate(row: {
  id: unknown;
  ref_no: unknown;
  status: unknown;
  supplier_name: unknown;
  available_qty: unknown;
}): PutAwayCandidate {
  return {
    id: String(row.id),
    refNo: String(row.ref_no),
    status: String(row.status),
    supplierName: row.supplier_name ? String(row.supplier_name) : null,
    availableQty: Number(row.available_qty ?? 0),
  };
}

function toPutAwayLot(row: {
  receiving_invoice_item_id: unknown;
  part_id: unknown;
  part_no: unknown;
  date_code: unknown;
  lot_code: unknown;
  coo: unknown;
  cow: unknown;
  total_qty: unknown;
  available_qty: unknown;
  scanned_qty: unknown;
  boxed_qty: unknown;
}): PutAwayLot {
  return {
    receivingInvoiceItemId: String(row.receiving_invoice_item_id),
    partId: String(row.part_id),
    partNo: row.part_no ? String(row.part_no) : null,
    dateCode: row.date_code ? String(row.date_code) : null,
    lotCode: row.lot_code ? String(row.lot_code) : null,
    coo: row.coo ? String(row.coo) : null,
    cow: row.cow ? String(row.cow) : null,
    totalQty: Number(row.total_qty ?? 0),
    availableQty: Number(row.available_qty ?? 0),
    scannedQty: Number(row.scanned_qty ?? 0),
    boxedQty: Number(row.boxed_qty ?? 0),
  };
}

function toPutAwayScan(row: typeof schema.putAwayScans.$inferSelect): PutAwayScan {
  return {
    id: row.id,
    receivingInvoiceItemId: row.receivingInvoiceItemId,
    partId: row.partId,
    qty: row.qty,
    dateCode: row.dateCode ?? null,
    lotCode: row.lotCode ?? null,
    coo: row.coo ?? null,
    cow: row.cow ?? null,
    shelfBoxId: row.shelfBoxId ?? null,
    verified: row.verified,
    verifiedAt: row.verifiedAt ?? null,
    createdAt: row.createdAt,
  };
}

function toShelfBoxItem(item: {
  id: string;
  partId: string;
  part: { partNo: string | null };
  qty: number;
  verified: boolean;
}): ShelfBoxItem {
  return {
    id: item.id,
    partId: item.partId,
    part: item.part,
    qty: item.qty,
    verified: item.verified,
  };
}

function toShelfBox(
  box: typeof schema.shelfBoxes.$inferSelect,
  items: ShelfBoxItem[]
): ShelfBox {
  return {
    id: box.id,
    receivingOrderId: box.receivingOrderId ?? "",
    shelfCode: box.shelfCode ?? null,
    status: box.status,
    createdAt: box.createdAt,
    items,
  };
}

function toShelf(row: typeof schema.shelves.$inferSelect): Shelf {
  return {
    code: row.code,
    zone: row.zone ?? null,
  };
}

function toGoodsVerifyShelfBoxItem(item: {
  id: string;
  shelfBoxId: string;
  receivingInvoiceItemId: string | null;
  partId: string;
  qty: number;
  verified: boolean;
  verifiedAt: Date | null;
  part: { id: string; partNo: string | null; description: string | null } | null;
}): GoodsVerifyShelfBoxItem {
  return {
    id: item.id,
    shelfBoxId: item.shelfBoxId,
    partId: item.partId,
    qty: item.qty,
    verified: item.verified,
    verifiedAt: item.verifiedAt,
    part: item.part
      ? { partNo: item.part.partNo, description: item.part.description }
      : null,
  };
}

function toGoodsVerifyShelfBoxDetail(data: NonNullable<Awaited<ReturnType<typeof dbGetShelfBoxDetail>>>): GoodsVerifyShelfBoxDetail {
  return {
    id: data.id,
    receivingOrderId: data.receivingOrderId,
    shelfCode: data.shelfCode,
    status: data.status as BoxStatus,
    createdAt: data.createdAt,
    shelf: data.shelf ? { code: data.shelf.code, zone: data.shelf.zone } : null,
    receivingOrder: data.receivingOrder,
    items: data.items.map(toGoodsVerifyShelfBoxItem),
  };
}

function toMeasuringPackage(pkg: {
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
    part: typeof schema.parts.$inferSelect | null;
  } | null;
}): MeasuringPackage {
  return {
    id: pkg.id,
    pickingItemId: pkg.pickingItemId,
    qty: pkg.qty,
    dateCode: pkg.dateCode ?? null,
    lotCode: pkg.lotCode ?? null,
    coo: pkg.coo ?? null,
    cow: pkg.cow ?? null,
    verified: pkg.verified,
    pickingItem: pkg.pickingItem
      ? {
          id: pkg.pickingItem.id,
          partId: pkg.pickingItem.partId,
          part: pkg.pickingItem.part ? toPart(pkg.pickingItem.part) : null,
        }
      : null,
  };
}

function toMeasuringAllocation(allocation: {
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
    part: typeof schema.parts.$inferSelect | null;
  } | null;
}): MeasuringAllocation {
  return {
    id: allocation.id,
    pickingItemId: allocation.pickingItemId,
    inventoryLotId: allocation.inventoryLotId ?? null,
    qty: allocation.qty,
    inventoryLot: allocation.inventoryLot
      ? {
          id: allocation.inventoryLot.id,
          partId: allocation.inventoryLot.partId,
          dateCode: allocation.inventoryLot.dateCode ?? null,
          lotCode: allocation.inventoryLot.lotCode ?? null,
          coo: allocation.inventoryLot.coo ?? null,
          cow: allocation.inventoryLot.cow ?? null,
          shelfCode: allocation.inventoryLot.shelfCode ?? null,
          boxId: allocation.inventoryLot.boxId ?? null,
          totalQty: allocation.inventoryLot.totalQty,
          allocatedQty: allocation.inventoryLot.allocatedQty,
          part: allocation.inventoryLot.part ? toPart(allocation.inventoryLot.part) : null,
        }
      : null,
  };
}

function toMeasuringPickingItem(item: {
  id: string;
  pickingOrderId: string;
  partId: string;
  qty: number;
  pickedQty: number;
  requiredDateCode: string | null;
  sourceShelfCode: string | null;
  part: typeof schema.parts.$inferSelect | null;
  allocations: Array<{
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
      part: typeof schema.parts.$inferSelect | null;
    } | null;
  }>;
}): MeasuringPickingItem {
  return {
    id: item.id,
    pickingOrderId: item.pickingOrderId,
    partId: item.partId,
    qty: item.qty,
    pickedQty: item.pickedQty,
    requiredDateCode: item.requiredDateCode ?? null,
    sourceShelfCode: item.sourceShelfCode ?? null,
    part: item.part ? toPart(item.part) : null,
    allocations: item.allocations.map(toMeasuringAllocation),
  };
}

function toMeasuringPickingOrder(order: {
  id: string;
  refNo: string | null;
  supplierId: string | null;
  deliveryDate: Date | null;
  poNo: string | null;
  requiredDateCodeNotice: string | null;
  shipTo: string | null;
  destinationCountry: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  supplier: typeof schema.suppliers.$inferSelect | null;
  items: Array<{
    id: string;
    pickingOrderId: string;
    partId: string;
    qty: number;
    pickedQty: number;
    requiredDateCode: string | null;
    sourceShelfCode: string | null;
    part: typeof schema.parts.$inferSelect | null;
    allocations: Array<{
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
        part: typeof schema.parts.$inferSelect | null;
      } | null;
    }>;
  }>;
}): MeasuringPickingOrder {
  return {
    id: order.id,
    refNo: order.refNo,
    supplierId: order.supplierId ?? null,
    deliveryDate: order.deliveryDate ?? null,
    poNo: order.poNo ?? null,
    requiredDateCodeNotice: order.requiredDateCodeNotice ?? null,
    shipTo: order.shipTo ?? null,
    destinationCountry: order.destinationCountry ?? null,
    status: order.status as PickingOrderStatus,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    supplier: order.supplier ? toSupplier(order.supplier) : null,
    items: order.items.map(toMeasuringPickingItem),
  };
}

function toMeasuringShippingBox(box: {
  id: string;
  pickingOrderId: string | null;
  measuringTaskId: string | null;
  status: string;
  grossWeight: number | null;
  netWeight: number | null;
  destinationCountry: string | null;
  boxSize: string | null;
  createdAt: Date;
  packages: Array<{
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
      part: typeof schema.parts.$inferSelect | null;
    } | null;
  }>;
}): MeasuringShippingBox {
  return {
    id: box.id,
    pickingOrderId: box.pickingOrderId ?? null,
    measuringTaskId: box.measuringTaskId ?? null,
    status: box.status as BoxStatus,
    grossWeight: box.grossWeight ?? null,
    netWeight: box.netWeight ?? null,
    destinationCountry: box.destinationCountry ?? null,
    boxSize: box.boxSize ?? null,
    createdAt: box.createdAt,
    packages: box.packages.map(toMeasuringPackage),
  };
}

function toMeasuringTaskDetail(data: {
  id: string;
  status: string;
  pickingOrderId: string;
  createdAt: Date;
  pickingOrder: {
    id: string;
    refNo: string | null;
    supplierId: string | null;
    deliveryDate: Date | null;
    poNo: string | null;
    requiredDateCodeNotice: string | null;
    shipTo: string | null;
    destinationCountry: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    supplier: typeof schema.suppliers.$inferSelect | null;
    items: Array<{
      id: string;
      pickingOrderId: string;
      partId: string;
      qty: number;
      pickedQty: number;
      requiredDateCode: string | null;
      sourceShelfCode: string | null;
      part: typeof schema.parts.$inferSelect | null;
      allocations: Array<{
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
          part: typeof schema.parts.$inferSelect | null;
        } | null;
      }>;
    }>;
  } | null;
  shippingBoxes: Array<{
    id: string;
    pickingOrderId: string | null;
    measuringTaskId: string | null;
    status: string;
    grossWeight: number | null;
    netWeight: number | null;
    destinationCountry: string | null;
    boxSize: string | null;
    createdAt: Date;
    packages: Array<{
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
        part: typeof schema.parts.$inferSelect | null;
      } | null;
    }>;
  }>;
}): MeasuringTaskDetail {
  return {
    id: data.id,
    status: data.status as MeasuringTaskStatus,
    pickingOrderId: data.pickingOrderId,
    createdAt: data.createdAt,
    pickingOrder: data.pickingOrder ? toMeasuringPickingOrder(data.pickingOrder) : null,
    shippingBoxes: data.shippingBoxes.map(toMeasuringShippingBox),
  };
}

function toShippingBoxForMeasuring(box: {
  id: string;
  pickingOrderId: string | null;
  measuringTaskId: string | null;
  status: string;
  grossWeight: number | null;
  netWeight: number | null;
  destinationCountry: string | null;
  boxSize: string | null;
  createdAt: Date;
  measuringTask: {
    id: string;
    status: string;
    pickingOrder: {
      id: string;
      refNo: string | null;
      supplierId: string | null;
      deliveryDate: Date | null;
      poNo: string | null;
      requiredDateCodeNotice: string | null;
      shipTo: string | null;
      destinationCountry: string | null;
      status: string;
      createdAt: Date;
      updatedAt: Date;
      supplier: typeof schema.suppliers.$inferSelect | null;
      items: Array<{
        id: string;
        pickingOrderId: string;
        partId: string;
        qty: number;
        pickedQty: number;
        requiredDateCode: string | null;
        sourceShelfCode: string | null;
        part: typeof schema.parts.$inferSelect | null;
        allocations: Array<{
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
            part: typeof schema.parts.$inferSelect | null;
          } | null;
        }>;
      }>;
    } | null;
  } | null;
  packages: Array<{
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
      part: typeof schema.parts.$inferSelect | null;
    } | null;
  }>;
}): ShippingBoxForMeasuring {
  return {
    id: box.id,
    pickingOrderId: box.pickingOrderId ?? null,
    measuringTaskId: box.measuringTaskId ?? null,
    status: box.status as BoxStatus,
    grossWeight: box.grossWeight ?? null,
    netWeight: box.netWeight ?? null,
    destinationCountry: box.destinationCountry ?? null,
    boxSize: box.boxSize ?? null,
    createdAt: box.createdAt,
    measuringTask: box.measuringTask
      ? {
          id: box.measuringTask.id,
          status: box.measuringTask.status as MeasuringTaskStatus,
          pickingOrder: box.measuringTask.pickingOrder
            ? toMeasuringPickingOrder(box.measuringTask.pickingOrder)
            : null,
        }
      : null,
    packages: box.packages.map(toMeasuringPackage),
  };
}

function assertActorId(getActorId: () => string | undefined): string {
  const actorId = getActorId();
  if (!actorId) throw new I18nError("no_operator_user_found");
  return actorId;
}

export function createPgliteWarehouseService(
  options: CreateWarehouseServiceOptions
): WarehouseService {
  const { getActorId } = options;
  const db = useDb();

  return {
    async getReceivingOrders(filter: ReceivingFilter): Promise<ReceivingOrderSummary[]> {
      let where = "1=1";
      if (filter === "pending") where = "ro.status = 'pending'";
      if (filter === "in_hand") where = "ro.status = 'in_hand'";
      if (filter === "clear") where = "ro.status = 'clear'";

      const query = sql`SELECT
        ro.id,
        ro.ref_no,
        ro.status,
        ro.delivery_date,
        s.name AS supplier_name,
        COALESCE(COUNT(DISTINCT CASE
          WHEN ro.status = 'in_hand'
            AND (${availableReceivingQtySql}) > 0
          THEN rii.id
        END), 0) AS remaining_items,
        COALESCE((
          SELECT COUNT(DISTINCT po_id)
          FROM (
            SELECT po.id AS po_id
            FROM allocations a
            JOIN picking_items pi ON pi.id = a.picking_item_id
            JOIN picking_orders po ON po.id = pi.picking_order_id
            WHERE a.receiving_order_id = ro.id
            AND a.qty > 0
            AND po.status IN ('pending', 'picking')

            UNION ALL

            SELECT po.id AS po_id
            FROM allocations a
            JOIN picking_items pi ON pi.id = a.picking_item_id
            JOIN picking_orders po ON po.id = pi.picking_order_id
            JOIN inventory_lots il ON il.id = a.inventory_lot_id
            JOIN inventory_lot_sources ils ON ils.inventory_lot_id = il.id
            JOIN receiving_invoice_items rii2 ON rii2.id = ils.receiving_invoice_item_id
            JOIN receiving_invoices ri2 ON ri2.id = rii2.receiving_invoice_id
            WHERE ri2.receiving_order_id = ro.id
            AND a.qty > 0
            AND po.status IN ('pending', 'picking')
          ) pending_po_ids
        ), 0) AS pending_picking_orders
      FROM receiving_orders ro
      LEFT JOIN suppliers s ON s.id = ro.supplier_id
      LEFT JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      LEFT JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      LEFT JOIN (${allocationsCte()}) alloc ON alloc.receiving_invoice_item_id = rii.id
      WHERE ${sql.raw(where)}
      GROUP BY ro.id, ro.ref_no, ro.status, ro.delivery_date, s.name
      ORDER BY ro.delivery_date;`;

      const result = await db.execute(query);
      return (result.rows ?? []).map((row) => ({
        id: row.id as string,
        refNo: row.ref_no as string,
        status: row.status as ReceivingOrderStatus,
        deliveryDate: row.delivery_date ? String(row.delivery_date) : null,
        supplierName: row.supplier_name ? String(row.supplier_name) : null,
        remainingItems: Number(row.remaining_items ?? 0),
        pendingPickingOrders: Number(row.pending_picking_orders ?? 0),
      }));
    },

    async getReceivingOrder(id: string): Promise<ReceivingOrderDetail> {
      const orderData = await getReceivingOrderDetail(db, id);
      if (!orderData) throw new I18nError("receiving_order_not_found");

      const allItemIds = orderData.invoices.flatMap((inv) =>
        inv.items.map((i) => i.id)
      );

      const [linkedRows, remainingResult, allocatedResult, activeMismatches] =
        await Promise.all([
          dbGetPickingOrdersByReceivingOrder(db, id),
          db.execute(
            sql`SELECT COUNT(DISTINCT CASE
                      WHEN ro.status = 'in_hand'
                        AND (${availableReceivingQtySql}) > 0
                      THEN rii.id
                    END) AS qty
                FROM receiving_orders ro
                JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
                JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
                LEFT JOIN (${allocationsCte()}) alloc ON alloc.receiving_invoice_item_id = rii.id
                WHERE ro.id = ${id}`
          ),
          db.execute(
            sql`SELECT rii.id AS receiving_invoice_item_id, COALESCE(alloc.allocated_qty, 0) AS allocated_qty
                FROM receiving_invoice_items rii
                JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
                JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
                LEFT JOIN (${allocationsCte()}) alloc ON alloc.receiving_invoice_item_id = rii.id
                WHERE ro.id = ${id}`
          ),
          allItemIds.length
            ? getActiveMismatchesForItems(db, allItemIds)
            : Promise.resolve(new Map<string, typeof schema.receivingItemMismatches.$inferSelect>()),
        ]);

      const itemIds = Array.from(new Set(linkedRows.map((r) => r.picking_item_id)));
      const orderIds = Array.from(new Set(linkedRows.map((r) => r.picking_order_id)));

      const [logs, packageResult, boxResult] = await Promise.all([
        itemIds.length ? dbGetPickingItemTransitionLogs(db, itemIds) : Promise.resolve([]),
        itemIds.length
          ? db.execute(sql`
              SELECT id,
                     picking_item_id,
                     picking_order_id,
                     qty,
                     shipping_box_id,
                     date_code,
                     lot_code,
                     coo,
                     cow,
                     created_at
              FROM picking_packages
              WHERE picking_item_id IN (${sql.raw(itemIds.map((i) => `'${i}'`).join(", "))})
              ORDER BY created_at
            `)
          : Promise.resolve({ rows: [] }),
        orderIds.length
          ? db.execute(sql`
              SELECT id, picking_order_id, status
              FROM shipping_boxes
              WHERE picking_order_id IN (${sql.raw(orderIds.map((i) => `'${i}'`).join(", "))})
              ORDER BY id
            `)
          : Promise.resolve({ rows: [] }),
      ]);

      const packagesByItem: Record<string, DisplayPackage[]> = {};
      for (const raw of (packageResult.rows ?? []) as any[]) {
        const pkg: DisplayPackage = {
          id: raw.id,
          pickingItemId: raw.picking_item_id,
          pickingOrderId: raw.picking_order_id,
          qty: raw.qty,
          shippingBoxId: raw.shipping_box_id,
          dateCode: raw.date_code,
          lotCode: raw.lot_code,
          coo: raw.coo,
          cow: raw.cow,
          createdAt: raw.created_at,
        };
        const list = packagesByItem[pkg.pickingItemId] ?? [];
        list.push(pkg);
        packagesByItem[pkg.pickingItemId] = list;
      }

      const boxesByOrder: Record<string, DisplayBox[]> = {};
      for (const box of (boxResult.rows ?? []) as any[]) {
        const displayBox: DisplayBox = {
          id: box.id,
          pickingOrderId: box.picking_order_id,
          status: box.status,
        };
        const list = boxesByOrder[displayBox.pickingOrderId] ?? [];
        list.push(displayBox);
        boxesByOrder[displayBox.pickingOrderId] = list;
      }

      const allocatedByItem: Record<string, number> = {};
      for (const row of (allocatedResult.rows ?? []) as any[]) {
        allocatedByItem[row.receiving_invoice_item_id] = Number(row.allocated_qty);
      }

      const transitionLogs: Record<string, TransitionLog[]> = {};
      for (const log of logs) {
        const list = transitionLogs[log.entityId] ?? [];
        list.push(log);
        transitionLogs[log.entityId] = list;
      }

      const invoices: ReceivingOrderDetail["invoices"] = orderData.invoices.map(
        (invoice) => ({
          ...invoice,
          items: invoice.items.map((item) => {
            const base = toReceivingItem(item);
            const mismatch = activeMismatches.get(item.id) ?? null;
            return {
              ...base,
              mismatch: mismatch ? toReceivingItemMismatch(mismatch) : null,
            };
          }),
        })
      );

      return {
        id: orderData.id,
        refNo: orderData.refNo,
        status: orderData.status as ReceivingOrderStatus,
        deliveryDate: orderData.deliveryDate ?? null,
        supplier: orderData.supplier ? toSupplier(orderData.supplier) : null,
        invoices,
        remainingItems: Number((remainingResult.rows[0] as any)?.qty ?? 0),
        allocatedByItem,
        pickingRows: linkedRows,
        packagesByItem,
        boxesByOrder,
        transitionLogs,
      };
    },

    async confirmReceivingOrderArrived(id: string): Promise<void> {
      await dbConfirmReceivingOrderArrived(db, id, assertActorId(getActorId));
    },

    async getActiveMismatch(itemId: string): Promise<ReceivingItemMismatch | null> {
      const mismatch = await getActiveMismatchForItem(db, itemId);
      return mismatch ? toReceivingItemMismatch(mismatch) : null;
    },

    async reportMismatch(itemId: string, input: ReportMismatchInput): Promise<void> {
      await reportReceivingItemMismatch(
        db,
        itemId,
        assertActorId(getActorId),
        input.reason,
        input.mismatchQty ?? null,
        input.wrongPartNo ?? null,
        input.note ?? ""
      );
    },

    async editMismatch(mismatchId: string, input: ReportMismatchInput): Promise<void> {
      await editReceivingItemMismatch(
        db,
        mismatchId,
        assertActorId(getActorId),
        input.reason,
        input.mismatchQty ?? null,
        input.wrongPartNo ?? null,
        input.note ?? ""
      );
    },

    async confirmMismatch(mismatchId: string): Promise<void> {
      await confirmReceivingItemMismatch(db, mismatchId, assertActorId(getActorId));
    },

    async cancelMismatch(mismatchId: string): Promise<void> {
      await cancelReceivingItemMismatch(db, mismatchId, assertActorId(getActorId));
    },

    async getPickingOrdersByReceivingOrder(id: string): Promise<PickingByReceivingRow[]> {
      return dbGetPickingOrdersByReceivingOrder(db, id);
    },

    async getPickingItemTransitionLogs(ids: string[]): Promise<TransitionLog[]> {
      return dbGetPickingItemTransitionLogs(db, ids);
    },

    async createShippingBoxForPickingOrder(pickingOrderId: string): Promise<void> {
      await dbCreateShippingBoxForPickingOrder(db, pickingOrderId, assertActorId(getActorId));
    },

    async addPackageToBox(packageId: string, boxId: string): Promise<void> {
      await dbAddPackageToBox(db, packageId, boxId, assertActorId(getActorId));
    },

    async removePackageFromBox(packageId: string): Promise<void> {
      await dbRemovePackageFromBox(db, packageId, assertActorId(getActorId));
    },

    async removeScannedPackage(packageId: string): Promise<void> {
      await dbRemoveScannedPackage(db, packageId, assertActorId(getActorId));
    },

    async getPickingOrders(): Promise<PickingOrderSummary[]> {
      const result = await db.execute(sql`
        SELECT po.id, po.ref_no, po.status, po.delivery_date, po.ship_to, s.name AS supplier_name,
          (SELECT COALESCE(SUM(pi.qty), 0) FROM picking_items pi WHERE pi.picking_order_id = po.id) AS total_qty
        FROM picking_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        ORDER BY CASE WHEN po.status = 'finished' THEN 1 ELSE 0 END, po.delivery_date
      `);

      return ((result.rows ?? []) as any[]).map((row) => ({
        id: row.id as string,
        refNo: row.ref_no as string,
        status: row.status as PickingOrderStatus,
        deliveryDate: row.delivery_date ? String(row.delivery_date) : null,
        supplierName: row.supplier_name ? String(row.supplier_name) : null,
        shipTo: row.ship_to ? String(row.ship_to) : null,
        totalQty: Number(row.total_qty ?? 0),
      }));
    },

    async getPickingOrder(id: string): Promise<PickingOrderDetail> {
      const data = await getPickingOrderDetail(db, id);
      if (!data) throw new I18nError("picking_order_not_found");
      return toPickingOrderDetail(data);
    },

    async finishPickingOrder(id: string): Promise<void> {
      await dbFinishPickingOrder(db, id, assertActorId(getActorId));
    },

    async reportPickingOrderIssues(
      entries: ReportPickingIssueEntry[],
      input: ReportPickingIssuesInput
    ): Promise<ReportPickingIssuesResult> {
      return dbReportPickingOrderIssues(db, entries, input, assertActorId(getActorId));
    },

    async scanAllocation(id: string, qty: number): Promise<string> {
      return dbScanAllocationToPackage(db, id, qty, assertActorId(getActorId));
    },

    async applyOcrPick(input: ApplyOcrPickInput): Promise<void> {
      await dbApplyOcrPick(
        db,
        input.receivingOrderId,
        input.pickingItemId,
        input.qty,
        input.dateCode ?? null,
        input.lotCode ?? null,
        input.coo ?? null,
        input.cow ?? null,
        assertActorId(getActorId)
      );
    },

    async addAllUnboxedPackagesToBox(boxId: string): Promise<number> {
      return dbAddAllUnboxedPackagesToBox(db, boxId, assertActorId(getActorId));
    },

    async cancelShippingBox(id: string): Promise<void> {
      await dbCancelShippingBox(db, id, assertActorId(getActorId));
    },

    async getPutAwayCandidates(): Promise<PutAwayCandidate[]> {
      const rows = await dbGetPutAwayCandidates(db);
      return rows.map(toPutAwayCandidate);
    },

    async getPutAwayLots(receivingOrderId: string): Promise<PutAwayLot[]> {
      const rows = await dbGetPutAwayLots(db, receivingOrderId);
      return rows.map(toPutAwayLot);
    },

    async getPutAwayScans(receivingOrderId: string): Promise<PutAwayScan[]> {
      const rows = await dbGetPutAwayScansForReceivingOrder(db, receivingOrderId);
      return rows.map(toPutAwayScan);
    },

    async getShelfBoxesForReceivingOrder(receivingOrderId: string): Promise<ShelfBox[]> {
      const boxes = await dbGetShelfBoxesForReceivingOrder(db, receivingOrderId);
      return boxes.map((box) => toShelfBox(box, box.items.map(toShelfBoxItem)));
    },

    async getShelves(): Promise<Shelf[]> {
      const rows = await db.query.shelves.findMany();
      return rows.map(toShelf);
    },

    async recordPutAwayScan(
      receivingInvoiceItemId: string,
      qty: number,
      dateCode: string | null,
      lotCode: string | null,
      coo: string | null,
      cow: string | null
    ): Promise<PutAwayScan> {
      const scan = await dbRecordPutAwayScan(
        db,
        receivingInvoiceItemId,
        qty,
        dateCode,
        lotCode,
        coo,
        cow
      );
      return toPutAwayScan(scan);
    },

    async assignPutAwayScanToBox(scanId: string, boxId: string): Promise<void> {
      await dbAssignScanToBox(db, scanId, boxId, assertActorId(getActorId));
    },

    async removePutAwayScanFromBox(scanId: string): Promise<void> {
      await dbRemoveScanFromBox(db, scanId, assertActorId(getActorId));
    },

    async removePutAwayScannedPiece(scanId: string): Promise<void> {
      await dbRemoveScannedPiece(db, scanId);
    },

    async createShelfBox(receivingOrderId: string, shelfCode: string): Promise<ShelfBox> {
      const box = await dbCreateShelfBox(db, receivingOrderId, shelfCode, assertActorId(getActorId));
      return toShelfBox(box, []);
    },

    async closeShelfBox(id: string): Promise<void> {
      await dbCloseShelfBox(db, id, assertActorId(getActorId));
    },

    async cancelShelfBox(id: string): Promise<void> {
      await dbCancelShelfBox(db, id, assertActorId(getActorId));
    },

    async getMeasuringTasks(): Promise<MeasuringTaskSummary[]> {
      const query = `SELECT mt.id,
              mt.status,
              po.id AS picking_order_id,
              po.ref_no AS picking_order_ref,
              s.name AS supplier_name,
              COALESCE(SUM(pi.qty), 0) AS total_items,
              COALESCE(SUM(pkg.qty), 0) AS packed_items
       FROM measuring_tasks mt
       INNER JOIN picking_orders po ON po.id = mt.picking_order_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN picking_items pi ON pi.picking_order_id = po.id
       LEFT JOIN shipping_boxes sb ON sb.measuring_task_id = mt.id
       LEFT JOIN picking_packages pkg ON pkg.shipping_box_id = sb.id
       WHERE mt.status = 'pending'
       GROUP BY mt.id, mt.status, po.id, po.ref_no, s.name
       ORDER BY po.ref_no;`;

      const result = await db.execute(sql.raw(query));
      return ((result.rows ?? []) as any[]).map((row) => ({
        id: row.id as string,
        status: row.status as MeasuringTaskStatus,
        pickingOrderId: row.picking_order_id as string,
        pickingOrderRef: row.picking_order_ref ? String(row.picking_order_ref) : null,
        supplierName: row.supplier_name ? String(row.supplier_name) : null,
        totalItems: Number(row.total_items ?? 0),
        packedItems: Number(row.packed_items ?? 0),
      }));
    },

    async getMeasuringTask(id: string): Promise<MeasuringTaskDetail> {
      const data = await dbGetMeasuringTaskDetail(db, id);
      if (!data) throw new I18nError("measuring_task_not_found");
      return toMeasuringTaskDetail(data);
    },

    async getShippingBoxForMeasuring(id: string): Promise<ShippingBoxForMeasuring> {
      const data = await dbGetShippingBoxForMeasuring(db, id);
      if (!data) throw new I18nError("shipping_box_not_found");
      return toShippingBoxForMeasuring(data as unknown as Parameters<typeof toShippingBoxForMeasuring>[0]);
    },

    async findMatchingUnverifiedPackage(
      boxId: string,
      input: PackageVerificationInput,
      targetPackageId?: string
    ): Promise<MeasuringPackage | null> {
      const matched = await dbFindMatchingUnverifiedPackage(db, boxId, input, targetPackageId);
      return matched ? toMeasuringPackage(matched) : null;
    },

    async verifyPickingPackage(packageId: string): Promise<void> {
      await dbVerifyPickingPackageForMeasuring(db, packageId, assertActorId(getActorId));
    },

    async updateShippingBox(id: string, fields: BoxMeasurementsInput): Promise<void> {
      await dbUpdateShippingBox(db, id, fields);
    },

    async closeShippingBox(id: string): Promise<void> {
      await dbCloseShippingBox(db, id, assertActorId(getActorId));
    },

    async completeMeasuringTask(id: string): Promise<void> {
      await dbCompleteMeasuringTask(db, id, assertActorId(getActorId));
    },

    async getShelvesWithBoxes(): Promise<ShelfWithBoxCount[]> {
      return dbGetShelvesWithBoxes(db);
    },

    async getShelfBoxes(shelfCode: string): Promise<GoodsVerifyShelfBoxSummary[]> {
      return dbGetShelfBoxesByShelf(db, shelfCode);
    },

    async getShelfBox(id: string): Promise<GoodsVerifyShelfBoxDetail> {
      const data = await dbGetShelfBoxDetail(db, id);
      if (!data) throw new I18nError("shelf_box_not_found");
      return toGoodsVerifyShelfBoxDetail(data);
    },

    async verifyShelfBoxItem(shelfBoxId: string, partId: string): Promise<void> {
      await dbVerifyShelfBoxScans(db, shelfBoxId, partId);
    },

    async markShelfBoxVerified(id: string): Promise<void> {
      await dbMarkShelfBoxVerified(db, id, assertActorId(getActorId));
    },

    async getSuppliersWithInventoryStats(): Promise<StockSearchSupplierWithStats[]> {
      return dbGetSuppliersWithInventoryStats(db);
    },

    async getPartsBySupplier(supplierId: string): Promise<StockSearchPart[]> {
      return dbGetPartsBySupplierId(db, supplierId);
    },

    async getInventoryLotsForParts(partIds: string[]): Promise<StockSearchInventoryLot[]> {
      return dbGetInventoryLotsForParts(db, partIds);
    },
  };
}
