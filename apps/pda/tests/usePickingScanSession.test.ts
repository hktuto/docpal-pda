import { describe, it, expect, vi, beforeEach } from 'vitest';

// vue is not a direct dependency (comes via nuxt), so mock it like the other
// composable tests do — ref as a plain box, computed as a live getter.
vi.mock('vue', () => ({
  ref: (value: unknown) => ({ value }),
  computed: (fn: () => unknown) => ({ get value() { return fn(); } }),
}));

type RawParseResult = { matched: boolean; parsed: Record<string, unknown> };
const parseRawValue = vi.fn<(raw: string) => Promise<RawParseResult>>();
vi.mock('~/composables/useLabelScan', () => ({
  useLabelScan: () => ({ parseRawValue }),
  ocrResultToInput: (parsed: Record<string, unknown>) => ({
    partNo: parsed.itemId ?? '',
    qty: parsed.qty ?? '',
    dateCode: parsed.dateCode ?? '',
    lotCode: parsed.lotCode ?? '',
    coo: parsed.coo ?? '',
    cow: parsed.cow ?? '',
    wclItemNo: parsed.wclItemNo ?? null,
  }),
}));

const { ref } = await import('vue');
const { usePickingScanSession } = await import('~/composables/usePickingScanSession');
import type { PickingOrderDetail, PickingShelfStockQuery } from '~/services/types';

type Items = PickingOrderDetail['items'];

function makeItems(): Items {
  return [
    {
      id: 'item-1',
      partNo: 'PART-1',
      wclItemNo: null,
      brand: 'KOA',
      qty: 3000,
      pickedQty: 0,
      allocatedQty: 3000,
      allocations: [
        // lot source (shelf box)
        { id: 'alloc-1', qty: 1000, lot: { id: 'lot-1', shelfCode: 'SZA01', shelfWarning: null, boxId: null, dateCode: '2626', lotCode: 'L01', coo: 'CN', cow: null, totalQty: 1000, allocatedQty: 1000, availableQty: 1000 }, receivingInvoiceItemId: null, receivingOrderId: null, boxId: null },
        // receiving carton source
        { id: 'alloc-2', qty: 2000, lot: null, receivingInvoiceItemId: 'ri-1', receivingOrderId: 'ro-1', boxId: 'CTN-9' },
      ],
      packages: [],
    },
    {
      id: 'item-2',
      partNo: 'PART-2',
      wclItemNo: null,
      brand: null,
      qty: 1000,
      pickedQty: 0,
      allocatedQty: 1000,
      allocations: [
        // shelf code source (bare shelf, no box)
        { id: 'alloc-3', qty: 1000, lot: { id: 'lot-2', shelfCode: 'SZB02', shelfWarning: null, boxId: null, dateCode: '2631', lotCode: 'L02', coo: null, cow: null, totalQty: 1000, allocatedQty: 1000, availableQty: 1000 }, receivingInvoiceItemId: null, receivingOrderId: null, boxId: null },
      ],
      packages: [],
    },
  ] as unknown as Items;
}

const label = (partNo: string, qty: number | string, over: Record<string, unknown> = {}) => ({
  matched: true,
  parsed: { itemId: partNo, qty, dateCode: '', lotCode: '', coo: '', cow: '', wclItemNo: null, serialNo: null, ...over },
});

/** Dock-only order: every allocation is a receiving-area source (no lot) —
 *  these never require a shelf scan, even in the require-* modes. */
function makeDockItems(): Items {
  return [
    {
      id: 'item-9',
      partNo: 'PART-9',
      wclItemNo: null,
      brand: null,
      qty: 500,
      pickedQty: 0,
      allocatedQty: 500,
      allocations: [
        { id: 'alloc-9', qty: 500, lot: null, receivingInvoiceItemId: 'ri-9', receivingOrderId: 'ro-9', boxId: 'CTN-9' },
      ],
      packages: [],
    },
  ] as unknown as Items;
}

