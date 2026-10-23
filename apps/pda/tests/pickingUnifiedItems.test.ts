import { describe, it, expect } from 'vitest';
import {
  allocationChipLabel,
  pendingScanGroups,
  unifiedCollapsedMeta,
  type UnifiedAllocation,
} from '../utils/pickingUnifiedItems';
import type { ScanQueueRow } from '../composables/usePickingScanQueue';
import type { PickingOrderDetail } from '../services/types';

// Identity translate — assertions check structure, not copy.
const t = (key: string) => key;

const lot = (over: Partial<NonNullable<UnifiedAllocation['lot']>> = {}) => ({
  lotCode: null,
  shelfCode: null,
  dateCode: null,
  coo: null,
  cow: null,
  ...over,
});

const alloc = (a: Partial<UnifiedAllocation>): UnifiedAllocation => ({
  lot: null,
  boxId: null,
  qty: 0,
  ...a,
});

function metaArgs(over: Partial<Parameters<typeof unifiedCollapsedMeta>[0]> = {}) {
  return {
    scannedQty: 2000,
    qty: 3000,
    queuedQty: 0,
    actionable: true,
    collapsedStyle: 'allocations' as const,
    itemFields: ['wcl_item_no', 'qty', 'picked_qty'],
    allocations: [],
    ...over,
  };
}

describe('unifiedCollapsedMeta', () => {
  it('renders the compact progress pair', () => {
    expect(unifiedCollapsedMeta(metaArgs(), t)).toBe('2K/3K');
  });

  it('appends the pending segment when the queue holds rows for the part', () => {
    expect(unifiedCollapsedMeta(metaArgs({ queuedQty: 1000 }), t)).toBe(
      '2K/3K (+1K picking.unified.pending)'
    );
  });

  it('renders allocation chips in parentheses after the required qty', () => {
    const meta = unifiedCollapsedMeta(
      metaArgs({
        allocations: [
          alloc({ qty: 1000, lot: lot({ lotCode: 'SZA01', dateCode: '2626', coo: 'CN', cow: 'CN' }) }),
          alloc({ qty: 2000, lot: lot({ lotCode: 'SZB02A', dateCode: '2631', coo: 'CN', cow: null }) }),
        ],
      }),
      t
    );
    expect(meta).toBe('2K/3K · 3K(1K SZA01-2626-CN-CN, 2K SZB02A-3126-CN)');
  });

  it('converts the chip date code to the label format (canonical YYWW → WWYY)', () => {
    const meta = unifiedCollapsedMeta(
      metaArgs({
        dateCodeFormat: 'wwyy',
        allocations: [alloc({ qty: 3000, lot: lot({ dateCode: '2637' }) })],
      }),
      t
    );
    expect(meta).toBe('2K/3K · 3K(3K 3726)');
  });

  it('passes the chip date code through when dateCodeFormat is "yyww"', () => {
    const meta = unifiedCollapsedMeta(
      metaArgs({
        dateCodeFormat: 'yyww',
        allocations: [alloc({ qty: 3000, lot: lot({ dateCode: '2637' }) })],
      }),
      t
    );
    expect(meta).toBe('2K/3K · 3K(3K 2637)');
  });

  it('skips empty batch fields in the chip label', () => {
    const a = alloc({ qty: 500, lot: lot({ dateCode: '2626' }) });
    const meta = unifiedCollapsedMeta(metaArgs({ allocations: [a] }), t);
    expect(meta).toBe('2K/3K · 3K(500 2626)');
  });

  it('renders carton allocations as CTN <boxId> and receiving-area allocations as the area label', () => {
    const meta = unifiedCollapsedMeta(
      metaArgs({
        allocations: [
          alloc({ qty: 1000, boxId: 'CTN-9' }),
          alloc({ qty: 2000 }),
        ],
      }),
      t
    );
    expect(meta).toBe('2K/3K · 3K(1K CTN CTN-9, 2K picking.itemsSection.receivingArea)');
  });

  it('hides allocation chips when the group is fully scanned', () => {
    const a = alloc({ qty: 3000, lot: lot({ lotCode: 'L1' }) });
    const meta = unifiedCollapsedMeta(metaArgs({ scannedQty: 3000, allocations: [a] }), t);
    expect(meta).toBe('3K/3K');
  });

  it('hides allocation chips when the order is not actionable', () => {
    const a = alloc({ qty: 3000, lot: lot({ lotCode: 'L1' }) });
    const meta = unifiedCollapsedMeta(metaArgs({ actionable: false, allocations: [a] }), t);
    expect(meta).toBe('2K/3K');
  });

  it('renders the fields style from itemFields (pre-2026-10-12 behavior)', () => {
    const meta = unifiedCollapsedMeta(
      metaArgs({ collapsedStyle: 'fields', scannedQty: 2000, allocations: [alloc({ qty: 3000 })] }),
      t
    );
    expect(meta).toBe(
      'picking.itemsSection.requiredQty: 3000 · picking.itemsSection.scannedQty: 2000'
    );
  });

  it('renders the fields style with allocated_qty when configured', () => {
    const meta = unifiedCollapsedMeta(
      metaArgs({
        collapsedStyle: 'fields',
        itemFields: ['allocated_qty'],
        allocations: [alloc({ qty: 3000 })],
      }),
      t
    );
    expect(meta).toBe('picking.itemsSection.allocatedQty: 3000');
  });
});

