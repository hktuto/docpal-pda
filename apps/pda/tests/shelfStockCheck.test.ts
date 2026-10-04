import { describe, it, expect, vi } from 'vitest';
import { createShelfStockChecker } from '~/utils/shelfStockCheck';

// Scan-time shelf presence check (pickingShelfScan require-match): stock of
// the scanned part on the pending shelf, cached per (location, part).
describe('createShelfStockChecker', () => {
  it('hasStock reflects the fetched qty', async () => {
    const fetchQty = vi.fn(async () => 500);
    const checker = createShelfStockChecker(fetchQty);
    await expect(checker.hasStock({ partNo: 'P1', shelfCode: 'A-01' })).resolves.toBe(true);

    const empty = createShelfStockChecker(async () => 0);
    await expect(empty.hasStock({ partNo: 'P1', shelfCode: 'A-01' })).resolves.toBe(false);
  });

  it('caches per (location, part) — one fetch per key per session', async () => {
    const fetchQty = vi.fn(async () => 10);
    const checker = createShelfStockChecker(fetchQty);
    await checker.qtyAt({ partNo: 'P1', shelfCode: 'A-01' });
    await checker.qtyAt({ partNo: 'P1', shelfCode: 'A-01' });
    expect(fetchQty).toHaveBeenCalledTimes(1);
    // a different part or a different shelf is a new lookup
    await checker.qtyAt({ partNo: 'P2', shelfCode: 'A-01' });
    await checker.qtyAt({ partNo: 'P1', shelfCode: 'B-02' });
    // a box id distinguishes the location from its shelf
    await checker.qtyAt({ partNo: 'P1', shelfCode: 'A-01', boxId: 'BOX-1' });
    expect(fetchQty).toHaveBeenCalledTimes(4);
  });
});
