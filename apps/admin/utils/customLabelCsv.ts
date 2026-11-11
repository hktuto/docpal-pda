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
  converted: Record<string, string>[];
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

export const convertedHeader:string[] = [

]

export function parseCustomLabelCsv(text: string): CustomLabelCsvResult {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM would poison the first header name
  const records = splitRecords(text).filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (records.length === 0) {
    return { header: [], converted:[], rows: [], errors: [{ line: 0, kind: "empty" }] };
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
  // convert phased object to destination object
  const converted = []
  console.log("rows", rows)
  return { header, converted, rows, errors };
}
