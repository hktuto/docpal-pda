import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pdfParse from "pdf-parse";
import * as xlsx from "xlsx";
import { parse } from "csv-parse/sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../docs/Supplier Sample Documents");
const OUT = path.resolve(__dirname, "seed-extraction-summary.json");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

function isImageFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function isSkippedFile(fileName) {
  const lower = fileName.toLowerCase();
  return (
    lower === "thumbs.db" ||
    lower === ".ds_store" ||
    lower.startsWith(".~lock.")
  );
}

function deriveSupplierCode(name) {
  const firstToken = name.split(/[-\s]/)[0] || "";
  return firstToken
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

async function readPdf(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    const data = await pdfParse(buffer);
    return { type: "pdf", text: data.text, pages: data.numpages };
  } catch (e) {
    return { type: "pdf", text: "", pages: 0, error: e.message };
  }
}

async function readXlsx(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    const workbook = xlsx.read(buffer, { type: "buffer" });
    const sheets = {};
    for (const sheetName of workbook.SheetNames) {
      sheets[sheetName] = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], {
        header: 1,
        defval: "",
      });
    }
    return { type: "xlsx", sheets };
  } catch (e) {
    return { type: "xlsx", sheets: {}, error: e.message };
  }
}

async function readCsv(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf-8");
    const rows = parse(text, { columns: false, skip_empty_lines: true });
    return { type: "csv", rows };
  } catch (e) {
    return { type: "csv", rows: [], error: e.message };
  }
}

async function extractFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pdf") {
    return readPdf(filePath);
  }
  if (ext === ".xlsx" || ext === ".xls") {
    return readXlsx(filePath);
  }
  if (ext === ".csv") {
    return readCsv(filePath);
  }
  return { type: "unknown" };
}

async function main() {
  const entries = await fs.readdir(ROOT, { withFileTypes: true });
  const suppliers = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const supplierName = entry.name;
    const supplierDir = path.join(ROOT, supplierName);
    const files = await fs.readdir(supplierDir, { recursive: true, withFileTypes: true });
    const documents = [];

    for (const file of files) {
      if (!file.isFile()) continue;
      if (isSkippedFile(file.name)) continue;
      if (isImageFile(file.name)) continue;

      const fullPath = path.join(file.parentPath, file.name);
      const relativePath = path.relative(supplierDir, fullPath);
      const extracted = await extractFile(fullPath);

      documents.push({
        fileName: file.name,
        relativePath,
        extracted,
      });
    }

    suppliers.push({
      name: supplierName,
      code: deriveSupplierCode(supplierName),
      documents,
    });
  }

  // Disambiguate duplicate supplier codes by appending a number to the
  // first four characters of the base code.
  const seen = new Set();
  for (const supplier of suppliers) {
    let code = supplier.code;
    let suffix = 1;
    while (seen.has(code)) {
      code = `${supplier.code.slice(0, 4)}${suffix}`;
      suffix += 1;
    }
    seen.add(code);
    supplier.code = code;
  }

  await fs.writeFile(OUT, JSON.stringify({ suppliers }, null, 2));
  console.log(`Found ${suppliers.length} supplier(s).`);
  console.log(`Wrote summary to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
