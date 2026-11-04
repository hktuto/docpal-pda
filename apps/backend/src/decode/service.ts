// ---------------------------------------------------------------------------
// Server-side label decode (spec 2026-11-03-backend-scan-decode-design.md):
// the DB side of scanning a supplier label — loads the supplier QR templates
// (supplier_profiles) and month-counter periods (date_code_counter_periods),
// reads the warehouse's dateCodeFormat from the flow config, and hands the
// pure template loop (template.ts) everything it needs. This is the decode
// path that requires DB lookups; the OCR-text heuristics (PDA
// parseAndIdentify) stay client-side.
//
// After the template match, the result goes through the brand resolver for
// the decoded profile's brands (brands/index.ts dispatch table — NCC drawing
// code, TE truncated MPN; that is where new brand logic belongs). The same
// resolver runs a second way when the targets gate rejected the scan: re-run
// ungated and let the brand vouch for the translated identity on this order.
//
// [DECODE-TIME] logs the per-stage cost (load/loop/identity lookup) — human-
// paced scans keep the console quiet; compare against the PDA's
// [DECODE-TIME] round-trip line to attribute latency between SQL and network.
// ---------------------------------------------------------------------------

import { dateCodeFormat } from "../config.js";
import type { AppDb } from "../db.js";
import { getDecodeData } from "./cache.js";
import { resolverFor } from "./brands/index.js";
import { decodeWithTemplates, type DecodedScan, type ScanDecodeInput } from "./template.js";

export async function decodeScan(db: AppDb, input: ScanDecodeInput): Promise<DecodedScan> {
  const stages: string[] = [];
  let prev = performance.now();
  const tick = (stage: string) => {
    const now = performance.now();
    stages.push(`${stage} ${(now - prev).toFixed(1)}ms`);
    prev = now;
  };

  // ~0ms once the process cache is warm (decode/cache.ts).
  const { templates, periods } = await getDecodeData(db);
  tick("load");

  let result = decodeWithTemplates(input, templates, periods, dateCodeFormat());
  tick("loop");

  const log = () =>
    console.log(
      `[DECODE-TIME] ${stages.join(" + ")} | ${templates.length} templates -> matched=${result.matched}` +
        (result.supplier ? ` (${result.supplier.code})` : "")
    );

  // Matched scan has the identity translated in place; on the ungated rerun
  // the resolver's answer decides whether the rerun is adopted at all.
  const applyBrand = async (scan: DecodedScan, gated: boolean): Promise<boolean> => {
    const resolver = resolverFor(scan.supplier?.brands);
    if (!scan.parsed.itemId || !resolver) return !gated;
    const accepted = await resolver.resolve(db, scan.parsed, input.targets, gated);
    tick(resolver.name + (gated ? "-rerun" : ""));
    return accepted;
  };

  if (result.matched) {
    await applyBrand(result, false);
    log();
    return result;
  }

  // Targets-gate rejection: the drawing/truncated code is never among the
  // order targets, so re-run ungated and accept the identity translation
  // only when the brand resolver vouches for it on this order.
  if (input.targets?.length) {
    const ungated = decodeWithTemplates({ ...input, targets: undefined }, templates, periods, dateCodeFormat());
    if (ungated.matched && (await applyBrand(ungated, true))) result = ungated;
  }

  log();
  return result;
}
