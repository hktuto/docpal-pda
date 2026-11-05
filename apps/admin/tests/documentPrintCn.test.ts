import { describe, expect, it } from "vitest";
import { CN_EXPORT_ITEM_COLUMNS } from "~/utils/cnReceivingExcelExport";
import { buildCnReceivingPrintDoc } from "~/utils/documentPrintCn";
import type { CnOrderDetail, CnOrderItemRow } from "~/utils/flowApi";

function item(partial: Partial<CnOrderItemRow> & Pick<CnOrderItemRow, "id" | "poNo" | "receivedQty">): CnOrderItemRow {
  return {
    receivingInvoiceId: "inv1",
    invoiceNo: "TE20261010-2",
    partNo: "TE-AMP(5205208-1)",
    wclItemNo: null,
    poLine: null,
    lineQty: null,
    putAwayQty: 0,
    ctnNo: "",
    packingListNum: null,
    dateCode: null,
    lotCode: null,
    coo: null,
    cow: null,
    orgId: 2,
    subInventoryCode: null,
    putAwayLocations: [],
    suggestedShelf: null,
    additionalData: null,
    orderData: null,
    ...partial,
  };
}

const DETAIL: CnOrderDetail = {
  order: {
    id: "o1",
    batchNo: "TE20261010-2",
    status: "in_hand",
    deliveryDate: "2026-10-10",
    arrivedAt: null,
    arrivedBy: null,
    arrivedByName: null,
    orgId: 2,
    dateCode: null,
    createdDate: "2026-10-10T08:00:00Z",
  },
  invoices: [{ id: "inv1", invoiceNo: "TE20261010-2", totalQty: 3200, totalCtn: 4, deliveryDate: "2026-10-10" }],
  items: [
    item({
      id: "i1",
      poNo: "7004951243",
      poLine: "1",
      receivedQty: 2400,
      ctnNo: "3",
      dateCode: "2641",
      subInventoryCode: "SZ01",
      orderData: { orderNo: "329062100T3", supplier: "TE", receivedOffice: "深圳仓" },
    }),
    item({
      id: "i2",
      poNo: "7004951244",
      poLine: "2",
      receivedQty: 800,
      ctnNo: "1",
      dateCode: "2639",
      partNo: "TE-AMP(2-1971793-4)",
      orderData: { orderNo: "319084839T1" },
    }),
  ],
  putAway: null,
  workflow: null,
};

describe("buildCnReceivingPrintDoc", () => {
  it("uses exactly the CN_EXPORT_ITEM_COLUMNS headers so it cannot drift from the Excel layout", () => {
    const d = buildCnReceivingPrintDoc(DETAIL);
    expect(d.table.columns.map((c) => c.header)).toEqual(CN_EXPORT_ITEM_COLUMNS.map((c) => c.header));
    // Column weights are normalized to a sum of 1.
    expect(d.table.columns.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 10);
  });

  it("sorts items by poLine numeric-aware (\"2\" before \"10\", blanks last)", () => {
    const d = buildCnReceivingPrintDoc({
      ...DETAIL,
      items: [
        item({ id: "a", poNo: "PA", receivedQty: 1, poLine: "10" }),
        item({ id: "b", poNo: "PB", receivedQty: 1, poLine: null }),
        item({ id: "c", poNo: "PC", receivedQty: 1, poLine: "2" }),
      ],
    });
    expect(d.table.rows.map((r) => r[0])).toEqual(["PC", "PA", "PB"]);
  });

  it("fills the header jsonb-first, then falls back to the matched workflow", () => {
    const jsonbFirst = buildCnReceivingPrintDoc(DETAIL);
    expect(jsonbFirst.head).toEqual([
      ["收貨辦事處:", "深圳仓"],
      ["收貨日期:", "2026-10-10"],
      ["供應商:", "TE"],
      ["發票號碼:", ""],
    ]);

    const wfFallback = buildCnReceivingPrintDoc({
      ...DETAIL,
      order: { ...DETAIL.order, deliveryDate: null },
      items: [item({ id: "i3", poNo: "P1", receivedQty: 10, orderData: null })],
      workflow: { supplier: "TE", receivedOffice: "深圳仓", receiptNo: "RCPT-9", invoiceNo: "TE20261010-2", receivedDate: "2026-10-12" },
    });
    expect(wfFallback.head).toEqual([
      ["收貨辦事處:", "深圳仓"],
      ["收貨日期:", "2026-10-12"],
      ["供應商:", "TE"],
      ["發票號碼:", "RCPT-9"],
    ]);
  });

  it("builds rows via the shared column value functions and sums the 合计 totals", () => {
    const d = buildCnReceivingPrintDoc(DETAIL);
    expect(d.table.rows[0][0]).toBe("7004951243"); // 訂單號 ← poNo
    expect(d.table.rows[0][7]).toBe("329062100T3"); // 发货项 ← orderData.orderNo
    expect(d.table.totals).toEqual(["合计：", 4, "", "", 3200, "", "", "", "", ""]);
  });

  it("carries the fixed notice/signature lines and the batch ref", () => {
    const d = buildCnReceivingPrintDoc(DETAIL);
    expect(d.title).toBe("收貨確認及付款通知書");
    expect(d.ref).toBe("TE20261010-2");
    expect(d.foot[0]).toBe("收貨注意事項:");
    expect(d.foot).toHaveLength(4);
  });

  it("emits no QR when there is no put-away task, the order link when there is", () => {
    expect(buildCnReceivingPrintDoc(DETAIL).qr).toBeNull();
    const withTask = buildCnReceivingPrintDoc({ ...DETAIL, putAway: { id: "task-1", status: "pending" } });
    expect(withTask.qr).toEqual({ payload: "warehouse://putaway-cn/task-1" });
  });
});
