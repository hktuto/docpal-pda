import { describe, expect, it } from "vitest";
import { classifyPutAwayScan, findPutAwayTarget } from "../utils/putAwayScan";
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

  it("matches a space-stripped label item id against a spaced master part number", () => {
    // Supplier templates strip all whitespace (collapseSpaces); the master
    // part number keeps its spaces.
    const items = [item("IC-TL46 TO46-2L1", 300)];
    expect(findPutAwayTarget(items, "IC-TL46TO46-2L1", 300)?.id).toBe("IC-TL46 TO46-2L1");
  });

  it("matches the label's WCL item no against the item's part number or WCL item no", () => {
    const items = [
      { id: "1", partNo: "IC-TL46 TO46-2L1", wclItemNo: "ICHAUS/IC-TL46 TO46-2L1", remainingQty: 300 } as PutAwayExpectedItem,
    ];
    expect(findPutAwayTarget(items, "", 300, "ICHAUS/IC-TL46 TO46-2L1")?.id).toBe("1");
    expect(findPutAwayTarget(items, "ICHAUS/IC-TL46 TO46-2L1", 300)?.id).toBe("1");
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

describe("classifyPutAwayScan", () => {
  const shelves = [{ code: "EG01" }, { code: "A-01-01" }] as Parameters<typeof classifyPutAwayScan>[1];
  const boxes = [
    { id: "BOX-H-20261005-0001", status: "open" },
    { id: "BOX-H-20261005-0002", status: "closed" },
  ] as Parameters<typeof classifyPutAwayScan>[2];

  it("classifies an exact shelf code (case-insensitive) as a shelf scan", () => {
    expect(classifyPutAwayScan("EG01", shelves, boxes)).toEqual({ type: "shelf", code: "EG01" });
    expect(classifyPutAwayScan("eg01", shelves, boxes)).toEqual({ type: "shelf", code: "EG01" });
  });

  it("classifies an order's box id as a box scan with the existing box", () => {
    expect(classifyPutAwayScan("BOX-H-20261005-0002", shelves, boxes)).toEqual({
      type: "box",
      boxId: "BOX-H-20261005-0002",
      existing: boxes[1],
      staging: false,
    });
  });

  it("classifies the order's staging box id as a staging box scan", () => {
    expect(classifyPutAwayScan("BOX-H-20261002-0001", shelves, boxes, "BOX-H-20261002-0001")).toEqual({
      type: "box",
      boxId: "BOX-H-20261002-0001",
      existing: null,
      staging: true,
    });
    // Case-insensitive; without the stagingBoxId it is just an unknown box.
    expect(classifyPutAwayScan("box-h-20261002-0001", shelves, boxes, "BOX-H-20261002-0001")).toEqual({
      type: "box",
      boxId: "BOX-H-20261002-0001",
      existing: null,
      staging: true,
    });
    expect(classifyPutAwayScan("BOX-H-20261002-0001", shelves, boxes)).toEqual({
      type: "box",
      boxId: "BOX-H-20261002-0001",
      existing: null,
      staging: false,
    });
  });

  it("classifies an unknown BOX-* id as a new box scan", () => {
    expect(classifyPutAwayScan("BOX-H-20261005-9999", shelves, boxes)).toEqual({
      type: "box",
      boxId: "BOX-H-20261005-9999",
      existing: null,
      staging: false,
    });
  });

  it("falls through to item for supplier labels and unknown ids", () => {
    expect(classifyPutAwayScan('{"type":"Versandetikett"}', shelves, boxes)).toEqual({ type: "item" });
    expect(classifyPutAwayScan("IC-TL46 TO46-2L1", shelves, boxes)).toEqual({ type: "item" });
    expect(classifyPutAwayScan("", shelves, boxes)).toEqual({ type: "item" });
  });
});
