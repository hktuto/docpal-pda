import { describe, expect, it, vi } from "vitest";
import {
  dispatchVerifyScan,
  groupAggregatePackages,
  groupFullyRescanned,
  hasLabelWork,
} from "../utils/verifyDisplayGroups";
import type { MeasuringPackage, ScanVerifyTaskLabelResult } from "../services/types";

function pkg(
  id: string,
  qty: number,
  overrides: Partial<MeasuringPackage> = {}
): MeasuringPackage {
  return {
    id,
    qty,
    partNo: "PART-1",
    wclItemNo: null,
    dateCode: null,
    lotCode: null,
    coo: null,
    cow: null,
    verified: false,
    verifyVerified: false,
    rescannedQty: 0,
    ...overrides,
  } as MeasuringPackage;
}

describe("groupAggregatePackages", () => {
  it("groups packages per part + batch combo and sums qty/progress", () => {
    const groups = groupAggregatePackages([
      pkg("a", 10000, { rescannedQty: 4000, dateCode: "2440" }),
      pkg("b", 10000, { rescannedQty: 0, dateCode: "2440" }),
      pkg("c", 500, { dateCode: "2410", coo: "CN" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      partNo: "PART-1",
      dateCode: "2440",
      totalQty: 20000,
      rescannedQty: 4000,
    });
    expect(groups[0].packages.map((p) => p.id)).toEqual(["a", "b"]);
    expect(groups[1]).toMatchObject({ dateCode: "2410", coo: "CN", totalQty: 500 });
  });

  it("anchors the group key to the pick-time scanned values over the snapshot", () => {
    // Same part with different upstream snapshots but the same scanned batch
    // (the physical labels were identical) collapses into ONE group.
    const groups = groupAggregatePackages([
      pkg("a", 100, { dateCode: "2401", scannedDateCode: "2440" }),
      pkg("b", 100, { dateCode: "2402", scannedDateCode: "2440" }),
      pkg("c", 100, { dateCode: "2402", scannedDateCode: "2401" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].dateCode).toBe("2440");
    expect(groups[0].totalQty).toBe(200);
    expect(groups[1].dateCode).toBe("2401");
  });

  it("excludes label-mode packages (they render in the labels section)", () => {
    const groups = groupAggregatePackages([
      pkg("a", 10),
      pkg("b", 10, { labelMode: true }),
      pkg("c", 10, { labelMode: false }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].packages.map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("separates wclItemNo identities of the same partNo", () => {
    const groups = groupAggregatePackages([
      pkg("a", 10, { wclItemNo: "WCL/A" }),
      pkg("b", 10, { wclItemNo: "WCL/B" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("groupFullyRescanned compares summed credit against the total", () => {
    const [group] = groupAggregatePackages([
      pkg("a", 10, { rescannedQty: 10 }),
      pkg("b", 10, { rescannedQty: 10 }),
    ]);
    expect(groupFullyRescanned(group!)).toBe(true);
    group!.packages[1]!.rescannedQty = 9;
    group!.rescannedQty = 19;
    expect(groupFullyRescanned(group!)).toBe(false);
  });
});

describe("hasLabelWork", () => {
  it("is true with label-mode packages or an unverified required carton label", () => {
    expect(hasLabelWork([pkg("a", 1, { labelMode: true })], null)).toBe(true);
    expect(hasLabelWork([pkg("a", 1)], { cartonLabelRequired: true, cartonLabelVerified: false })).toBe(true);
    expect(hasLabelWork([pkg("a", 1)], { cartonLabelRequired: true, cartonLabelVerified: true })).toBe(false);
    expect(hasLabelWork([pkg("a", 1)], { cartonLabelRequired: false })).toBe(false);
    expect(hasLabelWork([], null)).toBe(false);
  });
});

describe("dispatchVerifyScan", () => {
  const labelHit: ScanVerifyTaskLabelResult = {
    kind: "item",
    packageId: "p1",
    expectations: { partNo: "PART-1", wclItemNo: null, coo: null, dateCode: "2440", qty: 10 },
  };

  it("tries the label match first and does not fall through on a hit", async () => {
    const scanLabel = vi.fn(async () => labelHit);
    const aggregate = vi.fn(async () => "agg");
    const result = await dispatchVerifyScan("RAW", { labelModeActive: true, scanLabel, aggregate });
    expect(result).toEqual({ kind: "label", result: labelHit });
    expect(scanLabel).toHaveBeenCalledWith("RAW");
    expect(aggregate).not.toHaveBeenCalled();
  });

  it("falls through to the aggregate matcher on a label miss", async () => {
    const scanLabel = vi.fn(async () => null);
    const aggregate = vi.fn(async () => "agg");
    const result = await dispatchVerifyScan("RAW", { labelModeActive: true, scanLabel, aggregate });
    expect(result).toEqual({ kind: "aggregate", result: "agg" });
    expect(scanLabel).toHaveBeenCalledTimes(1);
    expect(aggregate).toHaveBeenCalledWith("RAW");
  });

  it("skips the label endpoint entirely without label work", async () => {
    const scanLabel = vi.fn(async () => labelHit);
    const aggregate = vi.fn(async () => "agg");
    const result = await dispatchVerifyScan("RAW", { labelModeActive: false, scanLabel, aggregate });
    expect(result).toEqual({ kind: "aggregate", result: "agg" });
    expect(scanLabel).not.toHaveBeenCalled();
  });
});
