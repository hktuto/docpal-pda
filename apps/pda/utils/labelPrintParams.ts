/**
 * Builds the printingParams rows for the picking-finish label print prompt
 * (spec docs/superpowers/specs/2026-10-27-picking-finish-label-print-prompt-design.md).
 * Each row is a SUPERSET of the documented template fields
 * (docs/backend/print-service.md) — canvas templates bind by name and ignore
 * extras. All values are strings unless boolean.
 */
import type { PickingItem, PickingOrderDetail, PickingPackage } from "../services/types";

export type LabelPrintType = "carton" | "item_box" | "item";

interface BatchFields {
  dateCode: string;
  lotCode: string;
  coo: string;
  cow: string;
}

const str = (v: string | number | null | undefined): string =>
  v === null || v === undefined ? "" : String(v);

/** Batch fields anchor to the pick-time scanned values when present, falling
 *  back to the stored source snapshot (same rule as verify re-scan matching). */
function packageBatch(pkg: PickingPackage): BatchFields {
  return {
    dateCode: str(pkg.scannedDateCode ?? pkg.dateCode),
    lotCode: str(pkg.scannedLotCode ?? pkg.lotCode),
    coo: str(pkg.scannedCoo ?? pkg.coo),
    cow: str(pkg.scannedCow ?? pkg.cow),
  };
}

/** Canonical trace string for a package: `part|dateCode|lotCode|qty` with
 *  empty segments skipped. */
function packageTrace(item: PickingItem, pkg: PickingPackage): string {
  const batch = packageBatch(pkg);
  return [str(item.wclItemNo) || item.partNo, batch.dateCode, batch.lotCode, str(pkg.qty)]
    .filter((s) => s !== "")
    .join("|");
}

function identityFields(order: PickingOrderDetail): Record<string, string> {
  return {
    orderNo: order.orderNo,
    poNo: str(order.poNo),
    customerCode: str(order.customerCode),
    customerName: str(order.customerCode),
    shipTo: str(order.shipTo),
    invNo: str(order.poNo),
  };
}

function partFields(item: PickingItem | null): Record<string, string> {
  const partNo = item?.partNo ?? "";
  const wclItemNo = str(item?.wclItemNo);
  const brand = str(item?.brand);
  return {
    partNo,
    wclItemNo,
    itemCode: wclItemNo,
    itemNum: wclItemNo,
    sku: wclItemNo || partNo,
    productCode: partNo,
    mfgPn: partNo,
    partNumber: partNo,
    ATICode: partNo,
    MFRCode: brand,
  };
}

function batchFields(batch: BatchFields): Record<string, string> {
  return {
    dateCode: batch.dateCode,
    lotCode: batch.lotCode,
    lotNo: batch.lotCode,
    coo: batch.coo,
    cow: batch.cow,
    makeIn: batch.coo,
    originCountry: batch.coo,
    productionDate: batch.dateCode,
  };
}

const EMPTY_BATCH: BatchFields = { dateCode: "", lotCode: "", coo: "", cow: "" };

/** Build the printingParams rows for one label type: `carton` = one row per
 *  shipping box of the order; `item_box`/`item` = one row per package across
 *  all items (item order, then the order the packages appear on the item). */
export function buildLabelPrintParams(
  labelType: LabelPrintType,
  order: PickingOrderDetail
): Record<string, unknown>[] {
  const identity = identityFields(order);
  const rows: Record<string, unknown>[] = [];

  if (labelType === "carton") {
    const boxes = [...order.boxes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const box of boxes) {
      const boxPkgs: { item: PickingItem; pkg: PickingPackage }[] = [];
      for (const item of order.items) {
        for (const pkg of item.packages) {
          if (pkg.shippingBoxId === box.id) boxPkgs.push({ item, pkg });
        }
      }
      // Single-part box: expose that part's identity/batch; mixed boxes leave
      // them empty.
      const distinctParts = new Set(boxPkgs.map(({ item }) => item.partNo));
      const single = distinctParts.size === 1 ? boxPkgs[0] : undefined;
      const totalQty = boxPkgs.reduce((sum, { pkg }) => sum + pkg.qty, 0);
      rows.push({
        ...identity,
        ...partFields(single?.item ?? null),
        ...batchFields(single ? packageBatch(single.pkg) : EMPTY_BATCH),
        qty: str(totalQty),
        quantity: str(totalQty),
        serialNo: box.id,
        boxId: box.id,
        barcodeValue: box.id,
        barCode: box.id,
        extraCode: box.id,
        qrcode: box.id,
        qrPayload: box.id,
        traceCode: box.id,
        midQr: box.id,
        topQr: box.id,
      });
    }
  } else {
    for (const item of order.items) {
      for (const pkg of item.packages) {
        const trace = packageTrace(item, pkg);
        rows.push({
          ...identity,
          ...partFields(item),
          ...batchFields(packageBatch(pkg)),
          qty: str(pkg.qty),
          quantity: str(pkg.qty),
          serialNo: str(pkg.shippingBoxId),
          boxId: str(pkg.shippingBoxId),
          barcodeValue: pkg.id,
          barCode: pkg.id,
          extraCode: str(pkg.shippingBoxId),
          qrcode: trace,
          qrPayload: trace,
          traceCode: trace,
          midQr: trace,
          topQr: trace,
        });
      }
    }
  }

  const total = rows.length;
  return rows.map((row, i) => ({
    ...row,
    page: String(i + 1),
    total: String(total),
    showTailBox: true,
  }));
}
