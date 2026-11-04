// NCC labels carry the numeric DRAWING CODE as itemId — wcl_part_drawno
// resolves the WCL item no (spec 2026-11-03-ncc-drawno-part-lookup-design.md).
// The single-brand profile derivation ("NCC/<itemId>") yields a bogus
// wclItemNo for NCC, so a unique resolution overrides it; itemId itself
// stays the drawing code.

import type { AppDb } from "../../db.js";
import { lookupPartsByDrawingNo } from "../../db/partDrawno.js";
import { normalizePartNo } from "../codecs.js";
import type { ParsedFields } from "./index.js";

export async function resolve(
  db: AppDb,
  parsed: ParsedFields,
  targets: string[] | undefined,
  gated: boolean
): Promise<boolean> {
  const drawno = parsed.itemId;
  if (!drawno) return true;
  const wcls = [...new Set((await lookupPartsByDrawingNo(db, drawno)).map((m) => m.wclItemNo))];
  if (!gated) {
    if (wcls.length === 1) parsed.wclItemNo = wcls[0];
    return true;
  }
  // The drawing code is never among the order targets — accept the ungated
  // rerun only when exactly one resolved wcl_item_no is.
  const norms = new Set((targets ?? []).map(normalizePartNo));
  const onOrder = wcls.filter((w) => norms.has(normalizePartNo(w)));
  if (onOrder.length !== 1) return false;
  parsed.wclItemNo = onOrder[0];
  return true;
}
