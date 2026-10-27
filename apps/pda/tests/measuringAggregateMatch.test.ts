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
  it("prefers the WCL item no when one part no sits under two WCL item numbers", () => {
    // parts.part_no is not unique — a scanned wclItemNo (template group or
    // the single-brand derivation, e.g. ABLIC/<mpn>) narrows the pool.
    const packages = [
      pkg("ablic", 3000, { partNo: "S-812C33AMC-C2NT2U", wclItemNo: "ABLIC/S-812C33AMC-C2NT2U" }),
      pkg("other", 1000, { partNo: "S-812C33AMC-C2NT2U", wclItemNo: "OTHER/S-812C33AMC-C2NT2U" }),
    ];
    expect(
      matchAggregatePackages(packages, { partNo: "S-812C33AMC-C2NT2U", wclItemNo: "ABLIC/S-812C33AMC-C2NT2U", qty: 3000 })
    ).toEqual({ qty: 3000, credits: [{ packageId: "ablic", qty: 3000 }] });
    // a wclItemNo that matches nothing falls back to the union of both keys
    expect(
      matchAggregatePackages(packages, { partNo: "S-812C33AMC-C2NT2U", wclItemNo: "NOPE/X", qty: 1000 })
    ).toEqual({ qty: 1000, credits: [{ packageId: "ablic", qty: 1000 }] });
  });

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

  it("2026-10-05: matches the package's scanned part OR its WCL item no", () => {
    // The pick scan recorded the label's own part text (supplier part "SUP-99")
    // and WCL group — a measuring re-scan of the same label must match even
    // though neither key equals the picking item's part_no.
    const packages = [pkg("a", 1000, { partNo: "SUP-99", wclItemNo: "RK73H1J" })];
    expect(matchAggregatePackages(packages, { partNo: "SUP-99", qty: 1000 })).toEqual({
      qty: 1000,
      credits: [{ packageId: "a", qty: 1000 }],
    });
    expect(matchAggregatePackages(packages, { wclItemNo: "RK73H1J", qty: 1000 })).toEqual({
      qty: 1000,
      credits: [{ packageId: "a", qty: 1000 }],
    });
    expect(matchAggregatePackages(packages, { partNo: "RK73H1J", qty: 1000 })).not.toBeNull();
    expect(matchAggregatePackages(packages, { partNo: "OTHER", qty: 1000 })).toBeNull();
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

  it("2026-10-14: anchors batch fields to the pick-time scanned values when present", () => {
    // Source snapshot says lot 1806L801 / WWYY 3726 (upstream vocabulary) but
    // the pick scan recorded the label's own segment 5 "1625H713" — the
    // re-scan of the same label must match against the SCANNED value.
    const packages = [
      pkg("a", 1000, {
        dateCode: "3726",
        lotCode: "1806L801",
        scannedDateCode: "3726",
        scannedLotCode: "1625H713",
      }),
    ];
    expect(
      matchAggregatePackages(packages, { partNo: "PART-1", qty: 1000, lotCode: "1625H713" })
    ).toEqual({ qty: 1000, credits: [{ packageId: "a", qty: 1000 }] });
    // the upstream lot code must no longer reject the same-label re-scan
    expect(
      matchAggregatePackages(packages, { partNo: "PART-1", qty: 1000, lotCode: "1806L801" })
    ).toBeNull();
    // scanned coo wins over the source snapshot too
    const withCoo = [pkg("b", 1000, { coo: "JP", scannedCoo: "PH" })];
    expect(matchAggregatePackages(withCoo, { partNo: "PART-1", qty: 1000, coo: "PH" })).toEqual({
      qty: 1000,
      credits: [{ packageId: "b", qty: 1000 }],
    });
    expect(matchAggregatePackages(withCoo, { partNo: "PART-1", qty: 1000, coo: "JP" })).toBeNull();
  });

  it("2026-10-20: raw-label fallback rescues legacy rows the snapshot rejects", () => {
    // Real 192.168.3.99 case: a 2026-10-05..14 client stored labelBarcode but
    // no scanned_* fields; the upstream snapshot dateCode ("4026") differs
    // from the label-derived WWYY ("3726"), so the field comparison rejects
    // the same physical label. The raw scan string must prove the match.
    const RAW = ":PART-1::53:X:1916H792:S601:KOA+PART-1::::";
    const legacy = [
      pkg("a", 5000, {
        partNo: "PART-1",
        wclItemNo: "KOA+PART-1",
        dateCode: "4026",
        lotCode: " ",
        labelBarcode: RAW,
      }),
    ];
    const scan = { partNo: "PART-1", qty: 5000, dateCode: "3726", lotCode: "1916H792" };

    // Without the raw label: rejected (snapshot vocabulary differs).
    expect(matchAggregatePackages(legacy, scan)).toBeNull();
    // With the raw label: the same physical label matches.
    expect(matchAggregatePackages(legacy, scan, undefined, RAW)).toEqual({
      qty: 5000,
      credits: [{ packageId: "a", qty: 5000 }],
    });
    // Trailing/leading whitespace on either side must not matter.
    expect(matchAggregatePackages(legacy, scan, undefined, ` ${RAW} `)).toEqual({
      qty: 5000,
      credits: [{ packageId: "a", qty: 5000 }],
    });
    // A different label with the same part must NOT match via the fallback.
    expect(matchAggregatePackages(legacy, scan, undefined, ":PART-1::53:X:9999H999:S602:KOA+PART-1::::")).toBeNull();
    // targetPackageId scopes the fallback too.
    expect(matchAggregatePackages(legacy, scan, "other", RAW)).toBeNull();
    // Scanned qty beyond the labeled package's remaining still fails.
    expect(matchAggregatePackages(legacy, { ...scan, qty: 5001 }, undefined, RAW)).toBeNull();
    // Field match still wins first: no fallback needed when fields agree.
    expect(
      matchAggregatePackages(legacy, { partNo: "PART-1", qty: 5000, dateCode: "4026" }, undefined, "UNRELATED")
    ).toEqual({ qty: 5000, credits: [{ packageId: "a", qty: 5000 }] });
  });
});