describe('allocationChipLabel', () => {
  it('joins lot batch fields with dashes, skipping empties', () => {
    expect(
      allocationChipLabel(alloc({ lot: lot({ lotCode: 'SZA01', dateCode: '2626', coo: 'CN', cow: 'CN' }) }), t)
    ).toBe('SZA01-2626-CN-CN');
    expect(allocationChipLabel(alloc({ lot: lot({ lotCode: 'L1' }) }), t)).toBe('L1');
  });

  it('includes the shelf code after the lot code when present', () => {
    expect(
      allocationChipLabel(alloc({ lot: lot({ lotCode: 'SZA01', shelfCode: 'A-01', dateCode: '2626' }) }), t)
    ).toBe('SZA01-A-01-2626');
  });

  it('converts the lot date code to the label format (default "wwyy")', () => {
    expect(
      allocationChipLabel(alloc({ lot: lot({ lotCode: 'SZA01', dateCode: '2637' }) }), t)
    ).toBe('SZA01-3726');
    expect(
      allocationChipLabel(alloc({ lot: lot({ lotCode: 'SZA01', dateCode: '2637' }) }), t, 'yyww')
    ).toBe('SZA01-2637');
  });

  it('renders carton sources as CTN <boxId>', () => {
    expect(allocationChipLabel(alloc({ boxId: 'CTN-9' }), t)).toBe('CTN CTN-9');
  });

  it('renders receiving-area sources as the area label', () => {
    expect(allocationChipLabel(alloc({}), t)).toBe('picking.itemsSection.receivingArea');
  });
});

function queueRow(over: Partial<ScanQueueRow>): ScanQueueRow {
  return {
    key: 'row-1',
    itemId: 'item-1',
    allocationId: 'alloc-1',
    partNo: 'PART-1',
    scannedPartNo: 'PART-1',
    scannedWclItemNo: null,
    qty: 1000,
    dateCode: null,
    lotCode: null,
    coo: null,
    cow: null,
    raw: ':A::1:X:L:S:F',
    source: 'qr',
    status: 'queued',
    error: null,
    ...over,
  };
}

const item = (id: string): PickingOrderDetail['items'][number] =>
  ({ id, partNo: 'PART-1', packages: [] }) as unknown as PickingOrderDetail['items'][number];

describe('pendingScanGroups', () => {
  it('aggregates rows of the same part + batch into one line', () => {
    const groups = pendingScanGroups([item('item-1')], [
      queueRow({ key: 'row-1', qty: 1000, lotCode: 'L1', dateCode: '2626' }),
      queueRow({ key: 'row-2', qty: 2000, lotCode: 'L1', dateCode: '2626' }),
      queueRow({ key: 'row-3', qty: 500, lotCode: 'L2', dateCode: '2631' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ keys: ['row-1', 'row-2'], qty: 3000, lotCode: 'L1', dateCode: '2626' });
    expect(groups[1]).toMatchObject({ keys: ['row-3'], qty: 500, lotCode: 'L2' });
  });

  it('marks the mixed source when QR and OCR rows aggregate together', () => {
    const groups = pendingScanGroups([item('item-1')], [
      queueRow({ key: 'row-1', source: 'qr' }),
      queueRow({ key: 'row-2', source: 'ocr' }),
    ]);
    expect(groups[0].source).toBe('mixed');
  });

  it('keeps a failed row failed with its error', () => {
    const groups = pendingScanGroups([item('item-1')], [
      queueRow({ key: 'row-1', status: 'failed', error: 'boom' }),
    ]);
    expect(groups[0]).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('filters out rows of other parts', () => {
    const groups = pendingScanGroups([item('item-1')], [
      queueRow({ key: 'row-1', itemId: 'item-1' }),
      queueRow({ key: 'row-2', itemId: 'item-2' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].keys).toEqual(['row-1']);
  });
});
