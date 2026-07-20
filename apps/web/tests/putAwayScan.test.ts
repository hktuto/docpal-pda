import { describe, expect, it } from "vitest";
import { findPutAwayTarget } from "../utils/putAwayScan";
import type { PutAwayExpectedItem } from "../services/types";

function item(partNo: string, remainingQty: number, id = partNo): PutAwayExpectedItem {
  return { id, partNo, remainingQty } as PutAwayExpectedItem;
}

describe("findPutAwayTarget", () => {
  it("returns the first item with a matching part and enough remaining qty", () => {
    const items = [item("ABC123", 100), item("DEF456", 50)];
    expect(findPutAwayTarget(items, "ABC123", 40)?.id).toBe("ABC123");
  });

  it("normalizes case and whitespace when matching the part number", () => {
    const items = [item("ABC123", 100)];
    expect(findPutAwayTarget(items, "  abc123 ", 10)?.id).toBe("ABC123");
  });

  it("skips items whose remaining qty does not fit and falls through to the next", () => {
    const items = [item("ABC123", 10, "first"), item("ABC123", 100, "second")];
    expect(findPutAwayTarget(items, "ABC123", 40)?.id).toBe("second");
  });

  it("returns null when no item matches the part number", () => {
    const items = [item("ABC123", 100)];
    expect(findPutAwayTarget(items, "ZZZ999", 10)).toBeNull();
  });

  it("returns null when every matching item has insufficient remaining qty", () => {
    const items = [item("ABC123", 10), item("ABC123", 20)];
    expect(findPutAwayTarget(items, "ABC123", 40)).toBeNull();
  });

  it("rejects empty part numbers and non-positive or non-integer qty", () => {
    const items = [item("ABC123", 100)];
    expect(findPutAwayTarget(items, "", 10)).toBeNull();
    expect(findPutAwayTarget(items, "ABC123", 0)).toBeNull();
    expect(findPutAwayTarget(items, "ABC123", -5)).toBeNull();
    expect(findPutAwayTarget(items, "ABC123", 1.5)).toBeNull();
    expect(findPutAwayTarget(items, "ABC123", NaN)).toBeNull();
  });
});
