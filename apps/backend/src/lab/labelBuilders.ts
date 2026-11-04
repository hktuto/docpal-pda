// ---------------------------------------------------------------------------
// Dev Lab label builders (GET /dev/lab): per-supplier functions that BUILD a
// raw label string matching that supplier's `supplier_profiles.qr_template`,
// from editable fields (part no, qty, date, lot, coo, serial). v1 covers the
// built-in seeded templates (src/db/seed-supplier-profiles.ts); templates
// created later via the admin QR editor have no builder — the lab page's
// "raw text" mode still renders any string for them.
// Correctness comes from the route feeding every built string back through
// the real decoder (decode/codecs.ts parseQrRaw) before returning — see
// lab/labelBuilders.test.ts for the same round-trip as a unit test.
// ---------------------------------------------------------------------------

import { buildKoaLabelRaw, type DateCodePeriod } from "../decode/codecs.js";
import { dateToDateCode } from "../db/dateCode.js";

export interface LabLabelInput {
  /** itemId group: supplier part no (NCC: the numeric drawing code). */
  partNo: string;
  wclItemNo?: string;
  qty?: number;
  /** YYYY-MM-DD; converted to each label's own date-code encoding. */
  date?: string;
  lotCode?: string;
  coo?: string;
  serialNo?: string;
}

export interface LabBuildContext {
  dateCodePeriods: DateCodePeriod[];
}

export type LabField = keyof LabLabelInput;

export interface LabBuilder {
  /** Inputs the lab page shows for this supplier. */
  fields: LabField[];
  build(input: LabLabelInput, ctx: LabBuildContext): string;
}

function req(input: LabLabelInput): string {
  const partNo = (input.partNo ?? "").trim();
  if (!partNo) throw new Error("part no is required");
  return partNo;
}

function qtyOf(input: LabLabelInput): number {
  const qty = input.qty ?? 1000;
  if (!Number.isInteger(qty) || qty <= 0) throw new Error("qty must be a positive integer");
  return qty;
}

