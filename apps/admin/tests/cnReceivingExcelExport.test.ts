import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { parseCnReceivingAoa } from "~/utils/cnReceivingExcel";
import { buildCnReceivingExportAoa, cnPutAwayQrPayload } from "~/utils/cnReceivingExcelExport";
import type { CnOrderDetail, CnOrderItemRow } from "~/utils/flowApi";

const require = createRequire(import.meta.url);

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

describe("buildCnReceivingExportAoa — round-trip through the parser", () => {
  it("re-reads the generated sheet with the same header fields, items and totals", () => {
    const XLSX = require("xlsx");
    const { aoa, merges } = buildCnReceivingExportAoa(DETAIL);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!merges"] = merges;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const wb2 = XLSX.read(buf);
    const aoa2 = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]], { header: 1, defval: "" }) as unknown[][];
    const parsed = parseCnReceivingAoa(aoa2);

    // Header fields (recovered from the items' orderData passthrough).
    expect(parsed.invoiceNo).toBe("TE20261010-2");
    expect(parsed.receivedDate).toBe("2026-10-10");
    expect(parsed.supplier).toBe("TE");
    expect(parsed.receivedOffice).toBe("深圳仓");

    // Items — 訂單號 carries the PO number, 发货项 carries the order no.
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({
      orderNo: "7004951243",
      cartonNo: "3",
      partNo: "TE-AMP(5205208-1)",
      dateCode: "2641",
      qty: "2400",
      office: "SZ01",
      poNo: "329062100T3",
    });
    expect(parsed.items[1].orderNo).toBe("7004951244");
    expect(parsed.items[1].qty).toBe("800");

    // Totals + the 合计 row.
    expect(parsed.totals).toEqual({ carton: 4, qty: 3200 });
    expect(parsed.sheetTotals).toEqual({ carton: 4, qty: 3200 });
  });

  it("merges the title across A-E and keeps blanks when no jsonb passthrough exists", () => {
    const { aoa, merges } = buildCnReceivingExportAoa({ ...DETAIL, items: [item({ id: "i3", poNo: "P1", receivedQty: 10 })] });
    expect(merges).toEqual([{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }]);
    expect(aoa[3][1]).toBe(""); // 收貨辦事處 blank without orderData
    expect(aoa[4][1]).toBe(""); // 供應商 blank
  });

  it("falls back to the matched workflow's payload for the header fields", () => {
    const detail: CnOrderDetail = {
      ...DETAIL,
      order: { ...DETAIL.order, deliveryDate: null },
      items: [item({ id: "i3", poNo: "P1", receivedQty: 10, orderData: null })],
      workflow: {
        supplier: "TE",
        receivedOffice: "深圳仓",
        receiptNo: "RCPT-9",
        invoiceNo: "TE20261010-2",
        receivedDate: "2026-10-12",
      },
    };
    const { aoa } = buildCnReceivingExportAoa(detail);
    expect(aoa[3][1]).toBe("深圳仓"); // 收貨辦事處 ← workflow
    expect(aoa[3][7]).toBe("2026-10-12"); // 收貨日期 ← workflow.receivedDate (no deliveryDate)
    expect(aoa[4][1]).toBe("TE"); // 供應商 ← workflow
    expect(aoa[5][1]).toBe("RCPT-9"); // 發票號碼 ← workflow
  });

  it("adds a 建議貨架 column with each item's suggestedShelf", () => {
    const { aoa } = buildCnReceivingExportAoa({
      ...DETAIL,
      items: [item({ id: "i1", poNo: "P1", receivedQty: 10, suggestedShelf: "A-01-01" }), item({ id: "i2", poNo: "P2", receivedQty: 5 })],
    });
    const headerRow = aoa.find((r) => r[0] === "訂單號")!;
    expect(headerRow[9]).toBe("建議貨架");
    const i1Row = aoa.find((r) => r[0] === "P1")!;
    expect(i1Row[9]).toBe("A-01-01");
    const i2Row = aoa.find((r) => r[0] === "P2")!;
    expect(i2Row[9]).toBe("");
  });

  it("emits item rows sorted by po_line (numeric-aware, blanks last)", () => {
    const { aoa } = buildCnReceivingExportAoa({
      ...DETAIL,
      items: [
        item({ id: "a", poNo: "PA", receivedQty: 1, poLine: "10" }),
        item({ id: "b", poNo: "PB", receivedQty: 1, poLine: null }),
        item({ id: "c", poNo: "PC", receivedQty: 1, poLine: "9" }),
        item({ id: "d", poNo: "PD", receivedQty: 1, poLine: "1" }),
      ],
    });
    const headerIdx = aoa.findIndex((r) => r[0] === "訂單號");
    const emitted = aoa.slice(headerIdx + 1, headerIdx + 5).map((r) => r[0]);
    expect(emitted).toEqual(["PD", "PC", "PA", "PB"]); // 1, 9, 10, blank
  });
});

describe("cnPutAwayQrPayload", () => {
  it("builds /put-away/<orderId>?task=<taskId> when a put-away task exists", () => {
    expect(cnPutAwayQrPayload({ ...DETAIL, putAway: { id: "task-1", status: "pending" } })).toBe(
      "/put-away/o1?task=task-1"
    );
  });

  it("returns null when there is no put-away task yet", () => {
    expect(cnPutAwayQrPayload(DETAIL)).toBeNull();
  });
});
