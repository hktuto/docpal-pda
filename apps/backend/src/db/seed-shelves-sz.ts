// SZ warehouse shelf layout — seeded when WAREHOUSE_CODE=sz (seedReferenceOnly
// in seed.ts). Same shape as seed-shelves-hk.ts: zone groups flattened into
// shelves rows. The app runs one instance per warehouse, so the SZ instance
// gets its own database seeded from this file instead of the HK layout.
//
// TODO: replace the placeholder codes below with the real SZ layout — zone
// names + shelf codes. Mark any outdated-stock warning shelves the way HK's
// OL01–OL08 are marked (see seed-shelves-hk.ts).

import { shelfDisplayName } from "./seed-shelves-hk.js";

const szShelfZones: { zone: string | null; shelf: string[] }[] = [
  {
    // TODO: real SZ zones + shelf codes
    zone: "SZ Store",
    shelf: ["S01", "S02", "S03"],
  },
];

/** Flattened { code, displayName, zone, warning? } rows ready to insert into
 *  the shelves table. */
export const szShelves: { code: string; displayName?: string; zone: string | null; warning?: string }[] = szShelfZones.flatMap(
  (z) => z.shelf.map((code) => ({
    code,
    displayName: shelfDisplayName(code),
    zone: z.zone,
  }))
);
