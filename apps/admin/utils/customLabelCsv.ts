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
  /** parts.moq, else MOQ= in description; null when both miss. */
  moq: number | null;
  /** picking_orders.delivery_date as YYYY-MM-DD; null when the order row misses. */
  deliveryDate: string | null;
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

/** DocPal cust_part_no per (orderNo, wclItemNo) — the rohs-7 box label's
 *  item partNumber. Backend proxy POST /admin/cust-part-refs (DocPal oracle
 *  order-item-refs); fail-soft, missing = null → printed empty. */
export interface CustPartRefResult {
  orderNo: string;
  wclItemNo: string;
  custPartNo: string | null;
}

async function lookupCustPartNos(csvData: Record<string, string>[]): Promise<CustPartRefResult[]> {
  const pairs = new Set(csvData.map((r) => `${r["單號"] ?? ""}|${r["物料號"] ?? ""}`));
  if (pairs.size === 0) return [];
  const api = useApi();
  const lines = [...pairs].map((key) => {
    const [orderNo, wclItemNo] = key.split("|");
    return { orderNo, wclItemNo };
  });
  const { results } = await api.post<{ results: CustPartRefResult[] }>("/admin/cust-part-refs", { lines });
  return results;
}

export async function convertToPrintData(csvData: Record<string, string>[]) {
  const api = useApi();
  // get order CUST_ITEM_NUMBER form mapping
  const custItems = await lookupCustItemNumbers(csvData);
  const custPartRefs = await lookupCustPartNos(csvData);
  const VENDER_CODE = 71279;

  // Resolve the order/part info for a CSV row; null = skipped row (no MOQ or
  // MOQ exceeds the row qty — these rows produce no labels at all).
  const resolveCustItem = (row: Record<string, string>) => {
    const custItem = custItems.find(cu => cu.wclItemNo === row.物料號 && cu.orderNo === row.單號);
    if (!custItem || !custItem.moq || custItem.moq > Number(row.數量)) return null;
    return custItem;
  };

  // 1 label 1 number: pre-count the labels this CSV will produce so one
  // /admin/sequences/next call can reserve the exact contiguous block from the
  // weekly counter (custom_label_weekly_serial, resets every Monday) — each
  // small label copy takes the next serial. (Box labels are template rohs-7
  // and carry no weekly serial.)
  let smallLabelCount = 0;
  for (const row of csvData) {
    const custItem = resolveCustItem(row);
    if (!custItem) continue;
    smallLabelCount += Math.floor(Number(row.數量) / custItem.moq);
  }
  const serialTotal = smallLabelCount;
  let nextSerialNo = serialTotal > 0
    ? (await api.post<{ key: string; start: number; count: number }>("/admin/sequences/next", {
        key: "custom_label_weekly_serial",
        count: serialTotal,
      })).start
    : 1;
  const nextWeekly = () => String(nextSerialNo++).padStart(6, "0");

  // first step loop all rows; rows are remembered for the rohs-7 box build
  let currentBoxCount = 0;
  const boxRows: { boxId: number; orderNo: string; wclItemNo: string; lotNo: string; qty: number }[] = [];

  const result = csvData.reduce((f, c) => {
    // check if item new box
    const custItem = resolveCustItem(c);
    // skip rows without a usable MOQ (no labels produced)
    if (!custItem) {
      console.log('no moq item', custItem)
      return f
    }
    // create delivery date , orginal value : 2026-01-01, need to remove all - and / then remove first 2 letter
     const deliverDay = custItem.deliveryDate.replaceAll('-','').replaceAll('/','').slice(2)
    // update currentBoxCount
    if (Number(c.物品序列) === 1) {
      currentBoxCount++
    }
    const smallLabel = {
      barcode1: custItem.custItemNumber,
      dateCode: c.DATECODE,
      dateCode2: c.DATECODE,
      deliverDay: deliverDay,
      description: custItem.partNo,
      description2: custItem.itemDescription,
      invNo: c.單號,
      lotNo: c.LOTNO,
      lotNo2: c.LOTNO,
      partNo: custItem.partNo,
      qrcode: "", // overridden per copy — every small label gets its own weekly serial
      qrcode2: `${custItem.orderNo};${custItem.partNo};${custItem.moq};${c.LOTNO};${c.DATECODE}`,
      qty: custItem.moq,
      qty2: custItem.moq,
      reelno: "", // overridden per copy
      vendorCode: VENDER_CODE,
      boxId:currentBoxCount
    }
    const timeToPrint = new Array(Math.floor(Number(c.數量) / custItem.moq)).fill(null)
    // every small label copy gets its own weekly serial
    f.smalllabel.push(...timeToPrint.map(() => {
      const copyWeekly = nextWeekly()
      return {
        ...smallLabel,
        weekly_count: copyWeekly,
        qrcode: `${custItem.custItemNumber}*${c.LOTNO}*${c.DATECODE}*${VENDER_CODE}*${custItem.moq}*${VENDER_CODE}${deliverDay}${copyWeekly}`,
        reelno: VENDER_CODE+deliverDay+copyWeekly,
      }
    }))
    // insert to small label
    // remember the row for the rohs-7 box-label build (grouped after the loop)
    boxRows.push({
      boxId: currentBoxCount,
      orderNo: c["單號"],
      wclItemNo: c["物料號"],
      lotNo: c.LOTNO,
      qty: Number(c["數量"]),
    })
    // update
    return f
  }, {
    smalllabel: [],
  })

  // Box labels — template rohs-7, one label (one A4 page) per box
  // (物品序列 = 1 starts a box). items[] = one entry per part+lot group in
  // the box, in first-appearance order; merged rows accumulate qty.
  const partNoFor = (orderNo: string, wclItemNo: string): string =>
    custPartRefs.find(r => r.orderNo === orderNo && r.wclItemNo === wclItemNo)?.custPartNo ?? "";
  const boxes = new Map<number, typeof boxRows>();
  for (const r of boxRows) {
    if (!boxes.has(r.boxId)) boxes.set(r.boxId, []);
    boxes.get(r.boxId)!.push(r);
  }
  const totalBoxes = boxes.size;
  const boxLabels: Record<string, unknown>[] = [];
  let page = 0;
  for (const rowsInBox of boxes.values()) {
    page++;
    const first = rowsInBox[0];
    // group by (wclItemNo, lotNo), first-appearance order
    const groups: { orderNo: string; wclItemNo: string; lotNo: string; qty: number }[] = [];
    for (const r of rowsInBox) {
      const g = groups.find(x => x.wclItemNo === r.wclItemNo && x.lotNo === r.lotNo);
      if (g) g.qty += r.qty;
      else groups.push({ orderNo: r.orderNo, wclItemNo: r.wclItemNo, lotNo: r.lotNo, qty: r.qty });
    }
    boxLabels.push({
      items: groups.map((g, i) => ({
        item: String(i + 1),
        partNumber: partNoFor(g.orderNo, g.wclItemNo),
        desc: g.wclItemNo,
        qty: g.qty.toLocaleString("en-US"),
        poNumber: g.orderNo,
        drawingNo: "", // externally managed in our case — always empty
      })),
      cusNo: "PRIME",
      page: String(page),
      total: String(totalBoxes),
      qrcode: "", // TODO: box-label QR content not finalised yet
      cusNo2: `PRIME-${first.orderNo}`,
    });
  }
  return { smalllabel: result.smalllabel, boxLabels };
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
