// Scan-to-open for the CN put-away task list (spec
// docs/superpowers/specs/2026-10-16-customer-receiving-upload-design.md):
// the admin CN order detail exports an Excel whose QR payload is the shared
// `warehouse://putaway-cn/<taskId>` order link (resolved globally by
// useOrderScanNav from any page). The put-away detail in CN mode is
// task-scoped — it reads the task aggregate by ?task= and synthesizes the
// order from it, so only the task id matters here.
//
// Accepted shapes:
//   warehouse://putaway-cn/<taskId>      (the Excel QR payload)
//   /put-away/<anything>?task=<taskId>   (legacy payload; extra query params
//                                         are ignored)
//   <taskId>                              (a bare UUID, convenience for
//                                         scanning/copying the id itself)

/** `warehouse://putaway-cn/<taskId>` — the shared order-link scheme. */
const ORDER_LINK_RE = /^warehouse:\/\/putaway-cn\/([^/?&]+)$/;

/** `/put-away/<id>?task=<taskId>` — the <id> segment is captured but unused
 *  (the CN detail ignores route.params.id). */
const FULL_PATH_RE = /^\/put-away\/[^?]+\?task=([^&]+)/;

/** Bare task id: the backend's ids are UUID v7. */
const BARE_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Resolves a scanned value to the CN put-away task it opens, or null when
 * the value is neither a put-away link payload nor a bare task id (the
 * caller toasts and moves on).
 */
export function parsePutAwayOpenScan(text: string): { taskId: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const linkMatch = trimmed.match(ORDER_LINK_RE);
  if (linkMatch) {
    const taskId = decodeURIComponent(linkMatch[1]).trim();
    return taskId ? { taskId } : null;
  }
  const pathMatch = trimmed.match(FULL_PATH_RE);
  if (pathMatch) {
    const taskId = decodeURIComponent(pathMatch[1]).trim();
    return taskId ? { taskId } : null;
  }
  if (BARE_ID_RE.test(trimmed)) return { taskId: trimmed };
  return null;
}
