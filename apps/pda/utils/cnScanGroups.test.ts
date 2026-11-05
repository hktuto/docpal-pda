import { describe, expect, it } from "vitest";
import { buildCnScanGroups, cnScanGroupKey } from "./cnScanGroups";
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

describe("cnScanGroupKey", () => {
  it("keys on the normalized part identity only — batch fields never split a group", () => {
    const a = item({ id: "a", partNo: "P1", wclItemNo: "WCL 001", dateCode: "2440", coo: "CN" });
    const b = item({ id: "b", partNo: "P1", wclItemNo: "wcl001", dateCode: " 2440 ", coo: "cn" });
    const c = item({ id: "c", partNo: "P1", wclItemNo: "WCL001", dateCode: "2441", coo: "JP", cow: "US" });
    const d = item({ id: "d", partNo: "P2", wclItemNo: "WCL002", dateCode: "2440", coo: "CN" });
    expect(cnScanGroupKey(a)).toBe(cnScanGroupKey(b));
    expect(cnScanGroupKey(a)).toBe(cnScanGroupKey(c)); // different batch fields, same part
    expect(cnScanGroupKey(a)).not.toBe(cnScanGroupKey(d)); // different part
  });
});

describe("buildCnScanGroups", () => {
  it("groups same-part lines and sums scanQty/lineQty", () => {
    const groups = buildCnScanGroups([
      item({ id: "a", lineQty: 100, scanQty: 40, poNo: "PO-1" }),
      item({ id: "b", lineQty: 50, scanQty: 10, poNo: "PO-2" }),
      item({ id: "c", partNo: "OTHER", lineQty: 5 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(groups[0].scanQty).toBe(50);
    expect(groups[0].lineQty).toBe(150);
    expect(groups[0].poNos).toEqual(["PO-1", "PO-2"]);
    expect(groups[0].status).toBe("partial");
    expect(groups[1].status).toBe("open");
  });

  it("preserves first-seen group order", () => {
    const groups = buildCnScanGroups([
      item({ id: "a", partNo: "B" }),
      item({ id: "b", partNo: "A" }),
      item({ id: "c", partNo: "B" }),
    ]);
    expect(groups.map((g) => g.partNo)).toEqual(["B", "A"]);
  });

  it("groups same-part lines regardless of batch fields; dateCode/coo/cow show distinct member values", () => {
    const [g] = buildCnScanGroups([
      item({ id: "a", dateCode: "2440", coo: "CN" }),
      item({ id: "b", dateCode: "2441", coo: null }),
      item({ id: "c", dateCode: "2440", coo: "JP", cow: "US" }),
    ]);
    expect(g.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(g.dateCode).toBe("2440 · 2441");
    expect(g.coo).toBe("CN · JP");
    expect(g.cow).toBe("US");
  });

  it("batch display fields are null when no member line carries them", () => {
    const [g] = buildCnScanGroups([item({ id: "a" }), item({ id: "b" })]);
    expect(g.dateCode).toBeNull();
    expect(g.coo).toBeNull();
    expect(g.cow).toBeNull();
  });

  it("derives status: open / partial / complete / over / error", () => {
    const [open, partial, complete, over, error] = buildCnScanGroups([
      item({ id: "a", partNo: "P-open", lineQty: 10 }),
      item({ id: "b", partNo: "P-partial", lineQty: 10, scanQty: 4 }),
      item({ id: "c", partNo: "P-complete", lineQty: 10, scanQty: 10, scanStatus: "ok" }),
      item({ id: "d", partNo: "P-over", lineQty: 10, scanQty: 12, scanStatus: "warning" }),
      item({ id: "e", partNo: "P-error", lineQty: 10, scanQty: 10, scanStatus: "error" }),
    ]);
    expect(open.status).toBe("open");
    expect(partial.status).toBe("partial");
    expect(complete.status).toBe("complete");
    expect(over.status).toBe("over");
    expect(error.status).toBe("error");
  });

  it("error wins over quantity states", () => {
    const [g] = buildCnScanGroups([
      item({ id: "a", lineQty: 10, scanQty: 12, scanStatus: "warning" }),
      item({ id: "b", lineQty: 5, scanStatus: "error" }),
    ]);
    expect(g.status).toBe("error");
  });

  it("null lineQty makes the group total unknown; credit still shows partial", () => {
    const [g] = buildCnScanGroups([
      item({ id: "a", lineQty: 100, scanQty: 30 }),
      item({ id: "b", lineQty: null, scanQty: 10 }),
    ]);
    expect(g.scanQty).toBe(40);
    expect(g.lineQty).toBeNull();
    expect(g.status).toBe("partial");
  });
});
