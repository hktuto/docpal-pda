import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PDA_VIEW_CONFIG,
  PDA_LIST_CHIP_FIELDS,
  PDA_DETAIL_FIELDS,
  defaultPdaViewConfig,
  viewListRow,
  viewListChip,
  receivingItemFieldValue,
  putAwayItemFieldValue,
} from '../utils/viewConfig';

const receivingRow = {
  displayName: 'BATCH-01 · INV-1',
  batchNo: 'BATCH-01',
  supplierName: 'Supplier Ltd',
  deliveryDate: '2026-09-21',
  status: 'in_hand',
  remainingItems: 5,
  pendingPickingOrders: 2,
};

describe('viewListRow', () => {
  it('renders the default title + single meta line', () => {
    const v = viewListRow('receiving', receivingRow);
    expect(v.title).toBe('BATCH-01 · INV-1');
    expect(v.meta).toEqual(['Supplier Ltd · 2026-09-21']);
    expect(v.chip).toBe('status');
  });

  it('renders each configured meta template as its own line (max 2)', () => {
    const view = defaultPdaViewConfig();
    view.lists.receiving.meta = ['[supplier_name]', '[delivery_date]', '[batch_no]'];
    const v = viewListRow('receiving', receivingRow, view);
    expect(v.meta).toEqual(['Supplier Ltd', '2026-09-21']);
  });

  it('drops meta lines whose render is empty', () => {
    const view = defaultPdaViewConfig();
    view.lists.receiving.meta = ['[supplier_name]', '[date_code]'];
    const v = viewListRow('receiving', receivingRow, view);
    expect(v.meta).toEqual(['Supplier Ltd']);
  });

  it('falls back to the default title, then the primary id', () => {
    const view = defaultPdaViewConfig();
    view.lists.receiving.title = '[date_code]';
    expect(viewListRow('receiving', receivingRow, view).title).toBe('BATCH-01 · INV-1');
    view.lists.receiving.title = '[name]';
    expect(viewListRow('receiving', { batchNo: 'BATCH-01' }, view).title).toBe('BATCH-01');
  });

  it('renders the stock-search group row', () => {
    const v = viewListRow('stock-search', { wclItemNo: 'WCL-1', partNo: 'PN-1', onHandQty: 42 });
    expect(v.title).toBe('WCL-1');
    expect(v.meta).toEqual(['PN-1']);
  });
});

describe('viewListChip', () => {
  it('status chip resolves to a status spec', () => {
    expect(viewListChip('receiving', receivingRow)).toEqual({
      kind: 'status',
      status: 'in_hand',
      labelFn: 'receiving',
    });
  });

  it('count chips hide at zero and render with params otherwise', () => {
    expect(viewListChip('receiving', { ...receivingRow, remainingItems: 0 }, withChip('receiving', 'remaining_items'))).toBeNull();
    expect(viewListChip('receiving', receivingRow, withChip('receiving', 'remaining_items'))).toEqual({
      kind: 'label',
      labelKey: 'receiving.remaining',
      params: { count: 5 },
      cls: 'badge--pending',
    });
    expect(viewListChip('receiving', receivingRow, withChip('receiving', 'pending_picking_orders'))).toEqual({
      kind: 'label',
      labelKey: 'viewConfig.chips.pendingPickingOrders',
      params: { count: 2 },
      cls: 'badge--pending',
    });
  });

  it('none hides the chip; stock-search only allows none', () => {
    expect(viewListChip('receiving', receivingRow, withChip('receiving', 'none'))).toBeNull();
    expect(viewListChip('stock-search', { wclItemNo: 'W' })).toBeNull();
    expect(PDA_LIST_CHIP_FIELDS['stock-search']).toEqual(['none']);
  });

  it('working_by_name hides without a lock holder', () => {
    expect(viewListChip('picking', { status: 'picking' }, withChip('picking', 'working_by_name'))).toBeNull();
    expect(viewListChip('picking', { workingByName: 'chan.tm' }, withChip('picking', 'working_by_name'))).toEqual({
      kind: 'label',
      labelKey: 'picking.lockedBy',
      params: { name: 'chan.tm' },
      cls: 'badge--pending',
    });
  });

  it('verify box_status uses the box label fn; allocation_status uses allocation', () => {
    expect(viewListChip('verify', { boxStatus: 'closed' })).toEqual({ kind: 'status', status: 'closed', labelFn: 'box' });
    expect(viewListChip('picking', { allocationStatus: 'partial' }, withChip('picking', 'allocation_status'))).toEqual({
      kind: 'status',
      status: 'partial',
      labelFn: 'allocation',
    });
  });

  it('statusLabelFn override (put-away candidate rows carry receiving statuses)', () => {
    expect(viewListChip('put-away', { status: 'in_hand' }, undefined, { statusLabelFn: 'receiving' })).toEqual({
      kind: 'status',
      status: 'in_hand',
      labelFn: 'receiving',
    });
  });
});

function withChip(list: keyof typeof DEFAULT_PDA_VIEW_CONFIG.lists, chip: string) {
  const view = defaultPdaViewConfig();
  view.lists[list].chip = chip;
  return view;
}

describe('detail field values', () => {
  const receivingItem = {
    partNo: 'PN-1',
    wclItemNo: null,
    poNo: 'PO-1',
    poLine: '3',
    lineQty: 12,
    receivedQty: 10,
    pickedQty: 2,
    putAwayQty: 1,
    allocatedQty: 3,
    ctnNo: 'CTN-9',
    dateCode: '3626',
    lotCode: null,
    coo: 'cn',
    cow: null,
  };

  it('receivingItemFieldValue maps every catalog field', () => {
    for (const field of PDA_DETAIL_FIELDS.receivingDetail) {
      expect(typeof receivingItemFieldValue(field, receivingItem)).toBe('string');
    }
    expect(receivingItemFieldValue('wcl_item_no', receivingItem)).toBe('PN-1');
    expect(receivingItemFieldValue('available_qty', receivingItem)).toBe('4'); // 10-2-1-3
    expect(receivingItemFieldValue('lot_code', receivingItem)).toBe('—');
  });

  it('putAwayItemFieldValue maps fields incl. suggested shelf/box pair', () => {
    const item = {
      partNo: 'PN-1',
      wclItemNo: 'WCL-1',
      lineQty: 12,
      receivedQty: 10,
      remainingQty: 4,
      dateCode: null,
      lotCode: null,
      coo: null,
      cow: null,
      suggestedShelfCode: 'A-01',
      suggestedBoxId: 'BOX-1',
    };
    for (const field of PDA_DETAIL_FIELDS.putAwayDetail) {
      expect(typeof putAwayItemFieldValue(field, item)).toBe('string');
    }
    expect(putAwayItemFieldValue('suggested_shelf', item)).toBe('A-01 / BOX-1');
    expect(putAwayItemFieldValue('suggested_shelf', { ...item, suggestedShelfCode: null })).toBe('—');
  });
});
