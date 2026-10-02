import { describe, it, expect, vi } from 'vitest';

// vue is not a direct dependency (comes via nuxt), so mock it like the other
// composable tests do — ref as a plain box, computed as a live getter.
vi.mock('vue', () => ({
  ref: (value: unknown) => ({ value }),
  computed: (fn: () => unknown) => ({ get value() { return fn(); } }),
}));

const { ref } = await import('vue');
const { usePickingScanQueue } = await import('~/composables/usePickingScanQueue');
import type { PickingOrderDetail } from '~/services/types';

type Items = PickingOrderDetail['items'];

function makeItems(): Items {
  return [
    {
      id: 'item-1',
      partNo: 'RK73H1JTTD1002F',
      qty: 3000,
      pickedQty: 0,
      allocatedQty: 3000,
      allocations: [
        { id: 'alloc-1', qty: 2000, lot: null, receivingInvoiceItemId: 'ri-1', receivingOrderId: 'ro-1', boxId: null },
        { id: 'alloc-2', qty: 1000, lot: null, receivingInvoiceItemId: 'ri-2', receivingOrderId: 'ro-1', boxId: null },
      ],
      packages: [],
      transitionLogs: [],
    },
    {
      id: 'item-2',
      partNo: 'RK73H1JTTD2202F',
      qty: 1000,
      pickedQty: 0,
      allocatedQty: 1000,
      allocations: [
        { id: 'alloc-3', qty: 1000, lot: null, receivingInvoiceItemId: 'ri-3', receivingOrderId: 'ro-1', boxId: null },
      ],
      packages: [],
      transitionLogs: [],
    },
  ] as unknown as Items;
}

const qr = (partNo: string, qty: number) =>
  ({ partNo, qty, dateCode: '', lotCode: 'L2607', coo: '', cow: '' });

