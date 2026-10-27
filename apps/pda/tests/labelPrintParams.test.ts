import { describe, expect, it } from "vitest";
import { buildLabelPrintParams } from "../utils/labelPrintParams";
import type { PickingItem, PickingOrderDetail, PickingPackage } from "../services/types";

function pkg(id: string, qty: number, overrides: Partial<PickingPackage> = {}): PickingPackage {
  return {
    id,
    qty,
    dateCode: null,
    lotCode: null,
    coo: null,
    cow: null,
    verified: false,
    rescannedQty: 0,
    labelBarcode: null,
    shippingBoxId: null,
    sourceType: "lot",
    sourceId: `src-${id}`,
    ...overrides,
  };
}

function item(id: string, partNo: string, packages: PickingPackage[], overrides: Partial<PickingItem> = {}): PickingItem {
  return {
    id,
    partNo,
    wclItemNo: null,
    brand: null,
    qty: packages.reduce((s, p) => s + p.qty, 0),
    pickedQty: 0,
    allocatedQty: 0,
    lineId: null,
    lineNumber: null,
    shipmentNumber: null,
    status: "picked",
    additionalData: null,
    allocations: [],
    packages,
    ...overrides,
  };
}

function order(overrides: Partial<PickingOrderDetail> = {}): PickingOrderDetail {
  return {
    id: "order-1",
    orderNo: "SO-1001",
    status: "picking_finished",
    allocationStatus: "full",
    deliveryDate: null,
    poNo: "PO-55",
    shipTo: "HK Warehouse",
    customerCode: "CUST-9",
    orgId: 2,
    subInventoryCode: "HK",
    workingBy: null,
    workingByName: null,
    issueReason: null,
    issueQty: null,
    issuePackSize: null,
    issueNote: null,
    issueRemark: null,
    issueReportedAt: null,
    issueReportedBy: null,
    createdDate: "2026-10-27",
    lastUpdateDate: "2026-10-27",
    outdatedWarningCount: 0,
    items: [],
    boxes: [],
    suggestedBox: null,
    ...overrides,
  };
}

