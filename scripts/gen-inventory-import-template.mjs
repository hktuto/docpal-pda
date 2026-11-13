// Generates supporting_doc/inventory-import-template.xlsx — the template for
// the admin per-shelf inventory Excel import (spec
// docs/superpowers/specs/2026-11-13-uat-inventory-tools-design.md).
// Sheet 1: wcl_item_no | date_code | qty header (bold, frozen top row) plus
// a few example rows. Sheet 2: short import instructions.
// Run from the repo root: node scripts/gen-inventory-import-template.mjs

import ExcelJS from "exceljs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "supporting_doc", "inventory-import-template.xlsx");

const wb = new ExcelJS.Workbook();

const sheet = wb.addWorksheet("Inventory Import", {
  views: [{ state: "frozen", ySplit: 1 }],
});
sheet.columns = [
  { header: "wcl_item_no", key: "wcl_item_no", width: 20 },
  { header: "date_code", key: "date_code", width: 14 },
  { header: "drawing_no", key: "drawing_no", width: 16 },
  { header: "qty", key: "qty", width: 10 },
];
sheet.getRow(1).font = { bold: true };
sheet.addRows([
  { wcl_item_no: "WCL-000123", date_code: "2632", drawing_no: "DWG-4521-A", qty: 50 },
  { wcl_item_no: "WCL-000456", date_code: "2633", drawing_no: "", qty: 120 },
  { wcl_item_no: "WCL-000789", date_code: "", drawing_no: "", qty: 25 },
]);

const help = wb.addWorksheet("說明 Instructions");
help.columns = [{ width: 110 }];
help.addRows([
  ["Per-shelf inventory import — instructions"],
  [""],
  ["1. One row per part: wcl_item_no (required, must exist in the parts master), date_code (may be blank), drawing_no (optional, may be blank), qty (positive integer)."],
  ["2. The first row must be the header: wcl_item_no | date_code | drawing_no | qty (column names are matched case-insensitively; the drawing_no column may be omitted entirely). Extra columns are ignored."],
  ["3. The import applies to ONE shelf and the Org / sub-inventory you pick in the dialog — rows are credited there as on-hand stock."],
  ["4. Importing the same part + date_code + drawing_no + shelf + Org / sub-inventory again merges into the existing lot (qty is added). Same part + date_code but a DIFFERENT drawing_no creates a separate lot."],
  ["5. Rows with an unknown wcl_item_no are skipped and reported; the valid rows still import."],
]);

mkdirSync(dirname(outPath), { recursive: true });
await wb.xlsx.writeFile(outPath);
console.log(`wrote ${outPath}`);
