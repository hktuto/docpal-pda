import { describe, expect, it } from "vitest";
import { pickingListDocToPrintDoc, type PickingListDocument } from "~/utils/documentPrintPicking";

const HEAD: PickingListDocument["head"] = {
  orderId: "order-1",
  orderNo: "PO-1001",
  poNo: "PO-XYZ",
  customerCode: "CUST1",
  shipTo: "HK",
  orgId: 2,
  subInventoryCode: "HK01",
  status: "picking",
  allocationStatus: "allocated",
  remark: null,
};

function doc(groups: PickingListDocument["groups"]): PickingListDocument {
  return { head: HEAD, generatedAt: "2026-11-06T08:00:00Z", groups };
}

describe("pickingListDocToPrintDoc", () => {
  it("carries the item columns on the group's first row only; continuation rows are blank", () => {
    const d = pickingListDocToPrintDoc(
      doc([
        {
          partNo: "P1",
          qty: 10,
          allocatedQty: 10,
          pickedQty: 4,
          allocs: [
            { kind: "lot", shelfCode: "A-01", boxId: "BOX-1", dateCode: "2641", lotCode: "L1", coo: "HK", cow: null, orgId: 2, subInventoryCode: "HK01", qty: 6 },
            { kind: "lot", shelfCode: "A-02", boxId: null, dateCode: null, lotCode: null, coo: null, cow: null, orgId: null, subInventoryCode: null, qty: 4 },
          ],
        },
      ])
    );
    expect(d.table.rows).toHaveLength(2);
    expect(d.table.rows[0].slice(0, 4)).toEqual(["P1", 10, 10, 4]);
    expect(d.table.rows[1].slice(0, 4)).toEqual(["", "", "", ""]);
  });

  it("maps lot allocs to Shelf rows with \" / \" joins, receiving allocs to dock rows", () => {
    const d = pickingListDocToPrintDoc(
      doc([
        {
          partNo: "P1",
          qty: 10,
          allocatedQty: 10,
          pickedQty: 0,
          allocs: [
            { kind: "lot", shelfCode: "A-01", boxId: "BOX-1", dateCode: "2641", lotCode: "L1", coo: "HK", cow: "CN", orgId: 2, subInventoryCode: "HK01", qty: 6 },
            { kind: "receiving", receivingBatchNo: "RB-9", qty: 4 },
          ],
        },
      ])
    );
    expect(d.table.rows[0].slice(4)).toEqual(["Shelf", "A-01", "BOX-1", "2641", "L1", "HK / CN", "2 / HK01", 6]);
    expect(d.table.rows[1].slice(4)).toEqual(["Receiving RB-9", "(dock)", "", "", "", "", "", 4]);
  });

  it("adds an UNALLOCATED shortfall row when allocs do not cover the item qty", () => {
    const d = pickingListDocToPrintDoc(
      doc([
        {
          partNo: "P1",
          qty: 10,
          allocatedQty: 4,
          pickedQty: 0,
          allocs: [{ kind: "receiving", receivingBatchNo: "RB-9", qty: 4 }],
        },
      ])
    );
    const unalloc = d.table.rows[1];
    expect(unalloc.slice(0, 5)).toEqual(["", "", "", "", "UNALLOCATED"]);
    expect(unalloc[11]).toBe(6); // 10 − 4 shortfall in Alloc Qty
  });

  it("emits a single \"(no allocation)\" row for a group without allocs", () => {
    const d = pickingListDocToPrintDoc(doc([{ partNo: "P1", qty: 5, allocatedQty: 0, pickedQty: 0, allocs: [] }]));
    expect(d.table.rows).toHaveLength(1);
    expect(d.table.rows[0]).toEqual(["P1", 5, 0, 0, "(no allocation)", "", "", "", "", "", "", ""]);
  });

  it("separates groups with a blank row and sums the totals row", () => {
    const d = pickingListDocToPrintDoc(
      doc([
        { partNo: "P1", qty: 10, allocatedQty: 4, pickedQty: 1, allocs: [] },
        { partNo: "P2", qty: 5, allocatedQty: 5, pickedQty: 2, allocs: [] },
      ])
    );
    // no-alloc row, blank separator, no-alloc row
    expect(d.table.rows).toHaveLength(3);
    expect(d.table.rows[1].every((c) => c === "")).toBe(true);
    expect(d.table.totals).toEqual(["Total", 15, 9, 3, "", "", "", "", "", "", "", ""]);
  });

  it("mirrors the xlsx head rows, title/ref and picking order-link QR", () => {
    const d = pickingListDocToPrintDoc(doc([]));
    expect(d.title).toBe("Picking List — PO-1001");
    expect(d.ref).toBe("PO-1001");
    expect(d.head).toEqual([
      ["Order No", "PO-1001"],
      ["PO No", "PO-XYZ"],
      ["Customer", "CUST1"],
      ["Ship To", "HK"],
      ["Org / Sub-Inventory", "2 / HK01"],
      ["Status", "picking"],
      ["Allocation Status", "allocated"],
      ["Remark", ""],
      ["Generated At", "2026-11-06T08:00:00Z"],
    ]);
    expect(d.qr).toEqual({ payload: "warehouse://picking/order-1" });
  });

  it("derives column weights from the xlsx column widths, normalized to 1", () => {
    const d = pickingListDocToPrintDoc(doc([]));
    expect(d.table.columns.map((c) => c.header)).toEqual([
      "Part Number",
      "Item Qty",
      "Allocated Qty",
      "Picked Qty",
      "Source",
      "Location (Shelf)",
      "Box",
      "Date Code",
      "Lot Code",
      "COO / COW",
      "Source Org / Sub-Inv",
      "Alloc Qty",
    ]);
    expect(d.table.columns.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 10);
    // Widest column = Part Number (26), narrowest = Item Qty / Picked Qty (10).
    expect(d.table.columns[0].weight).toBeCloseTo(26 / 168, 10);
    expect(d.table.columns[1].weight).toBeCloseTo(10 / 168, 10);
  });
});
