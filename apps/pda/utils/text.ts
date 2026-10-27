export function normalizeString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const s = value.trim();
  return s || null;
}

export function rawCode(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

/**
 * Part-number comparison key: uppercase with ALL whitespace stripped. QR
 * labels print part numbers without the spaces the parts master carries
 * (`SR732ERTTDR200F` vs `SR732ERTTD R200F`) — mirrors normalizePartNo in
 * apps/backend/src/db/scanParse.ts. TE Connectivity parts are stored wrapped
 * as `AMP(<pn>)` (legacy `TE-AMP(<pn>)`) while labels carry the bare PN, so
 * the wrapper is unwrapped here (`AMP(640385-8)` -> `640385-8`).
 */
export function normalizePartNo(value: string): string {
  const collapsed = value.toUpperCase().replace(/\s+/g, "");
  const wrapped = /^(?:TE-)?AMP\((.+)\)$/.exec(collapsed);
  return wrapped ? wrapped[1] : collapsed;
}

export interface ScannedPartKeys {
  partNo?: string | null;
  wclItemNo?: string | null;
}

/**
 * Filter candidate items by scanned part keys with WCL-item-no preference:
 * when the scan carries a wclItemNo (a template group, or the brand-prefix
 * derivation for single-brand profiles like ABLIC — see parseQrCapture) and
 * at least one item matches it, only those items match (parts.part_no is NOT
 * unique — the same MPN can appear under several WCL item numbers, so the
 * bare partNo alone cannot disambiguate). With no wcl match the fallback is
 * today's union: any item whose part_no / wcl_item_no equals either scanned
 * key. Mirrors the receiving scan match in apps/backend/src/db/receiving.ts.
 */
export function filterScannedPartMatches<T>(
  items: T[],
  itemKeys: (item: T) => (string | null | undefined)[],
  scanned: ScannedPartKeys
): T[] {
  const keysOf = (item: T): string[] =>
    itemKeys(item)
      .filter((v): v is string => !!v)
      .map((v) => normalizePartNo(v));
  const wcl = scanned.wclItemNo ? normalizePartNo(scanned.wclItemNo) : null;
  if (wcl) {
    const byWcl = items.filter((item) => keysOf(item).includes(wcl));
    if (byWcl.length) return byWcl;
  }
  const scannedKeys = [scanned.partNo, scanned.wclItemNo]
    .filter((v): v is string => !!v)
    .map((v) => normalizePartNo(v));
  if (scannedKeys.length === 0) return [];
  return items.filter((item) => keysOf(item).some((k) => scannedKeys.includes(k)));
}
