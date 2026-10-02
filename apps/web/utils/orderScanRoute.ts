// Resolves PDA scans of an order-link QR (printed on the admin shipper /
// picking-list Excel exports) to an in-app route (spec
// docs/superpowers/specs/2026-10-02-excel-order-barcode-scan-to-open-design.md).
// The QR payload is `warehouse://receiving/<id>` / `warehouse://picking/<id>`
// built by the backend (apps/backend/src/export/orderLink.ts) — a custom
// scheme so no host/IP configuration is needed in the Excel file.

export const ORDER_SCAN_PREFIX = 'warehouse://';

/**
 * Returns the app route for a scanned order link, or null when the value is
 * not an order link (normal part / label scans keep flowing to the page's
 * onScan handler).
 */
export function resolveOrderScanRoute(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(ORDER_SCAN_PREFIX)) return null;
  const rest = trimmed.slice(ORDER_SCAN_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const kind = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  if ((kind !== 'receiving' && kind !== 'picking') || !id || id.includes('/')) return null;
  return `/${kind}/${id}`;
}