describe("buildLabelPrintParams", () => {
  const sample = order({
    items: [
      item("i1", "PART-A", [
        pkg("p1", 100, {
          dateCode: "2610",
          lotCode: "LOT1",
          coo: "JP",
          shippingBoxId: "BOX-1",
        }),
        pkg("p2", 50, {
          // Pick-time scanned values win over the source snapshot.
          dateCode: "2601",
          lotCode: "SNAP-LOT",
          scannedDateCode: "2640",
          scannedLotCode: "SCAN-LOT",
          scannedCoo: "TW",
          shippingBoxId: "BOX-1",
        }),
      ], { wclItemNo: "WCL-A", brand: "KOA" }),
      item("i2", "PART-B", [
        pkg("p3", 7, { shippingBoxId: "BOX-2" }),
      ]),
    ],
    boxes: [
      { id: "BOX-2", status: "open", boxSize: null, grossWeight: null, netWeight: null, destinationCountry: null, packageCount: 1, shippedAt: null, shippedBy: null },
      { id: "BOX-1", status: "open", boxSize: null, grossWeight: null, netWeight: null, destinationCountry: null, packageCount: 2, shippedAt: null, shippedBy: null },
    ],
  });

  it("carton: one row per box, sorted by id, with box totals", () => {
    const rows = buildLabelPrintParams("carton", sample);
    expect(rows).toHaveLength(2);
    expect(rows[0].boxId).toBe("BOX-1");
    expect(rows[1].boxId).toBe("BOX-2");
    // BOX-1 holds p1 (100) + p2 (50); BOX-2 holds p3 (7).
    expect(rows[0].qty).toBe("150");
    expect(rows[0].quantity).toBe("150");
    expect(rows[1].qty).toBe("7");
    // Box id doubles as the scannable codes.
    expect(rows[0].barcodeValue).toBe("BOX-1");
    expect(rows[0].barCode).toBe("BOX-1");
    expect(rows[0].serialNo).toBe("BOX-1");
    expect(rows[0].qrcode).toBe("BOX-1");
    // Identity fields come from the order.
    expect(rows[0].orderNo).toBe("SO-1001");
    expect(rows[0].poNo).toBe("PO-55");
    expect(rows[0].invNo).toBe("PO-55");
    expect(rows[0].customerCode).toBe("CUST-9");
    expect(rows[0].customerName).toBe("CUST-9");
    expect(rows[0].shipTo).toBe("HK Warehouse");
  });

  it("carton: single-part box exposes the part; mixed box leaves part fields empty", () => {
    const rows = buildLabelPrintParams("carton", sample);
    // BOX-1 holds two packages of PART-A → single-part.
    expect(rows[0].partNo).toBe("PART-A");
    expect(rows[0].MFRCode).toBe("KOA");
    // BOX-2 holds PART-B → single-part.
    expect(rows[1].partNo).toBe("PART-B");
    const mixed = order({
      items: [
        item("i1", "PART-A", [pkg("p1", 1, { shippingBoxId: "BOX-9" })]),
        item("i2", "PART-B", [pkg("p2", 1, { shippingBoxId: "BOX-9" })]),
      ],
      boxes: [
        { id: "BOX-9", status: "open", boxSize: null, grossWeight: null, netWeight: null, destinationCountry: null, packageCount: 2, shippedAt: null, shippedBy: null },
      ],
    });
    const [row] = buildLabelPrintParams("carton", mixed);
    expect(row.partNo).toBe("");
    expect(row.qty).toBe("2");
  });

  it("item: one row per package across all items, in item order", () => {
    const rows = buildLabelPrintParams("item", sample);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.barcodeValue)).toEqual(["p1", "p2", "p3"]);
    expect(rows[0].partNo).toBe("PART-A");
    expect(rows[0].wclItemNo).toBe("WCL-A");
    expect(rows[0].ATICode).toBe("PART-A");
    expect(rows[0].MFRCode).toBe("KOA");
    expect(rows[2].partNo).toBe("PART-B");
    // item_box behaves identically.
    expect(buildLabelPrintParams("item_box", sample).map((r) => r.barcodeValue)).toEqual(["p1", "p2", "p3"]);
  });

  it("prefers pick-time scanned batch fields over the source snapshot", () => {
    const rows = buildLabelPrintParams("item", sample);
    // p1: no scanned values → snapshot.
    expect(rows[0].dateCode).toBe("2610");
    expect(rows[0].lotCode).toBe("LOT1");
    expect(rows[0].lotNo).toBe("LOT1");
    expect(rows[0].coo).toBe("JP");
    expect(rows[0].makeIn).toBe("JP");
    expect(rows[0].productionDate).toBe("2610");
    // p2: scanned values win.
    expect(rows[1].dateCode).toBe("2640");
    expect(rows[1].lotCode).toBe("SCAN-LOT");
    expect(rows[1].coo).toBe("TW");
    expect(rows[1].cow).toBe("");
  });

  it("trace code joins part|dateCode|lotCode|qty, skipping empty segments", () => {
    const rows = buildLabelPrintParams("item", sample);
    expect(rows[0].traceCode).toBe("WCL-A|2610|LOT1|100");
    expect(rows[1].traceCode).toBe("WCL-A|2640|SCAN-LOT|50");
    // p3 has no batch fields at all → just part + qty.
    expect(rows[2].traceCode).toBe("PART-B|7");
    expect(rows[2].qrcode).toBe(rows[2].traceCode);
  });

  it("adds 1-based page/total strings and showTailBox over the row set", () => {
    const rows = buildLabelPrintParams("item", sample);
    expect(rows.map((r) => r.page)).toEqual(["1", "2", "3"]);
    expect(rows.every((r) => r.total === "3")).toBe(true);
    expect(rows.every((r) => r.showTailBox === true)).toBe(true);
    const cartons = buildLabelPrintParams("carton", sample);
    expect(cartons.map((r) => r.page)).toEqual(["1", "2"]);
    expect(cartons.every((r) => r.total === "2")).toBe(true);
  });

  it("keeps every non-boolean value a string", () => {
    for (const rows of [
      buildLabelPrintParams("item", sample),
      buildLabelPrintParams("carton", sample),
    ]) {
      for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
          if (key === "showTailBox") {
            expect(value).toBe(true);
          } else {
            expect(typeof value, key).toBe("string");
          }
        }
      }
    }
  });

  it("null order fields render as empty strings", () => {
    const bare = order({ poNo: null, shipTo: null, customerCode: null });
    const rows = buildLabelPrintParams("item", order({ ...bare, items: [item("i", "P", [pkg("p", 1)])] }));
    expect(rows[0].poNo).toBe("");
    expect(rows[0].invNo).toBe("");
    expect(rows[0].shipTo).toBe("");
    expect(rows[0].customerCode).toBe("");
  });
});