/** YYYY-MM-DD → Date, defaulting to today. */
function dateOf(input: LabLabelInput): Date {
  if (!input.date) return new Date();
  const d = new Date(`${input.date}T00:00:00`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date "${input.date}"`);
  return d;
}

/** Date → "YMMDD" label form (1-digit year, NCC/COPAL rule). */
function ymmdd(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear() % 10}${mm}${dd}`;
}

const GS = "\x1d";

const KOA: LabBuilder = {
  fields: ["partNo", "wclItemNo", "qty", "date", "lotCode", "serialNo"],
  build(input, ctx) {
    // buildKoaLabelRaw takes the CANONICAL YYWW code and does the
    // canonical→label + month-counter encoding itself. The KOA label layout is
    // always counter+day-of-month derived from WWYY digits, so the encoder is
    // pinned to "wwyy" — the warehouse's dateCodeFormat applies to the DECODE
    // side only (passing the config format here breaks yyww warehouses: the
    // canonical code is double-swapped and no counter period matches).
    const raw = buildKoaLabelRaw({
      partNo: req(input),
      qty: qtyOf(input),
      lotCode: input.lotCode ?? null,
      dateCode: dateToDateCode(dateOf(input)),
      serialNo: input.serialNo?.trim() || "S001",
      fullName: input.wclItemNo?.trim() || undefined,
      dateCodePeriods: ctx.dateCodePeriods,
      dateCodeFormat: "wwyy",
    });
    if (!raw) throw new Error("KOA label: qty/date could not be encoded (date outside counter periods?)");
    return raw;
  },
};

// NCC ITF: 28-char = drawno(6) + lot(13) + qty(5) + serial(4);
// 32-char (KTD) = drawno(10) + flag(3) + lot(7) + pack(2) + qty(6) + serial(4).
// The lot's YMMDD prefix carries the date; filler digits complete the width.
const NCC: LabBuilder = {
  fields: ["partNo", "qty", "date", "serialNo"],
  build(input) {
    const drawno = req(input);
    const qty = qtyOf(input);
    const ymm = ymmdd(dateOf(input));
    const serial = /^\d{4}$/.test(input.serialNo ?? "") ? input.serialNo! : "0001";
    if (/^\d{6}$/.test(drawno)) {
      if (qty > 99999) throw new Error("NCC 28-char label: qty must be <= 99999");
      const lotExtra = String(input.lotCode?.replace(/\D/g, "") || "").padEnd(8, "0").slice(0, 8);
      return `${drawno}${ymm}${lotExtra}${String(qty).padStart(5, "0")}${serial}`;
    }
    if (/^\d{10}$/.test(drawno)) {
      if (qty > 999999) throw new Error("NCC 32-char label: qty must be <= 999999");
      const lotExtra = String(input.lotCode?.replace(/\D/g, "") || "").padEnd(2, "0").slice(0, 2);
      return `${drawno}000${ymm}${lotExtra}00${String(qty).padStart(6, "0")}${serial}`;
    }
    throw new Error("NCC itemId must be the 6- or 10-digit drawing code");
  },
};

// COPAL fixed-width reel label: 12-digit internal code + model + qty + two
// filler tokens + serial led by its 5-digit YMMDD date prefix.
// shortcut: the 12-digit leading code is a constant (the decoder ignores it);
// add it as an input field if a real part ever needs a specific value.
const COPAL: LabBuilder = {
  fields: ["partNo", "qty", "date", "serialNo"],
  build(input) {
    const date = dateOf(input);
    const serial = `${ymmdd(date)}${(input.serialNo ?? "").trim() || "LAB01"}`;
    return `000000000001  ${req(input)}  ${qtyOf(input)}  2071  C6E  ${serial}`;
  },
};

// SII/ABLIC $-reel QR: 1$MPN$qty$lot$MPN$YYYYMM$serial (itemId = the 2nd MPN).
const SII: LabBuilder = {
  fields: ["partNo", "qty", "date", "lotCode", "serialNo"],
  build(input) {
    const partNo = req(input);
    const d = dateOf(input);
    const yyyymm = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
    return `1$${partNo}$${qtyOf(input)}$${(input.lotCode ?? "").trim() || "LAB"}$${partNo}$${yyyymm}$${(input.serialNo ?? "").trim() || "LAB0001"}`;
  },
};

// TE Connectivity MH10.8.2 DataMatrix: GS-separated markers. DC is a 5-digit
// YYWWD code (canonical YYWW + ISO day-of-week digit).
const TE: LabBuilder = {
  fields: ["partNo", "qty", "date", "lotCode", "serialNo"],
  build(input) {
    const date = dateOf(input);
    const yyww = dateToDateCode(date);
    const dow = date.getDay() === 0 ? 7 : date.getDay();
    return [
      `[)>06${GS}LT${(input.serialNo ?? "").trim() || "LAB00001"}`,
      `PN${req(input)}`,
      "RVA",
      `QT${qtyOf(input)}`,
      "PO0",
      `BT${(input.lotCode ?? "").trim()}`,
      `BX1${GS}DC${yyww}${dow}`,
    ].join(GS);
  },
};

// NDK MH10.8.2 QR: [)>RS06 GS PW<custPn> GS 1T<serial> GS Q<qty> GS 1P<mpn>.
const NDK: LabBuilder = {
  fields: ["partNo", "qty", "serialNo"],
  build(input) {
    const partNo = req(input);
    return `[)>\x1e06${GS}PW${partNo}${GS}1T${(input.serialNo ?? "").trim() || "LAB0001"}${GS}Q${qtyOf(input)}${GS}1P${partNo}`;
  },
};

// iC-Haus "Versandetikett" JSON DataMatrix. DC is the canonical YYWW code
// (the 'yyww' encoding decodes it to the label format).
const ICHAUS: LabBuilder = {
  fields: ["partNo", "wclItemNo", "qty", "date", "lotCode", "coo", "serialNo"],
  build(input) {
    const partNo = req(input);
    return JSON.stringify({
      type: "Versandetikett",
      version: "1",
      AC: (input.lotCode ?? "").trim() || "0",
      CANR: (input.wclItemNo ?? "").trim() || `ICHAUS/${partNo}`,
      IANR: partNo,
      Q: String(qtyOf(input)),
      DC: dateToDateCode(dateOf(input)),
      COO: (input.coo ?? "").trim() || "DE",
      LTS: (input.serialNo ?? "").trim() || `LAB${Date.now() % 100000}`,
    });
  },
};

/** Builders keyed by supplier_profiles.supplier_code (the seeded codes of
 *  src/db/seed-supplier-profiles.ts). Suppliers absent here have no builder —
 *  the lab page falls back to raw-text rendering for them. */
export const LAB_BUILDERS: Record<string, LabBuilder> = {
  "32": KOA, // also the only template using dateCodeEncoding koa_month_counter
  "20": ICHAUS,
  "23": NCC,
  "19915": COPAL,
  "70915": SII,
  "84915": SII,
  "15915": TE,
  "69915": NDK,
};

export function buildLabLabelRaw(supplierCode: string, input: LabLabelInput, ctx: LabBuildContext): string {
  const builder = LAB_BUILDERS[supplierCode];
  if (!builder) throw new Error(`no label builder for supplier "${supplierCode}" — use raw-text mode`);
  return builder.build(input, ctx);
}