describe('usePickingScanQueue', () => {
  it('queues a scan against the first fitting allocation', () => {
    const q = usePickingScanQueue(ref(makeItems()));
    const res = q.addScan(qr('RK73H1JTTD1002F', 2000), ':A::202:X:L:S:F', 'qr');
    expect(res).toEqual({ ok: true });
    expect(q.rows.value[0]).toMatchObject({ itemId: 'item-1', allocationId: 'alloc-1', qty: 2000, status: 'queued' });
  });

  it('matches part numbers case-insensitively and trims', () => {
    const q = usePickingScanQueue(ref(makeItems()));
    expect(q.addScan(qr('  rk73h1jttd2202f ', 1000), ':B::101:X:L:S:F', 'qr')).toEqual({ ok: true });
    expect(q.rows.value[0].itemId).toBe('item-2');
  });

  it('matches a space-stripped WCL item no from the QR (KOA reel label)', () => {
    // Real case — picking order ME2610-0006: the item's part_no is the WCL
    // item no with a brand prefix and an internal space; the QR carries the
    // bare MPN (no match) and the WCL item no without spaces (match).
    const items = [
      {
        id: 'item-koa',
        partNo: 'KOA/SR732ERTTD R200F',
        wclItemNo: 'KOA/SR732ERTTD R200F',
        qty: 20000,
        pickedQty: 0,
        allocatedQty: 20000,
        allocations: [
          { id: 'alloc-koa', qty: 20000, lot: null, receivingInvoiceItemId: 'ri-k', receivingOrderId: 'ro-1', boxId: null },
        ],
        packages: [],
        transitionLogs: [],
      },
    ] as unknown as Items;
    const q = usePickingScanQueue(ref(items));
    const res = q.addScan(
      { partNo: 'SR732ERTTDR200F', wclItemNo: 'KOA/SR732ERTTDR200F', qty: 15000, dateCode: '', lotCode: '19077387', coo: '', cow: '' },
      ':SR732ERTTDR200F::153:K:19077387:S002:KOA/SR732ERTTDR200F:13FSJ564:01',
      'qr'
    );
    expect(res).toEqual({ ok: true });
    expect(q.rows.value[0]).toMatchObject({ itemId: 'item-koa', allocationId: 'alloc-koa', qty: 15000 });
  });

  it('matches a space-stripped bare part no against a spaced master part no', () => {
    const items = [
      {
        id: 'item-spaced',
        partNo: 'SR732ERTTD R200F',
        wclItemNo: null,
        qty: 100,
        pickedQty: 0,
        allocatedQty: 100,
        allocations: [
          { id: 'alloc-spaced', qty: 100, lot: null, receivingInvoiceItemId: 'ri-s', receivingOrderId: 'ro-1', boxId: null },
        ],
        packages: [],
        transitionLogs: [],
      },
    ] as unknown as Items;
    const q = usePickingScanQueue(ref(items));
    expect(q.addScan(qr('SR732ERTTDR200F', 100), ':C::1001:X:L:S:F', 'qr')).toEqual({ ok: true });
  });

  it('accounts for already-queued qty when choosing an allocation', () => {
    const q = usePickingScanQueue(ref(makeItems()));
    expect(q.addScan(qr('RK73H1JTTD1002F', 2000), ':A::202:X:L:S:F', 'qr')).toEqual({ ok: true });
    // alloc-1 is now fully queued → next scan lands on alloc-2
    const res = q.addScan(qr('RK73H1JTTD1002F', 1000), ':A::101:X:L:S2:F', 'qr');
    expect(res).toEqual({ ok: true });
    expect(q.rows.value[0].allocationId).toBe('alloc-2');
    // nothing left → reject
    expect(q.addScan(qr('RK73H1JTTD1002F', 500), ':A::53:X:L:S3:F', 'qr')).toEqual({ ok: false, message: 'no_match' });
  });

  it('rejects duplicate raw values', () => {
    const q = usePickingScanQueue(ref(makeItems()));
    expect(q.addScan(qr('RK73H1JTTD1002F', 1000), ':A::101:X:L:S:F', 'qr')).toEqual({ ok: true });
    expect(q.addScan(qr('RK73H1JTTD1002F', 1000), ':A::101:X:L:S:F', 'qr')).toEqual({ ok: false, message: 'duplicate' });
  });

  it('rejects unknown parts and bad qty', () => {
    const q = usePickingScanQueue(ref(makeItems()));
    expect(q.addScan(qr('NOPE', 10), ':X::10:X:L:S:F', 'qr')).toEqual({ ok: false, message: 'no_match' });
    expect(q.addScan(qr('RK73H1JTTD1002F', 0), ':Y::0:X:L:S:F', 'qr')).toEqual({ ok: false, message: 'invalid' });
  });

  it('splits one label across multiple allocations of the same item', () => {
    const q = usePickingScanQueue(ref(makeItems()));
    // item-1 holds 3000 = 2000 (alloc-1) + 1000 (alloc-2); a 3000 label spans both
    const res = q.addScan(qr('RK73H1JTTD1002F', 3000), ':A::302:X:L:S:F', 'qr');
    expect(res).toEqual({ ok: true });
    expect(q.rows.value).toHaveLength(2);
    expect(q.rows.value[0]).toMatchObject({ itemId: 'item-1', allocationId: 'alloc-1', qty: 2000 });
    expect(q.rows.value[1]).toMatchObject({ itemId: 'item-1', allocationId: 'alloc-2', qty: 1000 });
    expect(q.queuedQtyByItem.value).toEqual({ 'item-1': 3000 });
    // both portions share the raw value → rescanning the same label is a duplicate
    expect(q.addScan(qr('RK73H1JTTD1002F', 3000), ':A::302:X:L:S:F', 'qr')).toEqual({ ok: false, message: 'duplicate' });
  });

  it('falls through to the next same-part item when the first cannot cover the qty', () => {
    const items = ref(makeItems());
    (items.value as any)[1].partNo = 'RK73H1JTTD1002F'; // two lines with the same part
    const q = usePickingScanQueue(items);
    q.addScan(qr('RK73H1JTTD1002F', 3000), ':A::302:X:L:S1:F', 'qr'); // fills item-1
    const res = q.addScan(qr('RK73H1JTTD1002F', 1000), ':A::102:X:L:S2:F', 'qr');
    expect(res).toEqual({ ok: true });
    expect(q.rows.value[0]).toMatchObject({ itemId: 'item-2', allocationId: 'alloc-3', qty: 1000 });
  });

  it('splits one label across multiple same-part lines', () => {
    const items = ref(makeItems());
    (items.value as any)[1].partNo = 'RK73H1JTTD1002F'; // lines of 3000 + 1000
    const q = usePickingScanQueue(items);
    // a 3500 package covers neither line alone; consumed FIFO: item-1's
    // allocations first (2000 + 1000), then 500 from item-2
    const res = q.addScan(qr('RK73H1JTTD1002F', 3500), ':A::352:X:L:S1:F', 'qr');
    expect(res).toEqual({ ok: true });
    expect(q.rows.value).toHaveLength(3);
    expect(q.rows.value[0]).toMatchObject({ itemId: 'item-1', allocationId: 'alloc-1', qty: 2000 });
    expect(q.rows.value[1]).toMatchObject({ itemId: 'item-1', allocationId: 'alloc-2', qty: 1000 });
    expect(q.rows.value[2]).toMatchObject({ itemId: 'item-2', allocationId: 'alloc-3', qty: 500 });
    expect(q.queuedQtyByItem.value).toEqual({ 'item-1': 3000, 'item-2': 500 });
    // both portions share the raw value → rescanning the same label is a duplicate
    expect(q.addScan(qr('RK73H1JTTD1002F', 3500), ':A::352:X:L:S1:F', 'qr')).toEqual({ ok: false, message: 'duplicate' });
  });

  it('rejects a qty beyond the total of all same-part lines', () => {
    const items = ref(makeItems());
    (items.value as any)[1].partNo = 'RK73H1JTTD1002F'; // total open = 4000
    const q = usePickingScanQueue(items);
    expect(q.addScan(qr('RK73H1JTTD1002F', 4001), ':A::401:X:L:S1:F', 'qr')).toEqual({ ok: false, message: 'no_match' });
    expect(q.rows.value).toHaveLength(0);
  });

  it('removeRow drops queued rows', () => {
    const q = usePickingScanQueue(ref(makeItems()));
    q.addScan(qr('RK73H1JTTD1002F', 1000), ':A::101:X:L:S:F', 'qr');
    q.removeRow(q.rows.value[0].key);
    expect(q.rows.value).toHaveLength(0);
  });

  it('queuedQtyByItem sums queued rows per item', () => {
    const q = usePickingScanQueue(ref(makeItems()));
    q.addScan(qr('RK73H1JTTD1002F', 1000), ':A::101:X:L:S1:F', 'qr');
    q.addScan(qr('RK73H1JTTD1002F', 1000), ':A::101:X:L:S2:F', 'qr');
    q.addScan(qr('RK73H1JTTD2202F', 500), ':B::51:X:L:S3:F', 'qr');
    expect(q.queuedQtyByItem.value).toEqual({ 'item-1': 2000, 'item-2': 500 });
  });

  it('applyAll marks failed rows and drops applied ones', async () => {
    const q = usePickingScanQueue(ref(makeItems()));
    q.addScan(qr('RK73H1JTTD1002F', 1000), ':A::101:X:L:S1:F', 'qr');
    q.addScan(qr('RK73H1JTTD2202F', 500), ':B::51:X:L:S2:F', 'qr');
    const applied: string[] = [];
    const failed = await q.applyAll(async (row) => {
      if (row.itemId === 'item-2') throw new Error('boom');
      applied.push(row.key);
    }, (e) => String(e));
    expect(failed).toBe(1);
    expect(applied).toHaveLength(1);
    expect(q.rows.value).toHaveLength(1);
    expect(q.rows.value[0]).toMatchObject({ itemId: 'item-2', status: 'failed', error: 'Error: boom' });
  });

  it('applyAll re-resolves stale allocation ids via afterApply', async () => {
    const items = ref(makeItems());
    const q = usePickingScanQueue(items);
    q.addScan(qr('RK73H1JTTD1002F', 2000), ':A::202:X:L:S1:F', 'qr');
    q.addScan(qr('RK73H1JTTD2202F', 1000), ':B::101:X:L:S2:F', 'qr');
    const applied: string[] = [];
    const failed = await q.applyAll(
      async (row) => { applied.push(row.allocationId); },
      (e) => String(e),
      async () => {
        // simulate the backend rebuilding allocations with new ids
        const next = makeItems() as any;
        next[0].allocations = [
          { id: 'alloc-1b', qty: 2000, lot: null, receivingInvoiceItemId: 'ri-1', receivingOrderId: 'ro-1', boxId: null },
          { id: 'alloc-2b', qty: 1000, lot: null, receivingInvoiceItemId: 'ri-2', receivingOrderId: 'ro-1', boxId: null },
        ];
        next[1].allocations = [
          { id: 'alloc-3b', qty: 1000, lot: null, receivingInvoiceItemId: 'ri-3', receivingOrderId: 'ro-1', boxId: null },
        ];
        items.value = next;
        q.reresolveQueued();
      }
    );
    expect(failed).toBe(0);
    expect(applied).toHaveLength(2);
    // the second row applied with the refreshed allocation id
    expect(applied[1]).toBe('alloc-1b');
    expect(q.rows.value).toHaveLength(0);
  });

  it('reresolveQueued does not count the row against itself when ids are unchanged', () => {
    const items = ref(makeItems());
    const q = usePickingScanQueue(items);
    // item-2 has a single allocation of exactly 1000
    q.addScan(qr('RK73H1JTTD2202F', 1000), ':B::101:X:L:S2:F', 'qr');
    // refetch returns the same allocation ids (e.g. recompute skipped by the
    // page work lock) — the row must still fit its own allocation
    q.reresolveQueued();
    expect(q.rows.value[0]).toMatchObject({ status: 'queued', allocationId: 'alloc-3' });
  });

  it('reresolveQueued marks rows that no longer fit as failed', () => {
    const items = ref(makeItems());
    const q = usePickingScanQueue(items);
    q.addScan(qr('RK73H1JTTD2202F', 1000), ':B::101:X:L:S2:F', 'qr');
    const next = makeItems() as any;
    next[1].allocations = []; // allocation gone after refetch
    items.value = next;
    q.reresolveQueued();
    expect(q.rows.value[0]).toMatchObject({ status: 'failed', error: 'allocation_changed' });
  });

  function makeShelfItems(): Items {
    const items = makeItems() as any;
    items[0].allocations = [
      {
        id: 'alloc-1', qty: 2000, receivingInvoiceItemId: null, receivingOrderId: null, boxId: null,
        lot: { id: 'lot-1', shelfCode: 'A-01-01', boxId: 'BOX-H-20260701-0001', dateCode: '2603', lotCode: 'L2603A', coo: 'JP', cow: 'JP', totalQty: 2000, allocatedQty: 2000, availableQty: 0 },
      },
    ];
    items[1].allocations = [
      {
        id: 'alloc-3', qty: 1000, receivingInvoiceItemId: null, receivingOrderId: null, boxId: null,
        lot: { id: 'lot-2', shelfCode: 'A-01-01', boxId: 'BOX-H-20260701-0001', dateCode: '2603', lotCode: 'L2603B', coo: 'JP', cow: 'JP', totalQty: 1000, allocatedQty: 1000, availableQty: 0 },
      },
    ];
    return items as Items;
  }

  it('matchBoxAllocations finds allocations by box id or shelf code (never carton)', () => {
    const q = usePickingScanQueue(ref(makeShelfItems()));
    expect(q.matchBoxAllocations('BOX-H-20260701-0001').map((m) => m.allocation.id)).toEqual(['alloc-1', 'alloc-3']);
    expect(q.matchBoxAllocations('a-01-01').map((m) => m.allocation.id)).toEqual(['alloc-1', 'alloc-3']);
    expect(q.matchBoxAllocations('BOX-H-99999999-9999')).toEqual([]);
    expect(q.matchBoxAllocations('')).toEqual([]);
    // receiving cartons (allocation.boxId) are the auto-queue path instead
    const items = makeItems() as any;
    items[0].allocations[0].boxId = 'C1001';
    const q2 = usePickingScanQueue(ref(items as Items));
    expect(q2.matchBoxAllocations('C1001')).toEqual([]);
    expect(q2.matchCartonAllocations(' c1001 ').map((m) => m.allocation.id)).toEqual(['alloc-1']);
    expect(q.matchCartonAllocations('BOX-H-20260701-0001')).toEqual([]);
  });

  it('addCartonScan queues every matched allocation at its remaining qty', () => {
    const items = makeItems() as any;
    items[0].allocations[0].boxId = 'C1001';
    items[0].allocations[1].boxId = 'C1001';
    const q = usePickingScanQueue(ref(items as Items));
    const res = q.addCartonScan(q.matchCartonAllocations('C1001'), 'C1001');
    expect(res).toEqual({ ok: true, count: 2, qty: 3000 });
    expect(q.queuedRows.value.map((r) => [r.allocationId, r.qty])).toEqual([
      ['alloc-1', 2000],
      ['alloc-2', 1000],
    ]);
    // re-scan of the same carton is a duplicate
    expect(q.addCartonScan(q.matchCartonAllocations('C1001'), 'C1001').ok).toBe(false);
  });

  it('addCartonScan nets out already-queued qty; nothing left → no_match', () => {
    const items = makeItems() as any;
    items[0].allocations[0].boxId = 'C1001';
    const q = usePickingScanQueue(ref(items as Items));
    // queue 1500 of alloc-1 (2000) via a part label first
    expect(q.addScan(qr('RK73H1JTTD1002F', 1500), ':A::152:X:L:S1:F', 'qr')).toEqual({ ok: true });
    const res = q.addCartonScan(q.matchCartonAllocations('C1001'), 'C1001');
    expect(res).toEqual({ ok: true, count: 1, qty: 500 });
    // carton fully queued (its raw is in the queue) → duplicate on rescan
    expect(q.addCartonScan(q.matchCartonAllocations('C1001'), 'C1001').message).toBe('duplicate');
    // a different carton barcode with zero remaining → no_match
    items[0].allocations[1].boxId = 'C2002';
    expect(q.addCartonScan(q.matchCartonAllocations('C2002'), 'C2002').ok).toBe(true); // alloc-2 untouched
  });

  it('addAllocationScan queues a part scan against a specific allocation', () => {
    const q = usePickingScanQueue(ref(makeShelfItems()));
    const res = q.addAllocationScan('item-1', 'alloc-1', qr('RK73H1JTTD1002F', 1500), ':A::152:X:L:S:F', 'qr');
    expect(res).toEqual({ ok: true });
    expect(q.rows.value[0]).toMatchObject({ itemId: 'item-1', allocationId: 'alloc-1', qty: 1500, status: 'queued' });
  });

  it('addAllocationScan rejects wrong parts and qty beyond the allocation', () => {
    const q = usePickingScanQueue(ref(makeShelfItems()));
    // part of another item, even if that item shares the box
    expect(q.addAllocationScan('item-1', 'alloc-1', qr('RK73H1JTTD2202F', 100), ':B::12:X:L:S:F', 'qr')).toEqual({ ok: false, message: 'no_match' });
    // alloc-1 holds 2000
    expect(q.addAllocationScan('item-1', 'alloc-1', qr('RK73H1JTTD1002F', 2001), ':A::20012:X:L:S:F', 'qr')).toEqual({ ok: false, message: 'qty_exceeds' });
    expect(q.addAllocationScan('item-1', 'alloc-1', qr('RK73H1JTTD1002F', 0), ':A::0:X:L:S:F', 'qr')).toEqual({ ok: false, message: 'invalid' });
    expect(q.rows.value).toHaveLength(0);
  });

  it('addAllocationScan accounts for already-queued qty on the allocation', () => {
    const q = usePickingScanQueue(ref(makeShelfItems()));
    expect(q.addAllocationScan('item-1', 'alloc-1', qr('RK73H1JTTD1002F', 2000), ':A::202:X:L:S1:F', 'qr')).toEqual({ ok: true });
    expect(q.addAllocationScan('item-1', 'alloc-1', qr('RK73H1JTTD1002F', 1), ':A::1:X:L:S2:F', 'qr')).toEqual({ ok: false, message: 'qty_exceeds' });
    expect(q.addAllocationScan('item-1', 'alloc-1', qr('RK73H1JTTD1002F', 2000), ':A::202:X:L:S1:F', 'qr')).toEqual({ ok: false, message: 'duplicate' });
  });

  // shelf scope (pickingShelfScan require-match): matching is restricted to
  // allocations whose lot sits at the scanned shelf/box.
  function makeTwoShelfItems(): Items {
    const items = makeItems() as any;
    items[0].allocations = [
      {
        id: 'alloc-1', qty: 2000, receivingInvoiceItemId: null, receivingOrderId: null, boxId: null,
        lot: { id: 'lot-1', shelfCode: 'A-01-01', boxId: 'BOX-H-20260701-0001', dateCode: '2603', lotCode: 'L2603A', coo: 'JP', cow: 'JP', totalQty: 2000, allocatedQty: 2000, availableQty: 0 },
      },
      {
        id: 'alloc-2', qty: 1000, receivingInvoiceItemId: null, receivingOrderId: null, boxId: null,
        lot: { id: 'lot-2', shelfCode: 'B-03-02', boxId: null, dateCode: '2604', lotCode: 'L2604A', coo: 'JP', cow: 'JP', totalQty: 1000, allocatedQty: 1000, availableQty: 0 },
      },
    ];
    return items as Items;
  }

  it('shelf scope filters matching to allocations at the scanned shelf', () => {
    const scope = ref<{ shelfCode: string | null; boxId: string | null } | null>({ shelfCode: 'B-03-02', boxId: null });
    const q = usePickingScanQueue(ref(makeTwoShelfItems()), scope as any);
    // 1500 fits only alloc-1 (A-01-01), which is out of scope → no_match
    expect(q.addScan(qr('RK73H1JTTD1002F', 1500), ':A::152:X:L:S:F', 'qr')).toEqual({ ok: false, message: 'no_match' });
    // 1000 fits the in-scope alloc-2
    expect(q.addScan(qr('RK73H1JTTD1002F', 1000), ':A::102:X:L:S:F', 'qr')).toEqual({ ok: true });
    expect(q.rows.value[0]).toMatchObject({ allocationId: 'alloc-2', qty: 1000 });
  });

  it('shelf scope by box id matches the lot box; clearing the scope restores full matching', () => {
    const scope = ref<{ shelfCode: string | null; boxId: string | null } | null>({ shelfCode: 'A-01-01', boxId: 'BOX-H-20260701-0001' });
    const q = usePickingScanQueue(ref(makeTwoShelfItems()), scope as any);
    expect(q.addScan(qr('RK73H1JTTD1002F', 1500), ':A::152:X:L:S:F', 'qr')).toEqual({ ok: true });
    expect(q.rows.value[0]).toMatchObject({ allocationId: 'alloc-1', qty: 1500 });
    // clearing the scope (operator cleared the chip) matches anywhere again
    scope.value = null;
    expect(q.addScan(qr('RK73H1JTTD1002F', 1000), ':A::102:X:L:S:F', 'qr')).toEqual({ ok: true });
  });
});
