import { describe, expect, it } from "vitest";
import { matchLabelPackages } from "../utils/measuringLabelMatch";
import type { MeasuringPackage } from "../services/types";

function pkg(id: string, labelBarcode: string | null, verified = false): MeasuringPackage {
  return { id, qty: 7500, partNo: "PART-1", labelBarcode, verified, verifyVerified: verified } as MeasuringPackage;
}

const notDone = (p: MeasuringPackage) => p.verified;

describe("matchLabelPackages", () => {
  it("returns every unverified package carrying the scanned label", () => {
    const packages = [pkg("a", "LABEL-15000"), pkg("b", "LABEL-15000"), pkg("c", "OTHER")];
    const result = matchLabelPackages(packages, "LABEL-15000", notDone);
    expect(result).toEqual({ kind: "verify", packages: [packages[0], packages[1]] });
  });

  it("excludes already-verified portions from the verify set", () => {
    const packages = [pkg("a", "LABEL-15000", true), pkg("b", "LABEL-15000")];
    const result = matchLabelPackages(packages, "LABEL-15000", notDone);
    expect(result).toEqual({ kind: "verify", packages: [packages[1]] });
  });

  it("reports already-verified when every package with the label is done", () => {
    const packages = [pkg("a", "LABEL-15000", true), pkg("b", "LABEL-15000", true)];
    expect(matchLabelPackages(packages, "LABEL-15000", notDone)).toEqual({
      kind: "already-verified",
      count: 2,
    });
  });

  it("returns null for legacy rows with no stored label (qty-match fallback)", () => {
    const packages = [pkg("a", null), pkg("b", null)];
    expect(matchLabelPackages(packages, "LABEL-15000", notDone)).toBeNull();
  });

  it("returns null when the scan string is empty or absent", () => {
    const packages = [pkg("a", "LABEL-15000")];
    expect(matchLabelPackages(packages, "", notDone)).toBeNull();
    expect(matchLabelPackages(packages, "   ", notDone)).toBeNull();
    expect(matchLabelPackages(packages, undefined, notDone)).toBeNull();
  });

  it("scopes the match to the target package when one is given", () => {
    const packages = [pkg("a", "LABEL-15000"), pkg("b", "LABEL-15000")];
    const result = matchLabelPackages(packages, "LABEL-15000", notDone, "b");
    expect(result).toEqual({ kind: "verify", packages: [packages[1]] });
  });
});
