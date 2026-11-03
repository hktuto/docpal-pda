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
import { listScanTemplates } from "../db/scantemplates.js";
import { decodeWithTemplates, type DecodedScan, type ScanDecodeInput } from "./template.js";

export async function decodeScan(db: AppDb, input: ScanDecodeInput): Promise<DecodedScan> {
  const [templates, periods] = await Promise.all([
    listScanTemplates(db),
    listDateCodePeriods(db),
  ]);
  return decodeWithTemplates(input, templates, periods, dateCodeFormat());
}
