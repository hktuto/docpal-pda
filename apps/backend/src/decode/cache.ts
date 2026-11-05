// Process-local memo for the decode reference data (supplier QR templates +
// month-counter period rows). ~350 profile rows cost 65-90 ms to read per
// scan; the data is read-mostly and changed by exactly three writers:
// admin /supplier-profiles & /date-code-periods CRUD (createCrudRouter
// onWrite) and resetAndReseed (db:seed CLI, tests). New process = empty cache.
// shortcut: per-process cache assumes one backend per database (the
// one-instance-per-warehouse rule) — revisit if instances ever share a DB.

import type { AppDb } from "../db.js";
import { listDateCodePeriods } from "../db/dateCodePeriods.js";
import { listScanTemplates, type ScanTemplateRow } from "../db/scantemplates.js";
import type { DateCodePeriod } from "./codecs.js";

export interface DecodeData {
  templates: ScanTemplateRow[];
  periods: DateCodePeriod[];
}

let cached: DecodeData | null = null;

export async function getDecodeData(db: AppDb): Promise<DecodeData> {
  if (!cached) {
    const [templates, periods] = await Promise.all([listScanTemplates(db), listDateCodePeriods(db)]);
    cached = { templates, periods };
  }
  return cached;
}

export function invalidateDecodeCache(): void {
  cached = null;
}
