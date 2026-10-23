/**
 * Client-side decoder for the customer receiving Excel (收貨確認及付款通知書 /
 * 收货确认及付款通知书, CN receiving upload — spec
 * 2026-10-16-customer-receiving-upload-design.md).
 *
 * Pure AOA in (the output of `XLSX.utils.sheet_to_json(ws, {header: 1, defval: ""})`
 * — the page does the XLSX.read), so this util never imports the xlsx lib.
 * Sheet layout: title row, label/value header rows (收貨辦事處 / 供應商 /
 * 發票號碼 / 編號 / 收貨日期, or their simplified-Chinese spellings), an item
 * table (訂單號 | 箱数 | 型號 | 摘要(D/C) | 數量(PCS) | 重量（KG) | 辦事處 | 发货项 |
 * 備註 — column subsets and simplified spellings tolerated) terminated by a
 * 合计 row, then footer/notice rows.
 */

export interface CnReceivingItem {
  /** 1-based position in the sheet's item table (assigned at parse time in
   *  row order; passes through to the workflow payload). */
  index: number;
  orderNo: string;
  cartonNo: string;
  /** True when the carton cell was filled in from a merged range (the group's
   *  carton count shows on every row it covers, but counts once toward the
   *  sheet carton total). Client-side marker — stripped before submit. */
  cartonMerged?: boolean;
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
  收货办事处: "receivedOffice",
  供應商: "supplier",
  供应商: "supplier",
  發票號碼: "receiptNo",
  发票号码: "receiptNo",
  編號: "invoiceNo",
  编号: "invoiceNo",
  收貨日期: "receivedDate",
  收货日期: "receivedDate",
};

const ITEM_COLUMNS: Record<string, keyof CnReceivingItem> = {
  訂單號: "orderNo",
  订单号: "orderNo",
  箱数: "cartonNo",
  箱數: "cartonNo",
  型號: "partNo",
  型号: "partNo",
  摘要: "dateCode",
  "摘要(D/C)": "dateCode",
  數量: "qty",
  数量: "qty",
  "數量(PCS)": "qty",
  "数量(PCS)": "qty",
  "重量(KG)": "weight",
  辦事處: "office",
  办事处: "office",
  发货项: "poNo",
  發貨項: "poNo",
  備註: "remark",
  备注: "remark",
};

/** Item-table column header that opens the item table (traditional or
 *  simplified spelling). */
const ORDER_NO_HEADERS = new Set(["訂單號", "订单号"]);

function isBlankRow(row: unknown[]): boolean {
  return row.every((c) => text(c) === "");
}

/** One merged-cell range, in `XLSX.utils.sheet_to_json` AOA coordinates
 *  (identical to a worksheet's `!merges` entry). */
export interface AoaMergeRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

/**
 * Fill merged cells down/across their range (a copy — the input AOA is not
 * mutated). Excel only carries the value in a merge's top-left cell; the
 * customer receiving sheet merges the poNo (发货项) and carton (箱数) columns
 * across an item group, so every row in the range shares the value. Only
 * empty cells are filled — real values are never overwritten, and files
 * without merges are untouched.
 *
 * Also returns `filled`: the set of `"row:col"` coordinates that received a
 * filled-in value, so the parser can tell an original cell apart from a
 * merge fill (a merged carton count shows on every covered row but counts
 * once toward the sheet carton total).
 */
export function fillMergedCells(
  aoa: unknown[][],
  merges: AoaMergeRange[] | undefined | null
): { aoa: unknown[][]; filled: Set<string> } {
  const filled = new Set<string>();
  const filledAoa = aoa.map((row) => [...row]);
  for (const m of merges ?? []) {
    if (!m || m.e.r < m.s.r || m.e.c < m.s.c) continue;
    const value = filledAoa[m.s.r]?.[m.s.c];
    if (text(value) === "") continue;
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (text(filledAoa[r]?.[c]) === "") {
          if (!filledAoa[r]) filledAoa[r] = [];
          filledAoa[r][c] = value;
          if (r !== m.s.r || c !== m.s.c) filled.add(`${r}:${c}`);
        }
      }
    }
  }
  return { aoa: filledAoa, filled };
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
export function parseCnReceivingAoa(aoa: unknown[][], filledCells?: Set<string>): CnReceivingParseResult {
  const rows = (aoa ?? []).filter((r) => Array.isArray(r));

  // ---- item table header row (col 0 normalizes to 訂單號 / 订单号) ----
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (ORDER_NO_HEADERS.has(normHeader(rows[i][0]))) {
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
        // Some sheets duplicate the label as a cell ("編號:" then "編 號:")
        // before the real value — a candidate that is itself a label is
        // skipped, not taken as the value.
        if (LABEL_FIELDS[normLabel(value)]) continue;
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
    const cartonIdx = colMap.indexOf("cartonNo");
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const c0 = normLabel(row[0]);
      if (c0.startsWith("合计") || c0.startsWith("合計")) {
        const qtyIdx = colMap.indexOf("qty");
        sheetTotals = {
          carton: cartonIdx >= 0 ? toNumber(row[cartonIdx]) : null,
          qty: qtyIdx >= 0 ? toNumber(row[qtyIdx]) : null,
        };
        break;
      }
      if (c0.startsWith("收貨注意事項") || c0.startsWith("收货注意事项")) break;
      if (isBlankRow(row)) continue;
      const item: CnReceivingItem = { index: items.length + 1, orderNo: "", cartonNo: "", partNo: "", dateCode: "", qty: "", weight: "", office: "", poNo: "", remark: "" };
      let any = false;
      for (let c = 0; c < row.length; c++) {
        const field = colMap[c];
        if (!field || field === "index" || field === "cartonMerged") continue;
        const value = text(row[c]);
        if (value !== "") any = true;
        // String() on purpose: qty/cartonNo/dateCode are stringified on the
        // wire and poNo can exceed 2^53 as a number.
        item[field] = String(row[c] ?? "").trim();
      }
      if (cartonIdx >= 0 && filledCells?.has(`${r}:${cartonIdx}`)) item.cartonMerged = true;
      // A row counts as an item only when one of its key fields is present —
      // a separator row that happens to sit inside a merged poNo range (its
      // empty cells filled by fillMergedCells) must not become an item.
      const hasKeyField = text(item.orderNo) !== "" || text(item.partNo) !== "" || text(item.qty) !== "";
      if (any && hasKeyField) items.push(item);
    }
  }

  const totals = {
    carton: items.reduce((s, i) => s + (i.cartonMerged ? 0 : (toNumber(i.cartonNo) ?? 0)), 0),
    qty: items.reduce((s, i) => s + (toNumber(i.qty) ?? 0), 0),
  };

  return { ...header, receivedDate: header.receivedDate, items, totals, sheetTotals };
}
