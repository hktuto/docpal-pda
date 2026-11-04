// ---------------------------------------------------------------------------
// Server-side label decode (spec 2026-11-03-backend-scan-decode-design.md):
// the DB side of scanning a supplier label — loads the supplier QR templates
// (supplier_profiles) and month-counter periods (date_code_counter_periods),
// reads the warehouse's dateCodeFormat from the flow config, and hands the
// pure template loop (template.ts) everything it needs. This is the decode
// path that requires DB lookups; the OCR-text heuristics (PDA
// parseAndIdentify) stay client-side.
//
// Two suppliers need identity translation after the template match, both
// guarded on the decoded profile's brands so no other scan pays a query:
// - NCC: itemId is the numeric DRAWING CODE — wcl_part_drawno resolves the
//   wcl_item_no (spec 2026-11-03-ncc-drawno-part-lookup-design.md).
// - TE: the label prints a TRUNCATED MPN — the parts master (equality then
//   trigram substring, resolveTeIdentity) resolves the real
//   part_no/wcl_item_no; they replace the parsed values so every flow's
//   matchers and displays get the canonical identity without a second call.
//
// [DECODE-TIME] logs the per-stage cost (load/loop/identity lookup) — human-
// paced scans keep the console quiet; compare against the PDA's
// [DECODE-TIME] round-trip line to attribute latency between SQL and network.
// ---------------------------------------------------------------------------

import { dateCodeFormat } from "../config.js";
import type { AppDb } from "../db.js";
import { resolveTeIdentity } from "../db/adhocPutaway.js";
import { lookupPartsByDrawingNo } from "../db/partDrawno.js";
import { normalizePartNo } from "./codecs.js";
import { getDecodeData } from "./cache.js";
import { decodeWithTemplates, type DecodedScan, type ScanDecodeInput } from "./template.js";

export async function decodeScan(db: AppDb, input: ScanDecodeInput): Promise<DecodedScan> {
  const parts: string[] = [];
  let prev = performance.now();
  const tick = (stage: string) => {
    const now = performance.now();
    parts.push(`${stage} ${(now - prev).toFixed(1)}ms`);
    prev = now;
  };

  // ~0ms once the process cache is warm (decode/cache.ts).
  const { templates, periods } = await getDecodeData(db);
  tick("load");

  let result = decodeWithTemplates(input, templates, periods, dateCodeFormat());
  tick("loop");

  const log = () =>
    console.log(
      `[DECODE-TIME] ${parts.join(" + ")} | ${templates.length} templates -> matched=${result.matched}` +
        (result.supplier ? ` (${result.supplier.code})` : "")
    );

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
    tick("drawno");
    log();
    return result;
  }

  // TE labels print truncated MPNs — resolve the real master keys. When the
  // master holds several wcl keys for one part (TE-/TE+ dupes) and nothing
  // disambiguates, itemId still becomes the canonical part_no but wclItemNo
  // is DROPPED — the fake "<brand>/<mpn>" derivation must never reach the
  // UI/matchers as if it were real.
  if (result.matched && result.parsed.itemId && result.supplier?.brands?.includes("TE")) {
    const identity = await resolveTeIdentity(db, result.parsed.itemId, input.targets);
    if (identity) {
      result.parsed.itemId = identity.partNo;
      result.parsed.wclItemNo = identity.wclItemNo ?? undefined;
    }
    tick("te-parts");
    log();
    return result;
  }

  // Targets-gate rejection: the drawing/truncated code is never among the
  // order targets, so re-run ungated and accept the identity translation
  // only when exactly one resolution lands inside the (normalized) targets.
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
        result = ungated;
        tick("ncc-rerun");
        log();
        return result;
      }
    }
    if (ungated.matched && ungated.parsed.itemId && ungated.supplier?.brands?.includes("TE")) {
      const identity = await resolveTeIdentity(db, ungated.parsed.itemId, input.targets);
      if (identity) {
        ungated.parsed.itemId = identity.partNo;
        ungated.parsed.wclItemNo = identity.wclItemNo ?? undefined;
        result = ungated;
        tick("te-rerun");
        log();
        return result;
      }
    }
  }

  log();
  return result;
}
