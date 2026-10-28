import { describe, expect, it } from "vitest";
import {
  isDuplicateOrderNo,
  isDuplicateRaw,
  normalizeOrderNo,
  orderTotalQty,
  type ManualReceivingDraftOrder,
} from "./manualReceiving";

function order(orderNo: string, qtys: number[] = []): ManualReceivingDraftOrder {
  return {
    orderNo,
    items: qtys.map((qty, i) => ({ uid: i + 1, partNo: `P${i}`, qty, dateCode: "", lotCode: "", coo: "", cow: "" })),
  };
}

describe("normalizeOrderNo", () => {
  it("trims, uppercases, collapses whitespace", () => {
    expect(normalizeOrderNo(" 329063176t3 ")).toBe("329063176T3");
    expect(normalizeOrderNo("329 063 176T3")).toBe("329063176T3");
    expect(normalizeOrderNo("")).toBe("");
  });
});

describe("isDuplicateOrderNo", () => {
  const orders = [order("329063176T3"), order("ABC-1")];
  it("matches space/case-insensitively", () => {
    expect(isDuplicateOrderNo(orders, "329063176t3")).toBe(true);
    expect(isDuplicateOrderNo(orders, "abc-1")).toBe(true);
    expect(isDuplicateOrderNo(orders, "NEW-9")).toBe(false);
  });
  it("ignores the row being edited", () => {
    expect(isDuplicateOrderNo(orders, "329063176T3", 0)).toBe(false);
    expect(isDuplicateOrderNo(orders, "ABC-1", 0)).toBe(true);
  });
});

describe("orderTotalQty / isDuplicateRaw", () => {
  it("sums item qtys", () => {
    expect(orderTotalQty(order("A", [30000, 5000]))).toBe(35000);
    expect(orderTotalQty(order("A"))).toBe(0);
  });
  it("detects a repeat raw label", () => {
    const o = order("A", [10]);
    o.items[0].raw = ":RAW-1:";
    expect(isDuplicateRaw(o, ":RAW-1:")).toBe(true);
    expect(isDuplicateRaw(o, ":RAW-2:")).toBe(false);
  });
});
