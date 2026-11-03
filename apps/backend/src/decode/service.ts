// ---------------------------------------------------------------------------
// Server-side label decode (spec 2026-11-03-backend-scan-decode-design.md):
// the DB side of scanning a supplier label — loads the supplier QR templates
// (supplier_profiles) and month-counter periods (date_code_counter_periods),
// reads the warehouse's dateCodeFormat from the flow config, and hands the
// pure template loop (template.ts) everything it needs. This is the decode
// path that requires DB lookups; the OCR-text heuristics (PDA
// parseAndIdentify) stay client-side.
// ---------------------------------------------------------------------------

import { dateCodeFormat } from "../config.js";
import type { AppDb } from "../db.js";
import { listDateCodePeriods } from "../db/dateCodePeriods.js";
import { lookupPartsByDrawingNo } from "../db/partDrawno.js";
import { listScanTemplates } from "../db/scantemplates.js";
import { normalizePartNo } from "./codecs.js";
import { decodeWithTemplates, type DecodedScan, type ScanDecodeInput } from "./template.js";

export async function decodeScan(db: AppDb, input: ScanDecodeInput): Promise<DecodedScan> {
  const [templates, periods] = await Promise.all([
    listScanTemplates(db),
    listDateCodePeriods(db),
  ]);
  const result = decodeWithTemplates(input, templates, periods, dateCodeFormat());

  // NCC labels carry the numeric drawing code as itemId — resolve it to the
  // WCL item no via wcl_part_drawno (spec 2026-11-03-ncc-drawno-part-lookup).
  // The single-brand profile derivation (`NCC/<itemId>`) yields a bogus
  // wclItemNo for NCC, so a unique resolution overrides it.
  if (result.matched && result.parsed.itemId && result.supplier?.brands?.includes("NCC")) {
    const drawnoMatches = await lookupPartsByDrawingNo(db, result.parsed.itemId);
    const wclItemNos = [...new Set(drawnoMatches.map((m) => m.wclItemNo))];
    if (wclItemNos.length === 1) {
      // itemId stays the drawing code; only the wclItemNo is attached.
      result.parsed.wclItemNo = wclItemNos[0];
    }
    return result;
  }

  // Targets-gate rejection: the drawing code is never among the order
  // targets, so re-run ungated and accept the match only when exactly one
  // drawno resolution lands inside the (normalized) targets.
  if (!result.matched && input.targets?.length) {
    const ungated = decodeWithTemplates({ ...input, targets: undefined }, templates, periods, dateCodeFormat());
    if (ungated.matched && ungated.parsed.itemId && ungated.supplier?.brands?.includes("NCC")) {
      const drawnoMatches = await lookupPartsByDrawingNo(db, ungated.parsed.itemId);
      const targetNorms = new Set(input.targets.map(normalizePartNo));
      const onOrder = [...new Set(drawnoMatches.map((m) => m.wclItemNo))].filter((w) =>
        targetNorms.has(normalizePartNo(w))
      );
      if (onOrder.length === 1) {
        ungated.parsed.wclItemNo = onOrder[0];
        return ungated;
      }
    }
  }

  return result;
}
