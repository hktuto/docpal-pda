import { describe, it, expect } from 'vitest';
import { resolveOrderScanRoute, ORDER_SCAN_PREFIX } from '../utils/orderScanRoute';

describe('resolveOrderScanRoute', () => {
  it('resolves a receiving order link', () => {
    expect(resolveOrderScanRoute('warehouse://receiving/abc-123')).toBe('/receiving/abc-123');
  });

  it('resolves a picking order link to the scan session', () => {
    expect(resolveOrderScanRoute('warehouse://picking/def-456')).toBe('/picking/scan/def-456');
  });

  it('trims surrounding whitespace from the scanned value', () => {
    expect(resolveOrderScanRoute('  warehouse://picking/def-456\n')).toBe('/picking/scan/def-456');
  });

  it('returns null for a normal part / label scan', () => {
    expect(resolveOrderScanRoute('RK73H1JTTD1002F')).toBeNull();
    expect(resolveOrderScanRoute(':A::152:X:L:S:F')).toBeNull();
  });

  it('returns null for malformed order links', () => {
    expect(resolveOrderScanRoute('warehouse://unknown/abc')).toBeNull();
    expect(resolveOrderScanRoute('warehouse://picking/')).toBeNull();
    expect(resolveOrderScanRoute('warehouse://picking')).toBeNull();
    expect(resolveOrderScanRoute('warehouse://picking/a/b')).toBeNull();
    expect(resolveOrderScanRoute('http://example.com/picking/abc')).toBeNull();
  });

  it('exposes the prefix shared with the backend payload', () => {
    expect(ORDER_SCAN_PREFIX).toBe('warehouse://');
  });
});
