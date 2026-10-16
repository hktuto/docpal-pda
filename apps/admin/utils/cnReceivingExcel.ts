/**
 * Client-side decoder for the customer receiving Excel (收貨確認及付款通知書,
 * CN receiving upload — spec 2026-10-16-customer-receiving-upload-design.md).
 *
 * Pure AOA in (the output of `XLSX.utils.sheet_to_json(ws, {header: 1, defval: ""})`
 * — the page does the XLSX.read), so this util never imports the xlsx lib.
 * Sheet layout: title row, label/value header rows (收貨辦事處 / 供應商 /
 * 發票號碼 / 編號 / 收貨日期), an item table (訂單號 | 箱数 | 型號 | 摘要(D/C) |
 * 數量(PCS) | 重量（KG) | 辦事處 | 发货项 | 備註) terminated by a 合计 row,
 * then footer/notice rows.
 */

export interface CnReceivingItem {
  orderNo: string;
  cartonNo: string;
  partNo: string;
  dateCode: string;
  qty: string;
  weight: string;
  office: string;
  poNo: string;
  remark: string;
}

export interface CnReceivingPayload {
  receivedOffice: string;
  supplier: string;
  receiptNo: string;
  invoiceNo: string;
  /** YYYY-MM-DD (empty when the sheet carries no recognizable date). */
  receivedDate: string;
  items: CnReceivingItem[];
}

export interface CnReceivingParseResult extends CnReceivingPayload {
  /** Σ parsed numeric cartonNo / qty across the items (cross-check banner). */
  totals: { carton: number; qty: number };
  /** The 合计 row as printed on the sheet, when present (cross-check target). */
  sheetTotals: { carton: number | null; qty: number | null } | null;
}

/** Strip ALL whitespace (the 編號 label ships as `編    號:`), full-width
 *  parens → half-width, trailing colon (label cells end with `:`/`：`). */
function normLabel(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/[:：]+$/, "");
}

/** Header-text normalization for the item table column row. */
function normHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")");
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

/** Excel serial date → YYYY-MM-DD. Whole-day math from the 1900 date system
 *  epoch (serial 1 = 1900-01-01; the 1899-12-30 base absorbs the 1900 leap
 *  bug) — identical to XLSX.SSF.parse_date_code for date-only serials. */
function serialToDate(serial: number): string {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000);
  if (!Number.isFinite(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Serials plausibly in the 1954–2078 range — outside that a bare number is
 *  more likely a qty/date-code than a date. */
function toDateString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 20000 && value <= 80000 ? serialToDate(value) : "";
  }
  const s = text(value);
  const m = s.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$/);
  if (m) {
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

const LABEL_FIELDS: Record<string, keyof Pick<CnReceivingPayload, "receivedOffice" | "supplier" | "receiptNo" | "invoiceNo" | "receivedDate">> = {
  收貨辦事處: "receivedOffice",
  供應商: "supplier",
  發票號碼: "receiptNo",
  編號: "invoiceNo",
  收貨日期: "receivedDate",
};

const ITEM_COLUMNS: Record<string, keyof CnReceivingItem> = {
  訂單號: "orderNo",
  箱数: "cartonNo",
  箱數: "cartonNo",
  型號: "partNo",
  "摘要(D/C)": "dateCode",
  "數量(PCS)": "qty",
  "数量(PCS)": "qty",
  "重量(KG)": "weight",
  辦事處: "office",
  发货项: "poNo",
  發貨項: "poNo",
  備註: "remark",
  备注: "remark",
};

function isBlankRow(row: unknown[]): boolean {
  return row.every((c) => text(c) === "");
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(text(value).replace(/,/g, ""));
  return Number.isFinite(n) && text(value) !== "" ? n : null;
}

/**
 * Parse a CN receiving sheet AOA into the verify/edit payload. Tolerates the
 * fixed form's quirks: label cells padded with inner/trailing whitespace and
 * colons, Excel serial dates, blank rows between item groups, full/half-width
 * parens in the qty/weight headers, and a 合计 row that may carry a trailing
 * colon.
 */
export function parseCnReceivingAoa(aoa: unknown[][]): CnReceivingParseResult {
  const rows = (aoa ?? []).filter((r) => Array.isArray(r));

  // ---- item table header row (col 0 normalizes to 訂單號) ----
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (normHeader(rows[i][0]) === "訂單號") {
      headerIdx = i;
      break;
    }
  }

  // ---- label/value header fields (rows above the item table) ----
  const header: Pick<CnReceivingPayload, "receivedOffice" | "supplier" | "receiptNo" | "invoiceNo" | "receivedDate"> = {
    receivedOffice: "",
    supplier: "",
    receiptNo: "",
    invoiceNo: "",
    receivedDate: "",
  };
  const labelScanEnd = headerIdx >= 0 ? headerIdx : rows.length;
  for (let r = 0; r < labelScanEnd; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const field = LABEL_FIELDS[normLabel(row[c])];
      if (!field || header[field]) continue;
      for (let v = c + 1; v < row.length; v++) {
        const value = row[v];
        if (text(value) === "") continue;
        header[field] = field === "receivedDate" ? toDateString(value) : text(value);
        break;
      }
    }
  }

  // ---- item rows ----
  const items: CnReceivingItem[] = [];
  let sheetTotals: CnReceivingParseResult["sheetTotals"] = null;
  if (headerIdx >= 0) {
    const colMap: (keyof CnReceivingItem | null)[] = rows[headerIdx].map(
      (h) => ITEM_COLUMNS[normHeader(h)] ?? null
    );
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const c0 = normLabel(row[0]);
      if (c0.startsWith("合计") || c0.startsWith("合計")) {
        const cartonIdx = colMap.indexOf("cartonNo");
        const qtyIdx = colMap.indexOf("qty");
        sheetTotals = {
          carton: cartonIdx >= 0 ? toNumber(row[cartonIdx]) : null,
          qty: qtyIdx >= 0 ? toNumber(row[qtyIdx]) : null,
        };
        break;
      }
      if (c0.startsWith("收貨注意事項")) break;
      if (isBlankRow(row)) continue;
      const item = { orderNo: "", cartonNo: "", partNo: "", dateCode: "", qty: "", weight: "", office: "", poNo: "", remark: "" };
      let any = false;
      for (let c = 0; c < row.length; c++) {
        const field = colMap[c];
        if (!field) continue;
        const value = text(row[c]);
        if (value !== "") any = true;
        // String() on purpose: qty/cartonNo/dateCode are stringified on the
        // wire and poNo can exceed 2^53 as a number.
        item[field] = String(row[c] ?? "").trim();
      }
      if (any) items.push(item);
    }
  }

  const totals = {
    carton: items.reduce((s, i) => s + (toNumber(i.cartonNo) ?? 0), 0),
    qty: items.reduce((s, i) => s + (toNumber(i.qty) ?? 0), 0),
  };

  return { ...header, receivedDate: header.receivedDate, items, totals, sheetTotals };
}
