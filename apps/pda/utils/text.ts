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
