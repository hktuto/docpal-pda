import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseCnReceivingAoa, fillMergedCells } from "~/utils/cnReceivingExcel";

const require = createRequire(import.meta.url);

// The real reference sheet (supporting_doc/cn_receiving/TE20261010-2.xls) —
// read via xlsx here and passed to the parser as a plain AOA.
const FIXTURE = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../supporting_doc/cn_receiving/TE20261010-2.xls"
);

// Real sheet whose poNo (发货项) column is merged across item groups
// (rows 8-41, 42-43, 44-45 1-based in Excel; the value lives only in the
// top-left cell of each merged range).
const MERGED_FIXTURE = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../supporting_doc/cn_receiving/TE20261012-1.xls"
);

function fixtureAoa(): unknown[][] {
  const XLSX = require("xlsx");
  const buf = readFileSync(FIXTURE);
  const wb = XLSX.read(buf);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
}

function fixtureAoaWithMerges(file: string): { aoa: unknown[][]; merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] } {
  const XLSX = require("xlsx");
  const buf = readFileSync(file);
  const wb = XLSX.read(buf);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return {
    aoa: XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }),
    merges: (ws["!merges"] ?? []) as { s: { r: number; c: number }; e: { r: number; c: number } }[],
  };
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
      index: 1,
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
    expect(last.index).toBe(6);
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

describe("parseCnReceivingAoa — TE20261012-1.xls (merged poNo column)", () => {
  const { aoa, merges } = fixtureAoaWithMerges(MERGED_FIXTURE);
  const merged = fillMergedCells(aoa, merges);
  const result = parseCnReceivingAoa(merged.aoa, merged.filled);

  it("parses the header fields", () => {
    expect(result.supplier).toBe("TE");
    expect(result.invoiceNo).toBe("TE20261012-1");
    expect(result.receivedDate).toBe("2026-10-12");
  });

  it("fills the merged poNo down every row of each range", () => {
    expect(result.items).toHaveLength(39);
    // Merge rows 8-41 (Excel 1-based) → poNo 43102642 on all 34 items.
    expect(result.items[0].poNo).toBe("43102642");
    expect(result.items[1].poNo).toBe("43102642");
    expect(result.items[33].poNo).toBe("43102642");
    // Standalone rows after the merges keep their own poNo.
    expect(result.items[34].orderNo).toBe("329064689T1");
    expect(result.items[34].poNo).toBe("43102643");
    expect(result.items[36].orderNo).toBe("329064686T1");
    expect(result.items[36].poNo).toBe("43112757");
    expect(result.items[38].orderNo).toBe("329063890T3");
    expect(result.items[38].poNo).toBe("43102644");
  });

  it("sums item totals and reads the 合计 row", () => {
    expect(result.totals).toEqual({ carton: 114, qty: 2565220 });
    expect(result.sheetTotals).toEqual({ carton: 114, qty: 2565220 });
  });

  it("does NOT forward-fill poNo when merges are not applied", () => {
    const plain = parseCnReceivingAoa(aoa);
    expect(plain.items[1].poNo).toBe("");
  });
});

describe("fillMergedCells", () => {
  it("fills only empty cells inside the range and never overwrites values", () => {
    const aoa = [
      ["A", "X"],
      ["B", ""],
      ["C", "keep"],
    ];
    const filled = fillMergedCells(aoa, [{ s: { r: 0, c: 1 }, e: { r: 2, c: 1 } }]);
    expect(filled.aoa).toEqual([
      ["A", "X"],
      ["B", "X"],
      ["C", "keep"],
    ]);
    expect(filled.filled).toEqual(new Set(["1:1"]));
    // Input untouched.
    expect(aoa[1][1]).toBe("");
  });

  it("is a no-op without merges", () => {
    const aoa = [["A", ""], ["B", ""]];
    expect(fillMergedCells(aoa, undefined).aoa).toEqual(aoa);
    expect(fillMergedCells(aoa, []).aoa).toEqual(aoa);
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

  it("parses the simplified-Chinese form (收货确认及付款通知书)", () => {
    const aoa = [
      ["收货确认及付款通知书"],
      ["收货办事处:", "创意深圳办", "", "", "", "编号         :", "NDK20260819-1"],
      ["供应商        :", "日电波水晶（上海）贸易有限公司", "", "", "", "收货日期 :", 46253],
      ["发票号码    :"],
      ["订单号", "箱数", "型号", "摘要(D/C)", "数量（PCS）", "办事处", "备注"],
      ["319083261N2", 1, "NDK+P1", 2632, 3000, "深圳办"],
      ["319A05822N2", 1, "NDK+P2", 2631, 6000, "深圳办"],
      ["合计：", 2, "", "", 9000],
    ];
    const r = parseCnReceivingAoa(aoa);
    expect(r.receivedOffice).toBe("创意深圳办");
    expect(r.supplier).toBe("日电波水晶（上海）贸易有限公司");
    expect(r.invoiceNo).toBe("NDK20260819-1");
    expect(r.receivedDate).toBe("2026-08-19");
    expect(r.items).toHaveLength(2);
    expect(r.items[0].partNo).toBe("NDK+P1");
    expect(r.items[0].qty).toBe("3000");
    expect(r.sheetTotals).toEqual({ carton: 2, qty: 9000 });
    expect(r.totals).toEqual({ carton: 2, qty: 9000 });
  });

  it("skips a duplicated label cell and takes the real 編號 value", () => {
    const aoa = [
      ["", "", "", "", "", "編號:", "編        號:", "FIGARO20260429-1"],
      ["訂單號", "箱数", "型號", "摘要", "數量", "", "辦事處", "備註"],
      ["319082979F1", 1, "FIGARO+A", 2618, 20, "", "深圳办"],
    ];
    const r = parseCnReceivingAoa(aoa);
    expect(r.invoiceNo).toBe("FIGARO20260429-1");
    // Bare 摘要 / 數量 headers map to dateCode / qty.
    expect(r.items[0].dateCode).toBe("2618");
    expect(r.items[0].qty).toBe("20");
  });

  it("counts a merge-filled carton cell once toward the carton total", () => {
    const aoa = [
      ["訂單號", "箱数", "型號", "摘要(D/C)", "數量(PCS)", "辦事處", "備註"],
      ["329064905YH2", 1, "P-1", 2638, 30, "广州办"],
      ["", "", "", "", "", ""],
      ["319A05913H2", "", "P-2", 2638, 70, "深圳办"],
      ["合计：", 1, "", "", 100],
    ];
    // 箱数 merged over rows 1-3 (Excel-style 0-based AOA coords here).
    const merged = fillMergedCells(aoa, [{ s: { r: 1, c: 1 }, e: { r: 3, c: 1 } }]);
    const r = parseCnReceivingAoa(merged.aoa, merged.filled);
    expect(r.items).toHaveLength(2);
    // Every covered row shows the carton count…
    expect(r.items[0].cartonNo).toBe("1");
    expect(r.items[1].cartonNo).toBe("1");
    expect(r.items[1].cartonMerged).toBe(true);
    expect(r.items[0].cartonMerged).toBeUndefined();
    // …but the total counts it once, matching the printed 合计.
    expect(r.totals).toEqual({ carton: 1, qty: 100 });
  });
});
