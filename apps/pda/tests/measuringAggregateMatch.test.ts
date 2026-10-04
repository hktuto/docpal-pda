import { describe, expect, it } from "vitest";
import { matchAggregatePackages, packageRemaining } from "../utils/measuringAggregateMatch";
import type { MeasuringPackage } from "../services/types";

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

describe("matchAggregatePackages", () => {
  it("credits the scan qty FIFO across identical-label packages (3 × 10k)", () => {
    const packages = [pkg("a", 10000), pkg("b", 10000), pkg("c", 10000)];
    expect(matchAggregatePackages(packages, { partNo: "PART-1", qty: 10000 })).toEqual({
      qty: 10000,
      credits: [{ packageId: "a", qty: 10000 }],
    });
    expect(matchAggregatePackages(packages, { partNo: "PART-1", qty: 25000 })).toEqual({
      qty: 25000,
      credits: [
        { packageId: "a", qty: 10000 },
        { packageId: "b", qty: 10000 },
        { packageId: "c", qty: 5000 },
      ],
    });
  });

  it("a 15k label covers two 7.5k portions", () => {
    const packages = [pkg("a", 7500), pkg("b", 7500)];
    expect(matchAggregatePackages(packages, { partNo: "PART-1", qty: 15000 })).toEqual({
      qty: 15000,
      credits: [
        { packageId: "a", qty: 7500 },
        { packageId: "b", qty: 7500 },
      ],
    });
  });

  it("partial scans accumulate against the remaining qty", () => {
    const packages = [pkg("a", 10000)];
    const first = matchAggregatePackages(packages, { partNo: "PART-1", qty: 5000 });
    expect(first).toEqual({ qty: 5000, credits: [{ packageId: "a", qty: 5000 }] });
    packages[0].rescannedQty = 5000;
    expect(packageRemaining(packages[0])).toBe(5000);
    expect(matchAggregatePackages(packages, { partNo: "PART-1", qty: 5000 })).toEqual({
      qty: 5000,
      credits: [{ packageId: "a", qty: 5000 }],
    });
  });

  it("rejects a scan qty over the group's remaining", () => {
    const packages = [pkg("a", 10000), pkg("b", 5000)];
    expect(matchAggregatePackages(packages, { partNo: "PART-1", qty: 15001 })).toBeNull();
    packages[0].rescannedQty = 10000;
    expect(matchAggregatePackages(packages, { partNo: "PART-1", qty: 5001 })).toBeNull();
  });

  it("reports already-done when matching packages are fully credited", () => {
    const packages = [pkg("a", 10000, { rescannedQty: 10000 }), pkg("b", 5000, { rescannedQty: 5000 })];
    expect(matchAggregatePackages(packages, { partNo: "PART-1", qty: 1000 })).toBe("already-done");
  });

  it("batch fields constrain only when both sides carry a value", () => {
    const packages = [
      pkg("a", 1000, { dateCode: "2431", lotCode: "L1", coo: "TW" }),
      pkg("b", 1000, { dateCode: "2432" }),
    ];
    // empty scan side never constrains: both packages are eligible
    expect(matchAggregatePackages(packages, { partNo: "PART-1", qty: 2000 })).toEqual({
      qty: 2000,
      credits: [
        { packageId: "a", qty: 1000 },
        { packageId: "b", qty: 1000 },
      ],
    });
    // both sides carry a value and agree → eligible
    expect(
      matchAggregatePackages(packages, { partNo: "PART-1", qty: 1000, dateCode: "2431" })
    ).toEqual({ qty: 1000, credits: [{ packageId: "a", qty: 1000 }] });
    // both sides carry a value and disagree → rejected
    expect(
      matchAggregatePackages([packages[0]], { partNo: "PART-1", qty: 1000, dateCode: "2432" })
    ).toBeNull();
    expect(
      matchAggregatePackages([packages[0]], { partNo: "PART-1", qty: 1000, coo: "CN" })
    ).toBeNull();
  });

  it("matches the label's WCL item no and is space-insensitive on part no", () => {
    const packages = [pkg("a", 1000, { partNo: "RK73 H1J" })];
    expect(matchAggregatePackages(packages, { wclItemNo: "RK73H1J", qty: 1000 })).toEqual({
      qty: 1000,
      credits: [{ packageId: "a", qty: 1000 }],
    });
    expect(matchAggregatePackages(packages, { partNo: "RK73H1J", qty: 1000 })).not.toBeNull();
  });

  it("returns null for a different part or a scan without any part key", () => {
    const packages = [pkg("a", 1000)];
    expect(matchAggregatePackages(packages, { partNo: "OTHER", qty: 1000 })).toBeNull();
    expect(matchAggregatePackages(packages, { qty: 1000 })).toBeNull();
  });

  it("scopes the match to the target package when one is given", () => {
    const packages = [pkg("a", 1000), pkg("b", 1000)];
    expect(matchAggregatePackages(packages, { partNo: "PART-1", qty: 1000 }, "b")).toEqual({
      qty: 1000,
      credits: [{ packageId: "b", qty: 1000 }],
    });
    expect(matchAggregatePackages(packages, { partNo: "PART-1", qty: 1500 }, "b")).toBeNull();
  });
});
