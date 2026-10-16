import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseCnReceivingAoa } from "~/utils/cnReceivingExcel";

const require = createRequire(import.meta.url);

// The real reference sheet (supporting_doc/cn_receiving/TE20261010-2.xls) —
// read via xlsx here and passed to the parser as a plain AOA.
const FIXTURE = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../supporting_doc/cn_receiving/TE20261010-2.xls"
);

function fixtureAoa(): unknown[][] {
  const XLSX = require("xlsx");
  const buf = readFileSync(FIXTURE);
  const wb = XLSX.read(buf);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
}

describe("parseCnReceivingAoa — TE20261010-2.xls", () => {
  const result = parseCnReceivingAoa(fixtureAoa());

  it("parses the label/value header fields", () => {
    expect(result.supplier).toBe("TE");
    expect(result.invoiceNo).toBe("TE20261010-2");
    expect(result.receivedOffice).toBe("深圳仓");
    expect(result.receiptNo).toBe("");
  });

  it("converts the Excel serial date to YYYY-MM-DD", () => {
    expect(result.receivedDate).toBe("2026-10-10");
  });

  it("parses 6 item rows across the blank-row groups", () => {
    expect(result.items).toHaveLength(6);
    expect(result.items[0]).toEqual({
      orderNo: "329062100T3",
      cartonNo: "3",
      partNo: "TE-AMP(5205208-1)",
      dateCode: "2641",
      qty: "2400",
      weight: "",
      office: "广州办",
      poNo: "7004951243",
      remark: "",
    });
    const last = result.items[5];
    expect(last.orderNo).toBe("319084839T1");
    expect(last.dateCode).toBe("2639");
    expect(last.qty).toBe("9600");
  });

  it("keeps poNo as a string", () => {
    expect(typeof result.items[0].poNo).toBe("string");
    expect(result.items[0].poNo).toBe("7004951243");
    expect(result.items[4].poNo).toBe("43117760");
  });

  it("sums item totals and reads the 合计 row", () => {
    expect(result.totals).toEqual({ carton: 18, qty: 32000 });
    expect(result.sheetTotals).toEqual({ carton: 18, qty: 32000 });
  });
});

describe("parseCnReceivingAoa — synthetic edge cases", () => {
  it("handles a minimal sheet with string dates and no 合计 row", () => {
    const aoa = [
      ["收貨確認及付款通知書"],
      ["供應商 :", "ABC", "", "收貨日期:", "2026/1/5"],
      ["發票號碼:", "INV-9"],
      ["訂單號", "箱數", "型號", "摘要(D/C)", "數量(PCS)", "重量（KG)", "辦事處", "發貨項", "備註"],
      ["PO1", 2, "P-1", "2641", 100, 1.5, "广州办", 12345678901234567890, "note"],
      ["", "", "", "", "", "", "", "", ""],
      ["PO2", "", "P-2", "", "50", "", "", "", ""],
      ["收貨注意事項:", "blah"],
    ];
    const r = parseCnReceivingAoa(aoa);
    expect(r.supplier).toBe("ABC");
    expect(r.invoiceNo).toBe("");
    expect(r.receiptNo).toBe("INV-9");
    expect(r.receivedDate).toBe("2026-01-05");
    expect(r.items).toHaveLength(2);
    expect(r.items[0].cartonNo).toBe("2");
    expect(r.items[0].qty).toBe("100");
    expect(r.items[0].weight).toBe("1.5");
    expect(r.items[0].remark).toBe("note");
    expect(r.items[1].qty).toBe("50");
    expect(r.sheetTotals).toBeNull();
    expect(r.totals).toEqual({ carton: 2, qty: 150 });
  });

  it("returns an empty payload for a sheet with no item table", () => {
    const r = parseCnReceivingAoa([["hello"], ["world"]]);
    expect(r.items).toEqual([]);
    expect(r.totals).toEqual({ carton: 0, qty: 0 });
    expect(r.sheetTotals).toBeNull();
    expect(r.receivedDate).toBe("");
  });

  it("stops at the 合计 row even without 收貨注意事項 and ignores footer rows", () => {
    const aoa = [
      ["訂單號", "箱数", "型號", "摘要(D/C)", "數量(PCS)", "重量（KG)", "辦事處", "发货项", "備註"],
      ["A1", 1, "P", 2601, 10, "", "", "", ""],
      ["合计:", 1, "", "", 10],
      ["通知人(簽名):", "someone"],
    ];
    const r = parseCnReceivingAoa(aoa);
    expect(r.items).toHaveLength(1);
    expect(r.sheetTotals).toEqual({ carton: 1, qty: 10 });
  });

  it("passes an ISO string date through and rejects unrecognizable ones", () => {
    const aoa = [
      ["收貨日期:", "2026-10-10"],
      ["訂單號", "箱数"],
      ["A1", 1],
    ];
    expect(parseCnReceivingAoa(aoa).receivedDate).toBe("2026-10-10");
    const bad = parseCnReceivingAoa([
      ["收貨日期:", "not-a-date"],
      ["訂單號", "箱数"],
      ["A1", 1],
    ]);
    expect(bad.receivedDate).toBe("");
  });
});
