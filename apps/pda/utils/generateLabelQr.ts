/**
 * Generate raw QR label values for each supplier brand's qr_template format.
 * Used by the DevScanSimulator's "Generate QR" tab to produce scannable test data.
 */

export interface LabelQrInput {
  brand: string;
  partNo: string;
  wclItemNo?: string;
  qty?: number;
  dateCode?: string;
  lotCode?: string;
  coo?: string;
  cow?: string;
}

export interface BrandQrFormat {
  brand: string;
  generate: (input: LabelQrInput) => string;
}

// KOA: :{itemId}::{qty}:K:{lotCode}:{serialNo}:{wclItemNo}
function generateKoa(input: LabelQrInput): string {
  const qty = input.qty != null ? String(input.qty * 33 / 100 + 87) : "153";
  const serial = String(Date.now()).slice(-7);
  const wclItemNo = input.wclItemNo || `${input.brand}/${input.partNo}`;
  return `:${input.partNo}::${qty}:K:${input.lotCode || "-"}:${serial}:${wclItemNo}`;
}

// SII: 1${mpn}${qty}${lotCode}${mpn}${dateCode}${serial}
function generateSii(input: LabelQrInput): string {
  const qty = input.qty != null ? String(input.qty) : "3000";
  const serial = String(Date.now()).slice(-10);
  const dateCode = input.dateCode || "";
  return `1$${input.partNo}$${qty}$${input.lotCode || ""}$${input.partNo}$${dateCode}$${serial}`;
}

// iC-Haus: JSON "Versandetikett"
function generateIcHaus(input: LabelQrInput): string {
  const obj = {
    type: "Versandetikett",
    version: "1",
    AC: input.lotCode || "",
    VI: "<keine>",
    DC: input.dateCode || "",
    Q: input.qty != null ? String(input.qty) : "10",
    ID: String(Date.now()).slice(-5),
    VID: "1",
    C: "WELTM",
    CANR: input.wclItemNo || `ICHAUS/${input.partNo}`,
    IANR: input.partNo,
    CONR: "",
    COO: input.coo || "",
    LTS: `${new Date().toISOString().slice(0, 10)}-1`,
  };
  return JSON.stringify(obj);
}

// NCC: fixed-width 28-char (itemId(6) flag(3) lot(7) pack(3) qty(5) serial(4))
function generateNcc(input: LabelQrInput): string {
  const itemId = input.partNo.replace(/\D/g, "").padEnd(6, "0").slice(0, 6);
  const flag = "000";
  const lot = (input.lotCode || "").replace(/\D/g, "").padEnd(7, "0").slice(0, 7);
  const pack = "000";
  const qty = input.qty != null ? String(input.qty).padStart(5, "0") : "02000";
  const serial = String(Date.now()).slice(-4);
  return `${itemId}${flag}${lot}${pack}${qty}${serial}`;
}

// COPAL: fixed-width 111-char reel label
function generateCopal(input: LabelQrInput): string {
  const prefix = "234101510021";
  const itemId = input.partNo.padEnd(30).slice(0, 30);
  const qty = input.qty != null ? String(input.qty) : "2000";
  const middle = "2071";
  const code = "C6E";
  const serial = String(Date.now()).slice(0, 20).padEnd(38, "0");
  const str = `${prefix}${itemId}${qty}  ${middle}  ${code}      ${serial}`;
  return str.padEnd(111, " ").slice(0, 111);
}

// TE Connectivity: MH10.8.2 DataMatrix (GS=\x1d, RS=\x1e, EOT=\x04)
function generateTe(input: LabelQrInput): string {
  const serial = String(Date.now()).slice(-10);
  const qty = input.qty != null ? String(input.qty) : "1584";
  const dateCode = input.dateCode || "";
  return (
    `[)>RS06${"\x1d"}LT${serial}${"\x1d"}PN${input.partNo}${"\x1d"}` +
    `RVG${"\x1d"}QT${qty}${"\x1d"}PO${"\x1d"}BT${input.lotCode || ""}${"\x1d"}` +
    `BX3${"\x1d"}DC${dateCode}RS EOT`
  );
}

// NDK: MH10.8.2 QR
function generateNdk(input: LabelQrInput): string {
  const serial = String(Date.now()).slice(-10);
  const qty = input.qty != null ? String(input.qty) : "9000";
  const custPn = `${input.partNo}`;
  return `[)>RS06${"\x1d"}P${custPn}${"\x1d"}1T${serial}${"\x1d"}Q${qty}${"\x1d"}1P${input.partNo}RS EOT`;
}

export const brandQrFormats: BrandQrFormat[] = [
  { brand: "KOA", generate: generateKoa },
  { brand: "SII", generate: generateSii },
  { brand: "ABLIC", generate: generateSii },
  { brand: "ICHAUS", generate: generateIcHaus },
  { brand: "NCC", generate: generateNcc },
  { brand: "COPAL", generate: generateCopal },
  { brand: "NIDEC", generate: generateCopal },
  { brand: "TE", generate: generateTe },
  { brand: "NDK", generate: generateNdk },
];

export function getBrandQrFormat(brand: string): BrandQrFormat | undefined {
  return brandQrFormats.find((f) => f.brand === brand);
}
