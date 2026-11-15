import { describe, expect, it } from "vitest";
import { buildPickingScanAoa, canonicalDateCodeToYyyymmdd, PICKING_SCAN_EXCEL_HEADERS } from "~/utils/pickingScanExcel";
import type { PickingOrderDetail } from "~/utils/flowApi";

function pkg(overrides: Partial<Parameters<typeof buildPickingScanAoa>[0]["order"]["items"][number]["packages"][number]> = {}) {
  return {
    id: "pkg",
    qty: 20000,
    dateCode: "2601",
    lotCode: null,
    coo: "JP",
    cow: null,
    verified: false,
    verifyVerified: false,
    rescannedQty: 0,
    labelBarcode: null,
    scannedDateCode: null,
    scannedLotCode: null,
    scannedCoo: null,
    scannedCow: null,
    shippingBoxId: "BOX-1",
    sourceType: "inventory_lot",
    sourceId: "lot",
    drawingNo: null,
    ...overrides,
  };
}

function order(overrides: Partial<PickingOrderDetail> = {}): PickingOrderDetail {
  return {
    id: "o1",
    orderNo: "HK2611-0011",
    status: "picking_finished",
    boxes: [{ id: "BOX-1" }, { id: "BOX-2" }, { id: "BOX-3" }, { id: "BOX-4" }],
    items: [
      {
        id: "i1",
        partNo: "PART-A",
        wclItemNo: "wcl_item_A",
        qty: 20000,
        pickedQty: 20000,
        allocatedQty: 20000,
        lineId: null,
        lineNumber: 1,
        shipmentNumber: 1,
        status: "normal",
        allocations: [],
        packages: [pkg()],
      },
    ],
    ...overrides,
  } as unknown as PickingOrderDetail;
}

describe("canonicalDateCodeToYyyymmdd", () => {
  it("maps week 1 of 2026 to its ISO-week Thursday (2026-01-01)", () => {
    expect(canonicalDateCodeToYyyymmdd("2601")).toBe("20260101");
  });

  it("maps a mid-year week to that week's Thursday", () => {
    // ISO week 37 of 2026 → Thursday 2026-09-10
    expect(canonicalDateCodeToYyyymmdd("2637")).toBe("20260910");
  });

  it("handles the 53rd week only when it belongs to the code's year", () => {
    // 2026 week 53 does not exist (2026 has 53 ISO weeks only when the year
    // starts on Thursday — 2026 does: Jan 1 2026 is a Thursday).
    expect(canonicalDateCodeToYyyymmdd("2653")).not.toBeNull();
    expect(canonicalDateCodeToYyyymmdd("2753")).toBeNull(); // 2027 has 52 ISO weeks
    expect(canonicalDateCodeToYyyymmdd(null)).toBeNull();
    expect(canonicalDateCodeToYyyymmdd("abc")).toBeNull();
  });
});

describe("buildPickingScanAoa", () => {
  it("emits headers then one row per package in scan order", () => {
    const o = order({
      items: [
        {
          id: "i1",
          partNo: "PART-A",
          wclItemNo: "wcl_item_A",
          qty: 20000,
          pickedQty: 20000,
          allocatedQty: 20000,
          lineId: null,
          lineNumber: 1,
          shipmentNumber: 1,
          status: "normal",
          allocations: [],
          packages: [
            pkg({ id: "p1" }),
            pkg({ id: "p2", qty: 100, dateCode: "2637", coo: "CN" }),
          ],
        },
      ],
    } as Partial<PickingOrderDetail>) as PickingOrderDetail;
    const aoa = buildPickingScanAoa({ order: o, dateCodeFormat: "yyww" });
    expect(aoa[0]).toEqual([...PICKING_SCAN_EXCEL_HEADERS]);
    expect(aoa.length).toBe(3);
    expect(aoa[1]).toEqual([1, "HK2611-0011", "wcl_item_A", 20000, "20260101", "2601", "JP", "", "", 1, "1/4"]);
    expect(aoa[2]).toEqual([2, "HK2611-0011", "wcl_item_A", 100, "20260910", "2637", "CN", "", "", 1, "1/4"]);
  });

  it("prefers the pick-time scanned batch fields and skips cancelled items", () => {
    const o = order({
      items: [
        {
          id: "i1",
          partNo: "PART-A",
          wclItemNo: "wcl_item_A",
          qty: 20000,
          pickedQty: 20000,
          allocatedQty: 20000,
          lineId: null,
          lineNumber: 1,
          shipmentNumber: 1,
          status: "normal",
          allocations: [],
          packages: [pkg({ scannedDateCode: "2610", scannedCoo: "CN", drawingNo: "D-123" })],
        },
        {
          id: "i2",
          partNo: "PART-B",
          wclItemNo: "wcl_item_B",
          qty: 5,
          pickedQty: 0,
          allocatedQty: 0,
          lineId: null,
          lineNumber: 2,
          shipmentNumber: 1,
          status: "cancelled",
          allocations: [],
          packages: [],
        },
      ],
    } as Partial<PickingOrderDetail>) as PickingOrderDetail;
    const aoa = buildPickingScanAoa({ order: o, dateCodeFormat: "wwyy" });
    expect(aoa.length).toBe(2);
    expect(aoa[1]).toEqual([1, "HK2611-0011", "wcl_item_A", 20000, "20260305", "1026", "CN", "", "D-123", 1, "1/4"]);
  });

  it("labels unboxed packages with an empty box index", () => {
    const o = order({
      items: [
        {
          id: "i1",
          partNo: "PART-A",
          wclItemNo: "wcl_item_A",
          qty: 1,
          pickedQty: 1,
          allocatedQty: 1,
          lineId: null,
          lineNumber: 1,
          shipmentNumber: 1,
          status: "normal",
          allocations: [],
          packages: [pkg({ shippingBoxId: null })],
        },
      ],
    } as Partial<PickingOrderDetail>) as PickingOrderDetail;
    const aoa = buildPickingScanAoa({ order: o, dateCodeFormat: "yyww" });
    expect(aoa[1][9]).toBe(""); // box_no is empty when unboxed
    expect(aoa[1][10]).toBe("");
  });
});
