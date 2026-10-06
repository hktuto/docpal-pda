import { describe, expect, it } from "vitest";
import { classifyPutAwayScan, findPutAwayTarget, findPutAwayTargets } from "../utils/putAwayScan";
import { groupPutAwayItems, putAwayGroupFieldValue } from "../utils/putAwayGroups";
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

describe("findPutAwayTargets", () => {
  it("splits one scan's qty FIFO across same-part lines (300 + 20000 ← 20300)", () => {
    const items = [item("ABC123", 300, "line1"), item("ABC123", 20000, "line2")];
    expect(findPutAwayTargets(items, "ABC123", 20300)).toEqual([
      { item: items[0], qty: 300 },
      { item: items[1], qty: 20000 },
    ]);
  });

  it("returns a single portion when one line covers the whole qty", () => {
    const items = [item("ABC123", 300, "line1"), item("ABC123", 20000, "line2")];
    expect(findPutAwayTargets(items, "ABC123", 200)).toEqual([
      { item: items[0], qty: 200 },
    ]);
  });

  it("returns null when the aggregated remaining cannot cover the qty", () => {
    const items = [item("ABC123", 300, "line1"), item("ABC123", 200, "line2")];
    expect(findPutAwayTargets(items, "ABC123", 501)).toBeNull();
  });

  it("only consumes lines matching the scanned part", () => {
    const items = [item("ABC123", 100, "line1"), item("DEF456", 100, "line2")];
    expect(findPutAwayTargets(items, "DEF456", 150)).toBeNull();
    expect(findPutAwayTargets(items, "DEF456", 100)).toEqual([
      { item: items[1], qty: 100 },
    ]);
  });

  it("skips exhausted lines and rejects invalid scans like findPutAwayTarget", () => {
    const items = [item("ABC123", 0, "done"), item("ABC123", 50, "left")];
    expect(findPutAwayTargets(items, "ABC123", 50)).toEqual([
      { item: items[1], qty: 50 },
    ]);
    expect(findPutAwayTargets(items, "", 10)).toBeNull();
    expect(findPutAwayTargets(items, "ABC123", 0)).toBeNull();
  });
});

describe("groupPutAwayItems", () => {
  function fullItem(partNo: string, over: Partial<PutAwayExpectedItem> = {}): PutAwayExpectedItem {
    return {
      id: partNo,
      partNo,
      wclItemNo: null,
      lineQty: 0,
      receivedQty: 0,
      putAwayQty: 0,
      remainingQty: 0,
      dateCode: null,
      lotCode: null,
      coo: null,
      cow: null,
      ...over,
    } as PutAwayExpectedItem;
  }

  it("merges same-part lines into one group with summed qty, preserving order", () => {
    const items = [
      fullItem("ABC123", { id: "line1", lineQty: 300, receivedQty: 300, remainingQty: 300, dateCode: "2630" }),
      fullItem("DEF456", { id: "line2", lineQty: 10, remainingQty: 10 }),
      fullItem("ABC123", { id: "line3", lineQty: 20000, receivedQty: 20000, remainingQty: 20000, putAwayQty: 5 }),
    ];
    const groups = groupPutAwayItems(items, { line3: 7 });
    expect(groups.map((g) => g.key)).toEqual(["ABC123", "DEF456"]);
    const abc = groups[0];
    expect(abc.items.map((i) => i.id)).toEqual(["line1", "line3"]);
    expect(abc.lineQty).toBe(20300);
    expect(abc.receivedQty).toBe(20300);
    expect(abc.remainingQty).toBe(20300);
    expect(abc.putAwayQty).toBe(5);
    expect(abc.stagedQty).toBe(7);
  });

  it("groups space-insensitively and keeps lineQty null when any member is null", () => {
    const items = [
      fullItem("ABC 123", { id: "line1", lineQty: null }),
      fullItem("ABC123", { id: "line2", lineQty: 100 }),
    ];
    const groups = groupPutAwayItems(items, {});
    expect(groups).toHaveLength(1);
    expect(groups[0].lineQty).toBeNull();
  });

  it("sums qty fields and joins distinct batch fields for display", () => {
    const items = [
      fullItem("ABC123", { id: "line1", lineQty: 300, receivedQty: 300, remainingQty: 300, dateCode: "2630" }),
      fullItem("ABC123", { id: "line2", lineQty: 200, receivedQty: 200, remainingQty: 200, dateCode: "2630", lotCode: "L1" }),
    ];
    const [group] = groupPutAwayItems(items, {});
    expect(putAwayGroupFieldValue("expected_qty", group)).toBe("500");
    expect(putAwayGroupFieldValue("received_qty", group)).toBe("500");
    expect(putAwayGroupFieldValue("remaining_qty", group)).toBe("500");
    expect(putAwayGroupFieldValue("date_code", group)).toBe("2630");
    expect(putAwayGroupFieldValue("lot_code", group)).toBe("L1");
    expect(putAwayGroupFieldValue("coo", group)).toBe("—");
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
