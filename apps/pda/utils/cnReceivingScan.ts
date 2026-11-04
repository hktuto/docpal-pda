// CN receiving scan (收貨掃描) shared part-key normalization. Scan matching
// itself moved server-side (POST /receiving-cn/scan-tasks/:id/scan-aggregate,
// spec 2026-11-04-cn-receiving-scan-grouping); the client keeps only this
// normalization for the display group key (utils/cnScanGroups.ts).

import { normalizePartNo } from "./text";

/** Null-safe normalizePartNo — "AB 123" === "ab123", "AMP(640385-8)" ===
 *  "640385-8" (TE labels carry the bare PN, master keys may be wrapped). */
export function normalizePartKey(value: string | null | undefined): string {
  return value == null ? "" : normalizePartNo(value);
}
