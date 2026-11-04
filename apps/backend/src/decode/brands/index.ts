// ---------------------------------------------------------------------------
// Per-brand identity post-processors for the decode pipeline (service.ts).
//
// Template matching (template.ts) only READS the label. Some suppliers then
// need a DB-backed identity translation before the parsed values can be
// trusted — each brand owns that in its own file and this dispatch table is
// the single entry point: add brands/<brand>.ts exporting resolve(), register
// it in `registry` below. The first registered resolver sharing any brand
// with the decoded profile wins.
//
// Contract — resolve() mutates `parsed` (itemId/wclItemNo) in place and
// returns whether the scan is ACCEPTED:
// - normal pass (gated=false): the template matched; translate the identity
//   or leave the label values alone when nothing can be honestly resolved
//   (return value ignored).
// - targets-gate pass (gated=true): the scan FAILED the order-targets gate
//   (drawing/truncated codes are never among the targets) and was re-run
//   ungated; return true only when the translated identity belongs on this
//   order — false drops the rerun. `targets` is non-empty in this pass.
//
// Value conversions a template can express (KOA qty/date-code codecs) live
// in codecs.ts + template config, NOT here — this registry is only for
// post-match lookups that need the database.
// ---------------------------------------------------------------------------

import type { AppDb } from "../../db.js";
import type { DecodedScan } from "../template.js";
import { resolve as resolveNcc } from "./ncc.js";
import { resolve as resolveTe } from "./te.js";

/** DecodedScan["parsed"] — what resolvers mutate in place. */
export type ParsedFields = DecodedScan["parsed"];

export interface BrandResolver {
  /** stage label for the [DECODE-TIME] log */
  name: string;
  /** supplier_profiles.brands values that trigger this resolver */
  brands: string[];
  resolve(
    db: AppDb,
    parsed: ParsedFields,
    targets: string[] | undefined,
    gated: boolean
  ): Promise<boolean>;
}

const registry: BrandResolver[] = [
  { name: "ncc-drawno", brands: ["NCC"], resolve: resolveNcc },
  { name: "te-parts", brands: ["TE"], resolve: resolveTe },
];

/** The first resolver registered for any of the decoded profile's brands. */
export function resolverFor(brands: string[] | undefined): BrandResolver | undefined {
  return brands?.length ? registry.find((r) => brands.some((b) => r.brands.includes(b))) : undefined;
}