function setup(
  mode: 'off' | 'require-match' | 'require-any',
  shelfStockFn?: (q: PickingShelfStockQuery) => Promise<number>,
  items?: Items
) {
  const itemsRef = ref(items ?? makeItems());
  const session = usePickingScanSession({
    orderItems: itemsRef,
    scope: ref({ orgId: 2, subInventoryCode: 'STORE1' }),
    shelfMode: ref(mode),
    shelfStockFn: shelfStockFn ?? (async () => 100),
  });
  return { items: itemsRef, session };
}

describe('usePickingScanSession', () => {
  beforeEach(() => {
    parseRawValue.mockReset();
  });

  it('queues a matched label scan', async () => {
    const { session } = setup('off');
    parseRawValue.mockResolvedValue(label('PART-1', 1000));
    const r = await session.handleQrOrBoxScan(':A::1:X:L:S:F');
    expect(r).toMatchObject({ ok: true, kind: 'queued' });
    expect(session.rows.value).toHaveLength(1);
    expect(session.rows.value[0]).toMatchObject({ itemId: 'item-1', allocationId: 'alloc-1', qty: 1000 });
  });

  it('rejects a duplicate raw label', async () => {
    const { session } = setup('off');
    parseRawValue.mockResolvedValue(label('PART-1', 1000));
    await session.handleQrOrBoxScan(':A::1:X:L:S:F');
    const r = await session.handleQrOrBoxScan(':A::1:X:L:S:F');
    expect(r).toEqual({ ok: false, message: 'duplicate' });
  });

  it('rejects a COO mismatch against the lot source', async () => {
    const { session } = setup('off');
    parseRawValue.mockResolvedValue(label('PART-1', 1000, { coo: 'US' }));
    const r = await session.handleQrOrBoxScan(':A::1:X:L:S:F');
    expect(r).toEqual({ ok: false, message: 'coo_mismatch' });
  });

  it('auto-queues a receiving-carton scan', async () => {
    const { session } = setup('off');
    parseRawValue.mockResolvedValue({ matched: false, parsed: {} });
    const r = await session.handleQrOrBoxScan('CTN-9');
    expect(r).toMatchObject({ ok: true, kind: 'carton', count: 1, qty: 2000 });
    expect(session.rows.value[0]).toMatchObject({ allocationId: 'alloc-2', qty: 2000 });
  });

  it('opens the pick-from-box dialog on a shelf-box scan in off mode', async () => {
    const { session } = setup('off');
    parseRawValue.mockResolvedValue({ matched: false, parsed: {} });
    const r = await session.handleQrOrBoxScan('SZA01');
    expect(r).toMatchObject({ ok: true, kind: 'boxpick' });
    expect(session.boxPickId.value).toBe('SZA01');
    expect(session.boxPickEntries.value[0]).toMatchObject({ allocationId: 'alloc-1', required: 1000, queued: 0 });
  });

  it('rejects an unmatched non-label scan in off mode', async () => {
    const { session } = setup('off');
    parseRawValue.mockResolvedValue({ matched: false, parsed: {} });
    const r = await session.handleQrOrBoxScan('NOPE-1');
    expect(r).toEqual({ ok: false, message: 'no_match' });
  });

  it('queues a label scanned from the pick-from-box dialog', async () => {
    const { session } = setup('off');
    parseRawValue.mockResolvedValue({ matched: false, parsed: {} });
    await session.handleQrOrBoxScan('SZA01');
    parseRawValue.mockResolvedValue(label('PART-1', 1000));
    const r = await session.handleBoxPickScan(':A::1:X:L:S:F');
    expect(r).toMatchObject({ ok: true, kind: 'queued' });
    expect(session.rows.value[0]).toMatchObject({ allocationId: 'alloc-1', qty: 1000 });
  });

  it('rejects a foreign part scanned from the pick-from-box dialog', async () => {
    const { session } = setup('off');
    parseRawValue.mockResolvedValue({ matched: false, parsed: {} });
    await session.handleQrOrBoxScan('SZA01');
    parseRawValue.mockResolvedValue(label('PART-2', 1000));
    const r = await session.handleBoxPickScan(':A::2:X:L:S:F');
    expect(r).toEqual({ ok: false, message: 'part_not_in_box' });
  });

  it('queues a carton scan straight from the pick-from-box dialog (closing it)', async () => {
    const { session } = setup('off');
    parseRawValue.mockResolvedValue({ matched: false, parsed: {} });
    await session.handleQrOrBoxScan('SZA01');
    const r = await session.handleBoxPickScan('CTN-9');
    expect(r).toMatchObject({ ok: true, kind: 'carton' });
    expect(session.boxPickId.value).toBeNull();
  });

  it('require-match rejects a label before any shelf scan', async () => {
    const { session } = setup('require-match');
    parseRawValue.mockResolvedValue(label('PART-1', 1000));
    const r = await session.handleQrOrBoxScan(':A::1:X:L:S:F');
    expect(r).toEqual({ ok: false, message: 'scanShelfFirst' });
  });

  it('require-match gates the label on the shelf-stock pre-check', async () => {
    const stocked = setup('require-match');
    parseRawValue.mockResolvedValue({ matched: false, parsed: {} });
    await stocked.session.handleQrOrBoxScan('SZA01'); // sets the sticky shelf
    parseRawValue.mockResolvedValue(label('PART-1', 1000));

    const noStock = setup('require-match', async () => 0);
    parseRawValue.mockResolvedValue({ matched: false, parsed: {} });
    await noStock.session.handleQrOrBoxScan('SZA01');
    parseRawValue.mockResolvedValue(label('PART-1', 1000));
    expect((await noStock.session.handleQrOrBoxScan(':A::1:X:L:S:F'))).toEqual({
      ok: false,
      message: 'item_not_on_shelf',
    });

    expect((await stocked.session.handleQrOrBoxScan(':A::1:X:L:S:F'))).toMatchObject({
      ok: true,
      kind: 'queued',
    });
  });

  it('require-any accepts an unmatched shelf scan as the sticky location', async () => {
    const { session } = setup('require-any');
    parseRawValue.mockResolvedValue({ matched: false, parsed: {} });
    const r = await session.handleQrOrBoxScan('NEW-SHELF');
    expect(r).toMatchObject({ ok: true, kind: 'shelf' });
    expect(session.pendingShelf.value).toMatchObject({ shelfCode: 'NEW-SHELF', boxId: null });
  });

  it('require-* ignores label scans for the shelf banner (shelf scans only set context)', async () => {
    const { session } = setup('require-any');
    parseRawValue.mockResolvedValue({ matched: false, parsed: {} });
    await session.handleQrOrBoxScan('SZA01');
    expect(session.pendingShelf.value).toMatchObject({ shelfCode: 'SZA01', boxId: null });
    expect(session.rows.value).toHaveLength(0);
  });

  it('require-match queues a dock-sourced label with no shelf scan at all', async () => {
    const { session } = setup('require-match', undefined, makeDockItems());
    parseRawValue.mockResolvedValue(label('PART-9', 500));
    const r = await session.handleQrOrBoxScan(':A::9:X:L:S:F');
    expect(r).toMatchObject({ ok: true, kind: 'queued' });
    expect(session.rows.value[0]).toMatchObject({ allocationId: 'alloc-9', qty: 500 });
    expect(session.pendingShelf.value).toBeNull();
    expect(session.shelfWorkRemaining.value).toBe(false);
  });

  it('require-any gates the lot portion of a label, then lets the dock remainder through', async () => {
    const { session } = setup('require-any');
    // PART-1/1000 fits the lot allocation first → shelf scan required
    parseRawValue.mockResolvedValue(label('PART-1', 1000));
    expect(await session.handleQrOrBoxScan(':A::1:X:L:S:F')).toEqual({ ok: false, message: 'scanShelfFirst' });
    expect(session.rows.value).toHaveLength(0);

    // with the sticky shelf set, the lot allocation queues…
    parseRawValue.mockResolvedValue({ matched: false, parsed: {} });
    await session.handleQrOrBoxScan('SZA01');
    parseRawValue.mockResolvedValue(label('PART-1', 1000));
    expect(await session.handleQrOrBoxScan(':A::2:X:L:S:F')).toMatchObject({ ok: true, kind: 'queued' });
    expect(session.rows.value[0]).toMatchObject({ allocationId: 'alloc-1' });

    // …and once the lot is covered, the next label fits only the receiving
    // allocation — no shelf context needed anymore.
    session.clearPendingShelf();
    parseRawValue.mockResolvedValue(label('PART-1', 1000));
    expect(await session.handleQrOrBoxScan(':A::3:X:L:S:F')).toMatchObject({ ok: true, kind: 'queued' });
    expect(session.rows.value[0]).toMatchObject({ allocationId: 'alloc-2' });
    expect(session.pendingShelf.value).toBeNull();
  });

  it('require-match skips the shelf-stock pre-check for a dock-sourced label', async () => {
    const shelfStockFn = vi.fn(async () => 100);
    const { session } = setup('require-match', shelfStockFn, makeDockItems());
    parseRawValue.mockResolvedValue(label('PART-9', 500));
    expect(await session.handleQrOrBoxScan(':A::9:X:L:S:F')).toMatchObject({ ok: true, kind: 'queued' });
    expect(shelfStockFn).not.toHaveBeenCalled();
  });

  it('shelfWorkRemaining reflects remaining lot-sourced work only', async () => {
    const { session } = setup('off');
    expect(session.shelfWorkRemaining.value).toBe(true);
    parseRawValue.mockResolvedValue(label('PART-1', 1000));
    await session.handleQrOrBoxScan(':A::1:X:L:S:F');
    parseRawValue.mockResolvedValue(label('PART-2', 1000));
    await session.handleQrOrBoxScan(':A::2:X:L:S:F');
    // both lot allocations are fully queued; only the dock allocation remains
    expect(session.shelfWorkRemaining.value).toBe(false);
  });

  it('completed is true only with an empty queue and every item fully scanned', () => {
    const { items, session } = setup('off');
    expect(session.completed.value).toBe(false);
    items.value = items.value.map((i) => ({
      ...i,
      packages: [{ id: 'pkg-1', qty: i.qty, dateCode: null, lotCode: null, coo: null, cow: null, verified: false, rescannedQty: 0, labelBarcode: null, shippingBoxId: null, sourceType: 'lot', sourceId: 'lot-1' }],
    })) as unknown as Items;
    expect(session.completed.value).toBe(true);
  });

  it('confirm applies queued rows with re-resolve and returns the failed count', async () => {
    const { session } = setup('off');
    parseRawValue.mockResolvedValue(label('PART-1', 1000));
    await session.handleQrOrBoxScan(':A::1:X:L:S:F');
    parseRawValue.mockResolvedValue(label('PART-1', 1000));
    await session.handleQrOrBoxScan(':A::2:X:L:S:F');

    const applied: string[] = [];
    let afterApplyCalls = 0;
    const failed = await session.confirm(
      async (row) => {
        applied.push(row.key);
        // Fail the first applied row (queue is newest-first); keys come from
        // the queue's module-level counter, so match on position, not name.
        if (applied.length === 1) throw new Error('boom');
      },
      (e) => (e instanceof Error ? e.message : String(e)),
      async () => { afterApplyCalls += 1; }
    );
    expect(failed).toBe(1);
    expect(applied).toHaveLength(2);
    expect(afterApplyCalls).toBe(1);
    // the applied row is dropped, the failed row stays with its error
    expect(session.rows.value).toHaveLength(1);
    expect(session.rows.value[0]).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('confirm is a no-op while applying or with an empty queue', async () => {
    const { session } = setup('off');
    expect(await session.confirm(async () => {}, String)).toBe(0);
  });
});
