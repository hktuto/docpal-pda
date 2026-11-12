// CSV parsing for the Custom Print Label upload — client-side only, no
// dependency: the file is a plain RFC4180-style export (UTF-8 BOM, CRLF,
// quoted fields) with a Chinese header row. Rows are keyed by header NAME,
// never by column index (the upstream export's column set varies by supplier).

export interface CustomLabelCsvError {
  /** 1-based physical line of the offending record (blank lines skipped). */
  line: number;
  /** "column_count" = cell count ≠ header count, row skipped. "empty" = file has no data rows. */
  kind: "column_count" | "empty";
  expected?: number;
  actual?: number;
}

export interface CustomLabelCsvResult {
  /** Trimmed non-empty header names, in column order (trailing blank column dropped). */
  header: string[];
  /** One object per data row, keys = header names. */
  rows: Record<string, string>[];
  errors: CustomLabelCsvError[];
}

/** Split text into records of cells. State machine, so quoted commas, escaped
 *  quotes ("" → ") and newlines inside quotes all stay in one field. */
function splitRecords(text: string): { cells: string[]; line: number }[] {
  const records: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let recLine = 1;

  const endField = () => {
    cells.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push({ cells, line: recLine });
    cells = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recLine = line;
    } else {
      field += ch;
    }
  }
  if (cells.length > 0 || field !== "") endRecord();
  return records;
}

export interface CustItemLookupResult {
  orderNo: string;
  /** Echo of the CSV 物料號. */
  wclItemNo: string;
  /** mtl_cross_references.cross_reference_id; null when the lookup chain misses. */
  custItemNumber: string | null;
  /** parts.part_no for wcl_item_no = 物料號; null when no part row. */
  partNo: string | null;
  /** parts.description for wcl_item_no = 物料號; null when no part row. */
  itemDescription: string | null;
  /** MOQ number parsed from the description's `MOQ=xxx` text; null when absent. */
  moq: number | null;
}

/** Batch CUST_ITEM_NUMBER + part-description lookup (POST
 *  /admin/cust-item-lookup): 單號 → picking_orders.customer_code →
 *  customer_accounts.account_number → mtl_cross_references.cross_reference_id;
 *  物料號 → parts.description. Results echo the input lines in order. */
export async function lookupCustItemNumbers(csvData: Record<string, string>[]): Promise<CustItemLookupResult[]> {
  if (csvData.length === 0) return [];
  const api = useApi();
  const lines = csvData.map((row) => ({
    orderNo: row["單號"] ?? "",
    wclItemNo: row["物料號"] ?? "",
  }));
  const { results } = await api.post<{ results: CustItemLookupResult[] }>("/admin/cust-item-lookup", { lines });
  return results;
}

/** Reserve `count` serials from a keyed backend sequence (POST
 *  /admin/sequences/next — plan docs/superpowers/plans/2026-11-12-seq-counters.md).
 *  Returns the first serial of the contiguous block; labels use
 *  start … start+count−1. The caller formats (6-digit zero-pad for REEL NO);
 *  the counter resets itself per its schedule (custom_label_weekly_serial =
 *  every Monday). */
export async function nextSeqValues(key: string, count: number): Promise<number> {
  const api = useApi();
  const { start } = await api.post<{ key: string; start: number; count: number }>(
    "/admin/sequences/next",
    { key, count }
  );
  return start;
}

export async function convertToPrintData(csvData: Record<string, string>[]) {
  // get order CUST_ITEM_NUMBER form mapping
  const api = useApi();
  const custItems = await lookupCustItemNumbers(csvData);
  const {count} = await api.post('/admin/sequences/next', {
    "key": "custom_label_weekly_serial",
  })
  const VENDER_CODE = 71279
  // first step loop all row and group largeLabel
  let currentBoxCount = 0;
  const deliverDay = 'yyyymmdd'
  const result = csvData.reduce((f, c) => {
    // check if item new box
    const custItem = custItems.find(cu => cu.wclItemNo === c.物料號 && cu.orderNo === c.單號)
    // update currentBoxCount
    if (Number(c.物品序列) === 1) {
      currentBoxCount++
    }
    //
    //
    // {
    //   "barcode1": "",
    //   "dateCode": "",
    //   "dateCode2": "",
    //   "deliverDay": "",
    //   "description": "",
    //   "description2": "",
    //   "invNo": "",
    //   "lotNo": "",
    //   "lotNo2": "",
    //   "partNo": "",
    //   "qrcode": "",
    //   "qrcode2": "",
    //   "qty": "",
    //   "qty2": "",
    //   "reelno": "",
    //   "supplier": "",
    //   "vendorCode": ""
    // }
    f.smalllabel.push({
      "barcode1": custItem.custItemNumber,
      "dateCode": c.DATECODE,
      "dateCode2": c.DATECODE,
      "deliverDay": deliverDay,
      "description": custItem.partNo,
      "description2": custItem.itemDescription,
      "invNo": c.單號,
      "lotNo": c.LOTNO,
      "lotNo2": c.LOTNO,
      "partNo": custItem.partNo,
      "qrcode": VENDER_CODE+deliverDay+count,
      "qrcode2": "",
      "qty": "",
      "qty2": "",
      "reelno": "",
      "supplier": "",
      "vendorCode": VENDER_CODE
    })
    // insert to small label

    // update
    return f
  }, {
    smalllabel: [],
    largeLabel: []
  })
  console.log("custItems", result)
}
export function parseCustomLabelCsv(text: string): CustomLabelCsvResult {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM would poison the first header name
  const records = splitRecords(text).filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (records.length === 0) {
    return { header: [], rows: [], errors: [{ line: 0, kind: "empty" }] };
  }

  // Header → column index. Empty names (trailing comma) and duplicate names
  // (first wins) are dropped from the mapping.
  const headerCells = records[0].cells;
  const header: string[] = [];
  const indexByName = new Map<string, number>();
  headerCells.forEach((raw, i) => {
    const name = raw.trim();
    if (!name || indexByName.has(name)) return;
    indexByName.set(name, i);
    header.push(name);
  });

  const rows: Record<string, string>[] = [];
  const errors: CustomLabelCsvError[] = [];
  for (const rec of records.slice(1)) {
    if (rec.cells.length < headerCells.length) {
      errors.push({
        line: rec.line,
        kind: "column_count",
        expected: headerCells.length,
        actual: rec.cells.length,
      });
      continue;
    }
    const row: Record<string, string> = {};
    for (const name of header) row[name] = rec.cells[indexByName.get(name)!].trim();
    rows.push(row);
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push({ line: 0, kind: "empty" });
  }

  return { header, rows, errors };
}
