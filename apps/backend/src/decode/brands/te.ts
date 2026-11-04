// TE labels print a TRUNCATED MPN (e.g. "1571983-1" where the master stores
// "1-1571983-1") — the parts master resolves the real part_no/wcl_item_no
// (db/partIdentity.ts: normalized equality, trigram substring, AMP-wrapped
// dupe preferred, order targets disambiguate). The resolved keys REPLACE the
// parsed identity so every flow's matchers and displays get canonical values.

import type { AppDb } from "../../db.js";
import { resolveTeIdentity } from "../../db/partIdentity.js";
import type { ParsedFields } from "./index.js";

export async function resolve(
  db: AppDb,
  parsed: ParsedFields,
  targets: string[] | undefined,
  gated: boolean
): Promise<boolean> {
  if (!parsed.itemId) return true;
  const identity = await resolveTeIdentity(db, parsed.itemId, targets);
  if (!identity) return !gated;
  parsed.itemId = identity.partNo;
  parsed.wclItemNo = identity.wclItemNo;
  return true;
}
