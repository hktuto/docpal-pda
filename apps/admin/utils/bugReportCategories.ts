// Per-page curation of the shared bug-report category vocabulary (spec
// docs/superpowers/specs/2026-11-05-in-app-bug-report-design.md). Same
// global vocabulary as the backend (apps/backend/src/db/bugReports.ts);
// this map only decides which chips a page shows, longest prefix wins.

// Full vocabulary — kept in sync with the backend
// (apps/backend/src/db/bugReports.ts BUG_CATEGORIES). The triage page filter
// lists every id; the modal chips list a curated subset per page.
export const BUG_CATEGORY_IDS = [
  "scan_failed",
  "date_code",
  "wrong_data",
  "missing_data",
  "duplicate",
  "label_print",
  "blocked",
  "slow",
  "ui_text",
  "login",
  "other",
];

export const GENERIC_CATEGORIES = ["wrong_data", "missing_data", "blocked", "slow", "other"];

const ROUTE_PREFIXES: Array<[prefix: string, categories: string[]]> = [
  ["/receiving-cn", ["missing_data", "wrong_data", "duplicate", "blocked", "other"]],
  ["/receiving", ["wrong_data", "missing_data", "duplicate", "date_code", "other"]],
  ["/picking-orders", ["wrong_data", "missing_data", "blocked", "other"]],
  ["/picking/reorder", ["wrong_data", "blocked", "other"]],
  ["/issues", ["wrong_data", "missing_data", "duplicate", "other"]],
  ["/outdated-warnings", ["date_code", "wrong_data", "blocked", "other"]],
  ["/shipping", ["wrong_data", "label_print", "blocked", "other"]],
  ["/label-print-rules", ["label_print", "wrong_data", "other"]],
  ["/inventory-labels", ["label_print", "duplicate", "other"]],
  ["/ad-hoc-put-aways", ["wrong_data", "blocked", "other"]],
  ["/shelf-boxes", ["wrong_data", "missing_data", "duplicate", "other"]],
  ["/shelves", ["wrong_data", "missing_data", "duplicate", "other"]],
  ["/stock-search", ["wrong_data", "missing_data", "slow", "other"]],
  ["/item-ledger", ["wrong_data", "missing_data", "duplicate", "other"]],
  ["/parts", ["wrong_data", "missing_data", "duplicate", "other"]],
  ["/suppliers", ["wrong_data", "missing_data", "other"]],
  ["/task-assignments", ["wrong_data", "blocked", "ui_text", "other"]],
  ["/flow-config", ["ui_text", "blocked", "other"]],
  ["/display-config", ["ui_text", "other"]],
  ["/pda-view-config", ["ui_text", "other"]],
];

/** Curated chip list for a route path ("/" home falls back to the generic set). */
export function categoriesForRoute(path: string): string[] {
  const hit = [...ROUTE_PREFIXES]
    .sort((a, b) => b[0].length - a[0].length)
    .find(([prefix]) => path.startsWith(prefix) && prefix !== "/");
  return hit ? hit[1] : GENERIC_CATEGORIES;
}
