import { describe, expect, it } from "vitest";
import {
  groupReceivingItems,
  isItemFullyReceived,
} from "~/utils/receivingGrouping";
import type { DisplayReceivingItem, DisplayReceivingOrder } from "~/components/receiving/types";

type Invoice = DisplayReceivingOrder["invoices"][number];

const LABELS = { noCarton: "No carton" };

function item(overrides: Partial<DisplayReceivingItem>): DisplayReceivingItem {
  return {
    id: Math.random().toString(36).slice(2),
    partNo: "P-1",
    wclItemNo: null,
    lineQty: 10,
    receivedQty: 0,
    allocatedQty: 0,
    pickedQty: 0,
    putAwayQty: 0,
    ctnNo: null,
    poNo: "PO-1",
    poLine: "1",
    dateCode: "",
    lotCode: "",
    coo: "",
    cow: "",
    mismatch: null,
    ...overrides,
  } as DisplayReceivingItem;
}

function invoice(id: string, invoiceNo: string, items: DisplayReceivingItem[]): Invoice {
  return { id, invoiceNo, items } as Invoice;
}

describe("isItemFullyReceived", () => {
  it("requires a known expected qty covered by the received qty", () => {
    expect(isItemFullyReceived(item({ lineQty: 10, receivedQty: 10 }))).toBe(true);
    expect(isItemFullyReceived(item({ lineQty: 10, receivedQty: 9 }))).toBe(false);
    expect(isItemFullyReceived(item({ lineQty: null, receivedQty: 5 }))).toBe(false);
  });
});

describe("groupReceivingItems — invoice", () => {
  const inv = invoice("inv1", "INV-1234", [
    item({ ctnNo: "C1" }),
    item({ ctnNo: "C1", lineQty: 5, receivedQty: 5 }),
    item({ ctnNo: "C2" }),
    item({ lineQty: null, receivedQty: 3 }),
  ]);

  it("groups per invoice with carton sub-groups and a trailing no-carton group", () => {
    const groups = groupReceivingItems([inv], "invoice", LABELS);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.label).toBe("INV-1234");
    expect(g.subGroups.map((s) => s.label)).toEqual(["C1", "C2", "No carton"]);
    expect(g.subGroups[0].items).toHaveLength(2);
  });

  it("counts fully-received items and sums qtys (null expected when unknown)", () => {
    const g = groupReceivingItems([inv], "invoice", LABELS)[0];
    expect(g.totalCount).toBe(4);
    expect(g.receivedCount).toBe(1);
    expect(g.receivedQty).toBe(8);
    expect(g.expectedQty).toBeNull(); // one line has unknown expected qty
  });

  it("uses a single unlabeled sub-group when no carton numbers exist", () => {
    const groups = groupReceivingItems(
      [invoice("inv2", "INV-9", [item({}), item({})])],
      "invoice",
      LABELS
    );
    expect(groups[0].subGroups).toHaveLength(1);
    expect(groups[0].subGroups[0].label).toBe("");
  });
});

describe("groupReceivingItems — carton", () => {
  it("buckets across invoices with a trailing no-carton group", () => {
    const groups = groupReceivingItems(
      [
        invoice("inv1", "INV-1", [item({ ctnNo: "C1" }), item({ ctnNo: "C2" })]),
        invoice("inv2", "INV-2", [item({ ctnNo: "C1" }), item({})]),
      ],
      "carton",
      LABELS
    );
    expect(groups.map((g) => g.label)).toEqual(["C1", "C2", "No carton"]);
    expect(groups[0].subGroups[0].items).toHaveLength(2); // merged across invoices
  });
});

describe("groupReceivingItems — part-no", () => {
  it("merges lines across invoices by WCL item no and sums qty progress", () => {
    const groups = groupReceivingItems(
      [
        invoice("inv1", "INV-1", [
          item({ partNo: "A", lineQty: 10, receivedQty: 10 }),
          item({ partNo: "B", wclItemNo: "W-B", lineQty: 4, receivedQty: 1 }),
        ]),
        invoice("inv2", "INV-2", [
          item({ partNo: "A", lineQty: 6, receivedQty: 3 }),
          item({ partNo: "B2", wclItemNo: "W-B", lineQty: 4, receivedQty: 4 }),
        ]),
      ],
      "part-no",
      LABELS
    );
    expect(groups.map((g) => g.key)).toEqual(["A", "W-B"]);

    const a = groups[0];
    expect(a.subGroups[0].items).toHaveLength(2); // PO/line breakdown rows
    expect(a.expectedQty).toBe(16);
    expect(a.receivedQty).toBe(13);
    expect(a.receivedCount).toBe(1);

    const wb = groups[1];
    expect(wb.expectedQty).toBe(8);
    expect(wb.receivedQty).toBe(5);
  });

  it("falls back to the part no when no WCL item no exists", () => {
    const groups = groupReceivingItems(
      [invoice("inv1", "INV-1", [item({ partNo: "SOLO", wclItemNo: null })])],
      "part-no",
      LABELS
    );
    expect(groups[0].key).toBe("SOLO");
  });
});
