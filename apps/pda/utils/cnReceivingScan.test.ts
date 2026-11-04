import { describe, expect, it } from "vitest";
import { normalizePartKey } from "./cnReceivingScan";

describe("normalizePartKey", () => {
  it("trims, uppercases, strips all whitespace", () => {
    expect(normalizePartKey(" ab 123 ")).toBe("AB123");
    expect(normalizePartKey(null)).toBe("");
    expect(normalizePartKey(undefined)).toBe("");
  });

  it("unwraps TE AMP(...) wrappers", () => {
    expect(normalizePartKey("AMP(640385-8)")).toBe(normalizePartKey("640385-8"));
  });
});
