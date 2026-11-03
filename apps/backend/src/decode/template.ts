// ---------------------------------------------------------------------------
// Supplier QR template decode: apply every supplier_profiles.qr_template to a
// raw scan value in context-priority order and return the PDA-shaped result.
// Ported from apps/pda/utils/parseOcrScan.ts `parseQrCapture` (template loop,
// supplier/brand priority, order-targets gate); the per-template decode reuses
// codecs.ts `parseQrRaw` so scan-decode and the receiving commit path can
// never drift. Pure given templates/periods/format — DB reads live in
// service.ts.
//
// Difference vs the PDA copy by design: `parsed.itemId` is normalizePartNo'd
// (AMP(...) unwrapped) and the targets gate compares on the same key — the
// backend commit path's convention, strictly more forgiving than the PDA's
// plain uppercase-collapse.
// ---------------------------------------------------------------------------

import { normalizePartNo, parseQrRaw, type DateCodePeriod } from "./codecs.js";
import type { DateCodeFormat } from "../db/dateCode.js";
import type { ScanTemplateRow } from "../db/scantemplates.js";

export interface ScanDecodeInput {
  raw: string;
  /** Part numbers (or WCL item nos) of the order being scanned — a template
   *  match only wins when its part/wclItemNo is among them (empty/undefined =
   *  accept any match). Compared via normalizePartNo on both sides. */
  targets?: string[];
  /** Profile whose template is tried first. */
  supplierCode?: string;
  /** Brands of the order's items — brand-intersecting templates try next. */
  brands?: string[];
}

/** The PDA `OcrParseResult` shape (parsed/options/supplier) minus `raw` —
 *  `raw` is the client's own capture and never echoed back. */
export interface DecodedScan {
  matched: boolean;
  parsed: {
    itemId: string | null;
    qty?: number;
    coo?: string;
    dateCode?: string;
    lotCode?: string;
    cow?: string;
    wclItemNo?: string;
    serialNo?: string;
  };
  options: {
    itemIds: string[];
    qtys: number[];
    coos: string[];
    dateCodes: string[];
    lotCodes: string[];
    cows: string[];
  };
  supplier?: { code: string; brands?: string[] };
}

function noMatch(): DecodedScan {
  return {
    matched: false,
    parsed: { itemId: null },
    options: { itemIds: [], qtys: [], coos: [], dateCodes: [], lotCodes: [], cows: [] },
  };
}

export function decodeWithTemplates(
  input: ScanDecodeInput,
  templates: ScanTemplateRow[],
  dateCodePeriods: DateCodePeriod[],
  dateCodeFormat: DateCodeFormat
): DecodedScan {
  const brandSet = input.brands?.length ? new Set(input.brands) : null;
  const priority = (t: ScanTemplateRow): number => {
    if (input.supplierCode && t.supplierCode === input.supplierCode) return 0;
    if (brandSet && t.brands?.some((b) => brandSet.has(b))) return 1;
    return 2;
  };
  const ordered =
    input.supplierCode || brandSet
      ? [...templates].sort((a, b) => priority(a) - priority(b))
      : templates;
  const targets = (input.targets ?? []).map(normalizePartNo);

  for (const template of ordered) {
    if (!template.qrTemplate) continue;
    const fields = parseQrRaw(
      input.raw,
      template.qrTemplate,
      template.qtyEncoding,
      template.dateCodeEncoding,
      dateCodePeriods,
      dateCodeFormat,
      template.brands
    );
    if (!fields.partNo) continue;
    // Targets gate matches the repo's scan house rule (part_no OR wcl_item_no,
    // both normalizePartNo'd — see picking/shelf-exchange fixes 2026-11-03):
    // an allocation pinned via the WCL key passes when its order targets carry
    // the wclItemNo instead of the supplier part number.
    if (targets.length) {
      const wclKey = fields.wclItemNo ? normalizePartNo(fields.wclItemNo) : undefined;
      if (!targets.includes(fields.partNo) && !(wclKey && targets.includes(wclKey))) continue;
    }
    return {
      matched: true,
      parsed: {
        itemId: fields.partNo,
        qty: fields.qty,
        coo: fields.coo,
        dateCode: fields.dateCode,
        lotCode: fields.lotCode,
        cow: fields.cow,
        wclItemNo: fields.wclItemNo,
        serialNo: fields.serialNo,
      },
      options: {
        itemIds: [fields.partNo],
        qtys: fields.qty !== undefined ? [fields.qty] : [],
        coos: fields.coo ? [fields.coo] : [],
        dateCodes: fields.dateCode ? [fields.dateCode] : [],
        lotCodes: fields.lotCode ? [fields.lotCode] : [],
        cows: fields.cow ? [fields.cow] : [],
      },
      supplier: { code: template.supplierCode, brands: template.brands ?? undefined },
    };
  }
  return noMatch();
}
