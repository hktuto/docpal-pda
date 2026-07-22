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
});
