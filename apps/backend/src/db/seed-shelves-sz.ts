// SZ warehouse shelf layout — seeded when WAREHOUSE_CODE=sz (seedReferenceOnly
// in seed.ts). Same shape as seed-shelves-hk.ts: zone groups flattened into
// shelves rows. The app runs one instance per warehouse, so the SZ instance
// gets its own database seeded from this file instead of the HK layout.

import { shelfDisplayName } from "./seed-shelves-hk.js";

/** Numeric range, zero-padded: numRange("SZD", 1, 3) → SZD01, SZD02, SZD03 */
function numRange(prefix: string, start: number, end: number, pad = 2): string[] {
  return Array.from({ length: end - start + 1 }, (_, i) => `${prefix}${String(start + i).padStart(pad, "0")}`);
}

/** Letter-suffix range: letterRange("GZC11", "A", "D") → GZC11A..GZC11D */
function letterRange(base: string, from: string, to: string): string[] {
  const out: string[] = [];
  for (let c = from.charCodeAt(0); c <= to.charCodeAt(0); c++) out.push(`${base}${String.fromCharCode(c)}`);
  return out;
}

const szShelfZones: { zone: string | null; shelf: string[] }[] = [
  {
    zone: "GZC",
    shelf: [
      // GZC11 A-D, GZC10 A-F, GZC01A-GZC09A
      ...letterRange("GZC11", "A", "D"),
      ...letterRange("GZC10", "A", "F"),
      ...numRange("GZC", 1, 9).map((n) => `${n}A`),
    ],
  },
  {
    zone: "GZB",
    shelf: [
      // GZB01 A-F, GZB08 A-F, GZB01A-GZB06A (GZB01A already in GZB01 A-F —
      // deduped on export, shelves.code is UNIQUE)
      ...letterRange("GZB01", "A", "F"),
      ...letterRange("GZB08", "A", "F"),
      ...numRange("GZB", 1, 6).map((n) => `${n}A`),
    ],
  },
  {
    zone: null,
    shelf: [
      // SZD01-64, SZE01-64, SZF01-64, GZH01-64
      ...numRange("SZD", 1, 64),
      ...numRange("SZE", 1, 64),
      ...numRange("SZF", 1, 64),
      ...numRange("GZH", 1, 64),
      // SHA01-32, HKA01-16, BJA01-16
      ...numRange("SHA", 1, 32),
      ...numRange("HKA", 1, 16),
      ...numRange("BJA", 1, 16),
      // SZG01-60, SZH01-60, SZI01-60, SZJ01-60, GZE01-60, GZF01-60
      ...numRange("SZG", 1, 60),
      ...numRange("SZH", 1, 60),
      ...numRange("SZI", 1, 60),
      ...numRange("SZJ", 1, 60),
      ...numRange("GZE", 1, 60),
      ...numRange("GZF", 1, 60),
      "SHB01A", "SHB01B",
      // SZC01A-09A, SZC10A-B, SZC11A-F, SZC12A-F, SZC13A-E
      ...numRange("SZC", 1, 9).map((n) => `${n}A`),
      ...letterRange("SZC10", "A", "B"),
      ...letterRange("SZC11", "A", "F"),
      ...letterRange("SZC12", "A", "F"),
      ...letterRange("SZC13", "A", "E"),
    ],
  },
  {
    zone: "GZA",
    shelf: [
      // GZA01A-P .. GZA05A-P
      ...letterRange("GZA01", "A", "P"),
      ...letterRange("GZA02", "A", "P"),
      ...letterRange("GZA03", "A", "P"),
      ...letterRange("GZA04", "A", "P"),
      ...letterRange("GZA05", "A", "P"),
    ],
  },
  {
    zone: "SZA",
    shelf: [
      // SZA01A-P .. SZA10A-P, SZA11A-B, SZA12A-B
      ...letterRange("SZA01", "A", "P"),
      ...letterRange("SZA02", "A", "P"),
      ...letterRange("SZA03", "A", "P"),
      ...letterRange("SZA04", "A", "P"),
      ...letterRange("SZA05", "A", "P"),
      ...letterRange("SZA06", "A", "P"),
      ...letterRange("SZA07", "A", "P"),
      ...letterRange("SZA08", "A", "P"),
      ...letterRange("SZA09", "A", "P"),
      ...letterRange("SZA10", "A", "P"),
      "SZA11A", "SZA11B", "SZA12A", "SZA12B",
    ],
  },
  {
    zone: "SZB",
    shelf: [
      // SZB01-04, SZB05A-F, SZB06A-F, SZB07A-F
      ...numRange("SZB", 1, 4),
      ...letterRange("SZB05", "A", "F"),
      ...letterRange("SZB06", "A", "F"),
      ...letterRange("SZB07", "A", "F"),
    ],
  },
];

/** Flattened { code, displayName, zone, warning? } rows ready to insert into
 *  the shelves table. Deduped — shelves.code is UNIQUE and the GZB rules
 *  overlap on GZB01A. */
const seen = new Set<string>();
export const szShelves: { code: string; displayName?: string; zone: string | null; warning?: string }[] = [];
for (const z of szShelfZones) {
  for (const code of z.shelf) {
    if (seen.has(code)) continue;
    seen.add(code);
    szShelves.push({ code, displayName: shelfDisplayName(code), zone: z.zone });
  }
}
