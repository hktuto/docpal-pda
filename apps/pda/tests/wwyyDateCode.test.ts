import { describe, expect, it } from "vitest";
import { compareWwyyDateCodes, parseWwyy } from "../utils/wwyyDateCode";

describe("parseWwyy", () => {
  it("parses strict 4-digit WWYY", () => {
    expect(parseWwyy("3726")).toEqual({ week: 37, year: 2026 });
    expect(parseWwyy("0126")).toEqual({ week: 1, year: 2026 });
    expect(parseWwyy("5225")).toEqual({ week: 52, year: 2025 });
  });

  it("rejects non-WWYY values", () => {
    expect(parseWwyy("")).toBeNull();
    expect(parseWwyy(null)).toBeNull();
    expect(parseWwyy("37262")).toBeNull();
    expect(parseWwyy("372")).toBeNull();
    expect(parseWwyy("0026")).toBeNull(); // week 00 invalid
    expect(parseWwyy("5426")).toBeNull(); // week 54 invalid
    expect(parseWwyy("2603")).toBeNull(); // year 2003 implausible — another on-label convention (e.g. YYWW), skip rather than mis-compare
    expect(parseWwyy("26-37")).toBeNull();
    expect(parseWwyy("ABCD")).toBeNull();
  });
});

describe("compareWwyyDateCodes", () => {
  it("compares equal / earlier / later within a year", () => {
    expect(compareWwyyDateCodes("2626", "2626")).toBe("equal");
    expect(compareWwyyDateCodes("2526", "2626")).toBe("earlier");
    expect(compareWwyyDateCodes("2726", "2626")).toBe("later");
  });

  it("compares across the year boundary by (year, week), not string order", () => {
    expect(compareWwyyDateCodes("5225", "0126")).toBe("earlier");
    expect(compareWwyyDateCodes("0126", "5225")).toBe("later");
  });

  it("returns null when either side is unparseable", () => {
    expect(compareWwyyDateCodes("26-37", "2626")).toBeNull();
    expect(compareWwyyDateCodes("2626", "")).toBeNull();
    expect(compareWwyyDateCodes("", "")).toBeNull();
    // a YYWW-convention target is not a valid WWYY — skip, never mis-compare
    expect(compareWwyyDateCodes("0926", "2603")).toBeNull();
  });
});
