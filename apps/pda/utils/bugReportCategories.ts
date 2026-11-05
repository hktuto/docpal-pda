// Per-page curation of the shared bug-report category vocabulary (spec
// docs/superpowers/specs/2026-11-05-in-app-bug-report-design.md). The
// vocabulary is global snake_case (mirrored server-side in
// apps/backend/src/db/bugReports.ts) so admin filtering never fragments;
// this map only decides which chips a page SHOWS, longest-prefix wins.

export const GENERIC_CATEGORIES = ["scan_failed", "wrong_data", "blocked", "slow", "other"];

const ROUTE_PREFIXES: Array<[prefix: string, categories: string[]]> = [
  // "/receiving-cn-scan" must be checked before "/receiving" — sorted below.
  ["/receiving-cn-scan", ["scan_failed", "date_code", "wrong_data", "blocked", "other"]],
  ["/receiving", ["scan_failed", "date_code", "wrong_data", "duplicate", "blocked", "other"]],
  ["/manual-receiving", ["scan_failed", "wrong_data", "date_code", "blocked", "other"]],
  ["/put-away", ["scan_failed", "blocked", "wrong_data", "duplicate", "other"]],
  ["/ad-hoc-put-away", ["scan_failed", "wrong_data", "blocked", "other"]],
  ["/shelf-exchange", ["wrong_data", "blocked", "other"]],
  ["/picking", ["scan_failed", "wrong_data", "blocked", "label_print", "other"]],
  ["/goods-verify", ["scan_failed", "wrong_data", "duplicate", "blocked", "other"]],
  ["/verify", ["scan_failed", "wrong_data", "duplicate", "blocked", "other"]],
  ["/measuring", ["wrong_data", "duplicate", "blocked", "other"]],
  ["/labeling", ["label_print", "scan_failed", "blocked", "other"]],
  ["/label-printing", ["label_print", "blocked", "other"]],
  ["/print-product-label", ["label_print", "blocked", "other"]],
  ["/stock-search", ["wrong_data", "missing_data", "slow", "other"]],
  ["/settings", ["ui_text", "login", "other"]],
];

/** Curated chip list for a route path ("/" home falls back to the generic set). */
export function categoriesForRoute(path: string): string[] {
  const hit = [...ROUTE_PREFIXES]
    .sort((a, b) => b[0].length - a[0].length)
    .find(([prefix]) => path.startsWith(prefix) && prefix !== "/");
  return hit ? hit[1] : GENERIC_CATEGORIES;
}
