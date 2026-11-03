import { describe, expect, it } from "vitest";
import { findCnScanMatches, normalizePartKey } from "./cnReceivingScan";
import type { CnScanTaskItem } from "~/services/types";

function item(over: Partial<CnScanTaskItem>): CnScanTaskItem {
  return {
    id: over.id ?? "i1",
    partNo: "ABC-123",
    wclItemNo: null,
    poNo: null,
    poLine: null,
    lineQty: 100,
    ctnNo: null,
    dateCode: null,
    lotCode: null,
    coo: null,
    cow: null,
    orgId: 2,
    subInventoryCode: null,
    scanStatus: null,
    scanQty: null,
    scanReason: null,
    scanNote: null,
    scannedAt: null,
    scannedBy: null,
    ...over,
  };
}

describe("normalizePartKey", () => {
  it("trims, uppercases, strips all whitespace", () => {
    expect(normalizePartKey(" ab 123 ")).toBe("AB123");
    expect(normalizePartKey(null)).toBe("");
    expect(normalizePartKey(undefined)).toBe("");
  });
});

describe("findCnScanMatches", () => {
  const items = [
    item({ id: "a", partNo: "GRM 188R71H104KA93D", wclItemNo: "WCL-001" }),
    item({ id: "b", partNo: "OTHER", wclItemNo: "WCL-002" }),
    item({ id: "c", partNo: "GRM188R71H104KA93D", scanStatus: "ok" }),
  ];

  it("matches partNo space/case-insensitively against the label itemId", () => {
    expect(findCnScanMatches(items, { itemId: "grm188r71h104ka93d" }).map((i) => i.id)).toEqual(["a"]);
  });

  it("matches the item's wclItemNo against the label wclItemNo", () => {
    expect(findCnScanMatches(items, { itemId: "NOPE", wclItemNo: " wcl-002 " }).map((i) => i.id)).toEqual(["b"]);
  });

  it("matches the item's wclItemNo against the label itemId too", () => {
    expect(findCnScanMatches(items, { itemId: "WCL-001" }).map((i) => i.id)).toEqual(["a"]);
  });

  it("skips already-resolved items", () => {
    const resolved = [item({ id: "x", partNo: "P1", scanStatus: "warning" })];
    expect(findCnScanMatches(resolved, { itemId: "P1" })).toEqual([]);
  });

  it("returns nothing for empty label keys", () => {
    expect(findCnScanMatches(items, {})).toEqual([]);
    expect(findCnScanMatches(items, { itemId: "   " })).toEqual([]);
  });

  it("matches a TE label's bare MPN against AMP-wrapped item keys", () => {
    const teItems = [
      item({ id: "te1", partNo: "AMP(5172070-1)", wclItemNo: "TE-AMP(5172070-1)" }),
      item({ id: "te2", partNo: "OTHER-9", wclItemNo: null }),
    ];
    expect(findCnScanMatches(teItems, { itemId: "5172070-1" }).map((i) => i.id)).toEqual(["te1"]);
    expect(findCnScanMatches(teItems, { itemId: "5172070-1", wclItemNo: "TE/5172070-1" }).map((i) => i.id)).toEqual(["te1"]);
  });
});
