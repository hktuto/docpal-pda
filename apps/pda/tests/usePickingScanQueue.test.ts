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

  it('rejects re-scanning a label that already applied (auto-apply drops applied rows)', async () => {
    const q = usePickingScanQueue(ref(makeItems()));
    expect(q.addScan(qr('RK73H1JTTD1002F', 1000), ':A::101:X:L:S1:F', 'qr')).toEqual({ ok: true });
    await q.applyAll(async () => {}, (e) => String(e));
    expect(q.rows.value).toHaveLength(0); // applied rows are dropped
    // The unified page auto-applies on every scan — without a session-level
    // memory the second scan of the same label would queue again (double-pick)
    // or fall through to no_match instead of reporting the duplicate.
    expect(q.addScan(qr('RK73H1JTTD1002F', 1000), ':A::101:X:L:S1:F', 'qr')).toEqual({ ok: false, message: 'duplicate' });
    // a FAILED apply does not consume the raw — the operator may re-scan after fixing
    const q2 = usePickingScanQueue(ref(makeItems()));
    q2.addScan(qr('RK73H1JTTD1002F', 1000), ':A::101:X:L:S1:F', 'qr');
    await q2.applyAll(async () => { throw new Error('boom'); }, (e) => String(e));
    q2.removeRow(q2.rows.value[0].key);
    expect(q2.addScan(qr('RK73H1JTTD1002F', 1000), ':A::101:X:L:S1:F', 'qr')).toEqual({ ok: true });
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

  it('applyAll drains rows queued while it is running', async () => {
    const q = usePickingScanQueue(ref(makeItems()));
    q.addScan(qr('RK73H1JTTD1002F', 1000), ':A::101:X:L:S1:F', 'qr');
    const applied: string[] = [];
    const failed = await q.applyAll(async (row) => {
      applied.push(row.key);
      if (applied.length === 1) {
        // a new scan arrives mid-drain (unified page auto-apply) — the same
        // run must pick it up, exactly once
        q.addScan(qr('RK73H1JTTD1002F', 500), ':A::51:X:L:S3:F', 'qr');
      }
    }, (e) => String(e));
    expect(failed).toBe(0);
    expect(applied).toHaveLength(2);
    expect(new Set(applied).size).toBe(2);
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
        lot: { id: 'lot-1', shelfCode: 'A-01-01', boxId: 'BOX-H-20260701-0001', dateCode: '2603', lotCode: 'L2607', coo: 'JP', cow: 'JP', totalQty: 2000, allocatedQty: 2000, availableQty: 0 },
      },
    ];
    items[1].allocations = [
      {
        id: 'alloc-3', qty: 1000, receivingInvoiceItemId: null, receivingOrderId: null, boxId: null,
        lot: { id: 'lot-2', shelfCode: 'A-01-01', boxId: 'BOX-H-20260701-0001', dateCode: '2603', lotCode: 'L2607', coo: 'JP', cow: 'JP', totalQty: 1000, allocatedQty: 1000, availableQty: 0 },
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

  it('addCartonScan stores the lot date code in the label format for display + posting', () => {
    const items = makeShelfItems() as any;
    items[0].allocations[0].boxId = 'C1001';
    // default "wwyy": canonical YYWW '2603' → label WWYY '0326'
    const q = usePickingScanQueue(ref(items as Items));
    q.addCartonScan(q.matchCartonAllocations('C1001'), 'C1001');
    expect(q.rows.value[0].dateCode).toBe('0326');
    // "yyww": canonical passes through unchanged
    const q2 = usePickingScanQueue(ref(items as Items), { dateCodeFormat: ref('yyww' as const) });
    q2.addCartonScan(q2.matchCartonAllocations('C1001'), 'C1001');
    expect(q2.rows.value[0].dateCode).toBe('2603');
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

  // --- 2026-10-14 batch-field validation (spec 2026-10-14) -----------------

  const qrFull = (partNo: string, qty: number, fields: { dateCode?: string; lotCode?: string; coo?: string; cow?: string }) =>
    ({ partNo, qty, dateCode: '', lotCode: '', coo: '', cow: '', ...fields });

  it('records the scanned batch fields on queued rows (NULL for carton scans)', () => {
    const q = usePickingScanQueue(ref(makeShelfItems()));
    // label "0326" (wwyy, wk03 2026) → canonical "2603" = the lot's code → accepted
    q.addAllocationScan('item-1', 'alloc-1', qrFull('RK73H1JTTD1002F', 100, { dateCode: '0326', lotCode: 'L2607', coo: 'jp' }), ':A::102:X:L:S:F', 'qr');
    expect(q.rows.value[0]).toMatchObject({
      scannedDateCode: '0326',
      scannedLotCode: 'L2607',
      scannedCoo: 'jp',
      scannedCow: null,
    });
    const items = makeItems() as any;
    items[0].allocations[0].boxId = 'C1001';
    const q2 = usePickingScanQueue(ref(items as Items));
    q2.addCartonScan(q2.matchCartonAllocations('C1001'), 'C1001');
    expect(q2.rows.value[0]).toMatchObject({
      scannedDateCode: null,
      scannedLotCode: null,
      scannedCoo: null,
      scannedCow: null,
    });
  });

  it('hard-rejects a lot code that differs from the source lot (2026-10-14)', () => {
    const q = usePickingScanQueue(ref(makeShelfItems()));
    // source lot carries L2607 — a different label lot code is rejected
    expect(q.addAllocationScan('item-1', 'alloc-1', qrFull('RK73H1JTTD1002F', 100, { lotCode: 'L9999' }), ':A::102:X:L:S1:F', 'qr'))
      .toEqual({ ok: false, message: 'lot_code_mismatch', params: { scanned: 'L9999', expected: '12607' } });
    // a label without a lot code cannot confirm the reel either
    const missing = q.addAllocationScan('item-1', 'alloc-1', qrFull('RK73H1JTTD1002F', 100, {}), ':A::102:X:L:S2:F', 'qr');
    expect(missing).toMatchObject({ ok: false, message: 'lot_code_mismatch' });
    expect(missing.params?.scanned).toBe('—');
    // OCR-substitution tolerant: "I" reads as "1" on both sides
    expect(q.addAllocationScan('item-1', 'alloc-1', qrFull('RK73H1JTTD1002F', 100, { lotCode: 'I2607' }), ':A::102:X:L:S3:F', 'qr')).toEqual({ ok: true });
    expect(q.rows.value).toHaveLength(1);
  });

  it('accepts the date code when equal or earlier than the source, rejects newer', () => {
    const q = usePickingScanQueue(ref(makeShelfItems()));
    const items = makeShelfItems() as any;
    items[0].allocations[0].lot.dateCode = '2626'; // canonical YYWW = week 26 of 2026
    const q2 = usePickingScanQueue(ref(items as Items));
    const okScan = (dateCode: string) => qrFull('RK73H1JTTD1002F', 100, { dateCode, lotCode: 'L2607' });
    expect(q2.addAllocationScan('item-1', 'alloc-1', okScan('2626'), ':A::102:X:L:S1:F', 'qr')).toEqual({ ok: true });
    expect(q2.addAllocationScan('item-1', 'alloc-1', okScan('2526'), ':A::102:X:L:S2:F', 'qr')).toEqual({ ok: true });
    expect(q2.addAllocationScan('item-1', 'alloc-1', okScan('5225'), ':A::102:X:L:S3:F', 'qr')).toEqual({ ok: true }); // year boundary: w52 2025 < w26 2026
    const newer = q2.addAllocationScan('item-1', 'alloc-1', okScan('0127'), ':A::102:X:L:S4:F', 'qr');
    expect(newer).toEqual({ ok: false, message: 'date_code_newer', params: { scanned: '0127', expected: '2626' } });
    // unparseable label format never blocks
    expect(q2.addAllocationScan('item-1', 'alloc-1', okScan('26-27'), ':A::102:X:L:S5:F', 'qr')).toEqual({ ok: true });
    expect(q2.rows.value).toHaveLength(4);
  });

  it('checks the date code against receiving-area sources too', () => {
    const items = makeItems() as any;
    items[0].allocations[0].receiving = { orderId: 'ro-1', batchNo: 'B1', invoiceNo: 'INV1', partNo: 'RK73H1JTTD1002F', poNo: 'PO1', receivedQty: 2000, dateCode: '2626' };
    const q = usePickingScanQueue(ref(items as Items));
    expect(q.addScan(qrFull('RK73H1JTTD1002F', 100, { dateCode: '2726' }), ':A::102:X:L:S1:F', 'qr'))
      .toEqual({ ok: false, message: 'date_code_newer', params: { scanned: '2726', expected: '2626' } });
    expect(q.addScan(qrFull('RK73H1JTTD1002F', 100, { dateCode: '2626' }), ':A::102:X:L:S2:F', 'qr')).toEqual({ ok: true });
  });

  // --- 2026-10-22 dateCodeFormat: label scan vs canonical sources ----------

  it('canonicalizes a WWYY label scan before comparing to a canonical lot (default wwyy)', () => {
    const items = makeShelfItems() as any;
    items[0].allocations[0].lot.dateCode = '2637'; // canonical YYWW = wk37 of 2026
    const q = usePickingScanQueue(ref(items as Items));
    const scan = (dateCode: string, raw: string) =>
      q.addAllocationScan('item-1', 'alloc-1', qrFull('RK73H1JTTD1002F', 100, { dateCode, lotCode: 'L2607' }), raw, 'qr');
    expect(scan('3726', ':A::102:X:L:S1:F')).toEqual({ ok: true }); // label WWYY wk37 2026 = canonical 2637
    expect(scan('3626', ':A::102:X:L:S2:F')).toEqual({ ok: true }); // wk36 2026 → earlier
    expect(scan('3826', ':A::102:X:L:S3:F'))
      .toEqual({ ok: false, message: 'date_code_newer', params: { scanned: '3826', expected: '2637' } });
    // the queued rows keep the label-format values (the backend canonicalizes the body)
    expect(q.rows.value.map((r) => r.scannedDateCode)).toEqual(['3626', '3726']);
  });

  it('passes the label scan through unchanged when dateCodeFormat is "yyww"', () => {
    const items = makeShelfItems() as any;
    items[0].allocations[0].lot.dateCode = '2637'; // lots are always canonical
    const q = usePickingScanQueue(ref(items as Items), { dateCodeFormat: ref('yyww') });
    const scan = (dateCode: string, raw: string) =>
      q.addAllocationScan('item-1', 'alloc-1', qrFull('RK73H1JTTD1002F', 100, { dateCode, lotCode: 'L2607' }), raw, 'qr');
    expect(scan('2637', ':A::102:X:L:S1:F')).toEqual({ ok: true }); // yyww label already canonical
    expect(scan('2636', ':A::102:X:L:S2:F')).toEqual({ ok: true }); // earlier
    expect(scan('2638', ':A::102:X:L:S3:F'))
      .toEqual({ ok: false, message: 'date_code_newer', params: { scanned: '2638', expected: '2637' } });
  });

  it('canonicalizes the receiving-area source (enclave label format) before comparing', () => {
    const items = makeItems() as any;
    items[0].allocations[0].receiving = { orderId: 'ro-1', batchNo: 'B1', invoiceNo: 'INV1', partNo: 'RK73H1JTTD1002F', poNo: 'PO1', receivedQty: 2000, dateCode: '3726' }; // label WWYY = wk37 2026
    const q = usePickingScanQueue(ref(items as Items));
    expect(q.addScan(qrFull('RK73H1JTTD1002F', 100, { dateCode: '3726' }), ':A::102:X:L:S1:F', 'qr')).toEqual({ ok: true });
    expect(q.addScan(qrFull('RK73H1JTTD1002F', 100, { dateCode: '3826' }), ':A::102:X:L:S2:F', 'qr'))
      .toEqual({ ok: false, message: 'date_code_newer', params: { scanned: '3826', expected: '2637' } });
  });

  it('addScan applies the same batch checks to every portion of a spanning label', () => {
    const items = makeShelfItems() as any;
    items[1].partNo = 'RK73H1JTTD1002F'; // one part across two lines → a label can span both
    // second lot carries a different lot code — the spanning label must be rejected
    items[1].allocations[0].lot.lotCode = 'L8888';
    const q = usePickingScanQueue(ref(items as Items));
    // item-1 (2000) + item-2 (1000) = 3000; the label covers both, item-2's lot mismatches
    expect(q.addScan(qr('RK73H1JTTD1002F', 3000), ':A::302:X:L:S1:F', 'qr'))
      .toMatchObject({ ok: false, message: 'lot_code_mismatch' });
    expect(q.rows.value).toHaveLength(0);
  });
});
