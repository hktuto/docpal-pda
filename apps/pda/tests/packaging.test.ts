import { describe, it, expect } from "vitest";
import { isPackagingNotReady } from "../utils/packaging";
import { I18nError } from "../composables/i18nError";
import { ApiError } from "../services/apiClient";
import { viewListChip, viewListRow, PDA_LIST_CHIP_FIELDS, DEFAULT_PDA_VIEW_CONFIG } from "../utils/viewConfig";
import type { PackagingOrderRow } from "../services/types";

describe("isPackagingNotReady", () => {
  it("matches the I18nError form (plain-text snake_case body)", () => {
    expect(isPackagingNotReady(new I18nError("packaging_not_ready"))).toBe(true);
    expect(isPackagingNotReady(new I18nError("packaging_order_not_found"))).toBe(false);
  });

  it("matches the ApiError 409 forms", () => {
    expect(isPackagingNotReady(new ApiError("x", 409, { error: "packaging_not_ready" }))).toBe(true);
    expect(isPackagingNotReady(new ApiError("packaging_not_ready", 409, { message: "packaging_not_ready" }))).toBe(true);
    expect(isPackagingNotReady(new ApiError("packaging_not_ready", 409))).toBe(true);
    expect(isPackagingNotReady(new ApiError("packaging_not_ready", 404))).toBe(false);
    expect(isPackagingNotReady(new Error("packaging_not_ready"))).toBe(false);
  });
});

describe("packaging list view config", () => {
  function row(over: Partial<PackagingOrderRow> = {}): PackagingOrderRow {
    return {
      id: "po1",
      orderNo: "SO-2001",
      customerCode: "ACME",
      shipTo: "ACME Electronics (HK)",
      poNo: "PO-9",
      boxCount: 2,
      packageCount: 6,
      grossWeightHint: 12.5,
      assignee: null,
      packagedAt: null,
      packagedBy: null,
      packedWeight: null,
      packedBoxCount: null,
      packedPalletCount: null,
      lastUpdateDate: "2026-11-10T00:00:00.000Z",
      ...over,
    };
  }

  it("defaults render the order title + customer/ship_to meta", () => {
    const view = viewListRow("packaging", { ...row() });
    expect(view.title).toBe("SO-2001");
    expect(view.meta).toEqual(["ACME · ACME Electronics (HK)"]);
  });

  it("boxCount chip renders with the configured label", () => {
    const chip = viewListChip("packaging", { ...row() }, DEFAULT_PDA_VIEW_CONFIG);
    expect(chip).toEqual({
      kind: "label",
      labelKey: "packaging.boxesChip",
      params: { count: 2 },
      cls: "badge--pending",
    });
    expect(viewListChip("packaging", { ...row({ boxCount: 0 }) }, DEFAULT_PDA_VIEW_CONFIG)).toBeNull();
  });

  it("chip catalog matches the backend (none / boxCount / packageCount)", () => {
    expect(PDA_LIST_CHIP_FIELDS.packaging).toEqual(["none", "boxCount", "packageCount"]);
  });
});
