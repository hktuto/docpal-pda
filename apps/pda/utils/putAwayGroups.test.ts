import { describe, expect, it } from "vitest";
import { groupPutAwayItems, skipScanLines } from "./putAwayGroups";
import type { PutAwayExpectedItem } from "~/services/types";

function item(over: Partial<PutAwayExpectedItem>): PutAwayExpectedItem {
  return {
    id: over.id ?? "i1",
    partNo: "ABC-123",
    wclItemNo: null,
    lineQty: 100,
    receivedQty: 100,
    pickedQty: 0,
    putAwayQty: 0,
    allocatedQty: 0,
    remainingQty: 100,
    dateCode: null,
    lotCode: null,
    coo: null,
    cow: null,
    ...over,
  };
}

describe("skipScanLines", () => {
  it("returns one portion per selected member line with qty = remainingQty", () => {
    const groups = groupPutAwayItems(
      [
        item({ id: "a1", partNo: "ABC-123", remainingQty: 60 }),
        item({ id: "a2", partNo: "ABC-123", remainingQty: 40 }),
        item({ id: "b1", partNo: "ZZ-9", remainingQty: 10 }),
      ],
      {}
    );
    expect(groups).toHaveLength(2);
    const lines = skipScanLines(groups, new Set([groups[0].key]));
    expect(lines).toEqual([
      { item: expect.objectContaining({ id: "a1" }), qty: 60 },
      { item: expect.objectContaining({ id: "a2" }), qty: 40 },
    ]);
  });

  it("skips fully put-away lines and unselected groups", () => {
    const groups = groupPutAwayItems(
      [
        item({ id: "a1", partNo: "ABC-123", remainingQty: 0 }),
        item({ id: "b1", partNo: "ZZ-9", remainingQty: 10 }),
      ],
      {}
    );
    expect(skipScanLines(groups, new Set(groups.map((g) => g.key)))).toEqual([
      { item: expect.objectContaining({ id: "b1" }), qty: 10 },
    ]);
  });

  it("returns nothing for an empty selection", () => {
    const groups = groupPutAwayItems([item({ id: "a1" })], {});
    expect(skipScanLines(groups, new Set())).toEqual([]);
  });
});
