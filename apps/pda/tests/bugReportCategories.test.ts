import { describe, it, expect } from "vitest";
import { categoriesForRoute, GENERIC_CATEGORIES } from "../utils/bugReportCategories";

describe("categoriesForRoute", () => {
  it("curates per page", () => {
    expect(categoriesForRoute("/put-away/BOX-1")).toContain("duplicate");
    expect(categoriesForRoute("/put-away/BOX-1")).not.toContain("date_code");
    expect(categoriesForRoute("/label-printing")).toEqual(["label_print", "blocked", "other"]);
  });

  it("prefers the longest matching prefix (/receiving-cn-scan over /receiving)", () => {
    const cn = categoriesForRoute("/receiving-cn-scan/RO-1");
    expect(cn).not.toContain("duplicate"); // receiving's list has it, cn-scan's does not
    expect(cn).toContain("date_code");
  });

  it("falls back to the generic set for unknown routes and the home page", () => {
    expect(categoriesForRoute("/")).toEqual(GENERIC_CATEGORIES);
    expect(categoriesForRoute("/some-new-page")).toEqual(GENERIC_CATEGORIES);
    expect(categoriesForRoute("/stock-search")).not.toEqual(GENERIC_CATEGORIES);
  });

  it("always ends with other", () => {
    for (const p of ["/", "/picking", "/login", "/goods-verify/1"]) {
      const list = categoriesForRoute(p);
      expect(list[list.length - 1]).toBe("other");
    }
  });
});
