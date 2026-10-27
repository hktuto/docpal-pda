import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolvePickingFinishRoute, isLabelingNotPending, finishLabelingOrAlreadyDone } from '../utils/labeling';
import { viewListRow, viewListChip, PDA_LIST_CHIP_FIELDS, defaultPdaViewConfig } from '../utils/viewConfig';
import { ApiError } from '../services/apiClient';
import { I18nError } from '../composables/i18nError';
import type { LabelingOrderRow } from '../services/types';

describe('resolvePickingFinishRoute', () => {
  const base = { measuringEnabled: true, verifyEnabled: true, orderId: 'po1' };

  it('routes to the labeling detail when the finish response has labelingPending', () => {
    expect(resolvePickingFinishRoute({ ...base, labelingPending: true })).toBe('/labeling/po1');
  });

  it('labelingPending wins over the measuring-off verify jump', () => {
    expect(
      resolvePickingFinishRoute({ ...base, labelingPending: true, measuringEnabled: false })
    ).toBe('/labeling/po1');
  });

  it('keeps the measuring-off → /verify jump when not labeling-pending', () => {
    expect(
      resolvePickingFinishRoute({ ...base, labelingPending: false, measuringEnabled: false })
    ).toBe('/verify');
  });

  it('stays put otherwise (measuring on, or both off)', () => {
    expect(resolvePickingFinishRoute({ ...base, labelingPending: false })).toBeNull();
    expect(
      resolvePickingFinishRoute({ ...base, labelingPending: false, measuringEnabled: false, verifyEnabled: false })
    ).toBeNull();
  });
});

describe('isLabelingNotPending', () => {
  it('matches the I18nError form (plain-text snake_case body)', () => {
    expect(isLabelingNotPending(new I18nError('labeling_not_pending'))).toBe(true);
    expect(isLabelingNotPending(new I18nError('picking_order_not_found'))).toBe(false);
  });

  it('matches the ApiError 409 forms (error/message body field or message)', () => {
    expect(isLabelingNotPending(new ApiError('x', 409, { error: 'labeling_not_pending' }))).toBe(true);
    expect(isLabelingNotPending(new ApiError('labeling_not_pending', 409, { message: 'labeling_not_pending' }))).toBe(true);
    expect(isLabelingNotPending(new ApiError('labeling_not_pending', 409))).toBe(true);
    expect(isLabelingNotPending(new ApiError('labeling_not_pending', 404))).toBe(false);
    expect(isLabelingNotPending(new ApiError('other', 409, { error: 'other' }))).toBe(false);
    expect(isLabelingNotPending(new Error('labeling_not_pending'))).toBe(false);
  });
});

describe('finishLabelingOrAlreadyDone', () => {
  it('returns "finished" on success', async () => {
    const warehouse = { finishLabeling: vi.fn().mockResolvedValue({ id: 'po1', status: 'picking_finished', labelingPending: false }) };
    await expect(finishLabelingOrAlreadyDone(warehouse, 'po1')).resolves.toBe('finished');
    expect(warehouse.finishLabeling).toHaveBeenCalledWith('po1');
  });

  it('maps 409 labeling_not_pending to "already-done"', async () => {
    const warehouse = { finishLabeling: vi.fn().mockRejectedValue(new I18nError('labeling_not_pending')) };
    await expect(finishLabelingOrAlreadyDone(warehouse, 'po1')).resolves.toBe('already-done');
  });

  it('rethrows other errors', async () => {
    const warehouse = { finishLabeling: vi.fn().mockRejectedValue(new I18nError('network_error')) };
    await expect(finishLabelingOrAlreadyDone(warehouse, 'po1')).rejects.toThrow('network_error');
  });
});

function labelingRow(over: Partial<LabelingOrderRow> = {}): LabelingOrderRow {
  return {
    id: 'po1',
    orderNo: 'SO-100234',
    pickingOrderType: 'SO',
    customerCode: 'CUST-01',
    shipTo: 'Hong Kong',
    deliveryDate: '2026-09-22',
    itemCount: 3,
    totalQty: 120,
    labelMatches: [
      { ruleId: 'r1', name: 'Carton label', labelType: 'carton', printTemplateId: 'tpl-1' },
      { ruleId: 'r2', name: 'Item label', labelType: 'item', printTemplateId: 'tpl-2' },
    ],
    lastUpdateDate: '2026-10-28T08:00:00.000Z',
    ...over,
  };
}

describe('labeling list row rendering (pdaViewConfig)', () => {
  it('renders title/meta/chip through the built-in labeling defaults', () => {
    const row = labelingRow();
    const fields = { ...row, labelCount: row.labelMatches.length };
    const view = viewListRow('labeling', fields);
    expect(view.title).toBe('SO-100234');
    expect(view.meta).toEqual(['CUST-01 · Hong Kong']);
    expect(view.chip).toBe('labelCount');
  });

  it('falls back to the order no when the custom title renders empty', () => {
    const row = labelingRow();
    const view = defaultPdaViewConfig();
    view.lists.labeling = { title: '[customer_code]', meta: ['[ship_to]'], chip: 'none' };
    // customerCode present → custom title renders
    expect(viewListRow('labeling', { ...row, labelCount: 2 }, view).title).toBe('CUST-01');
    // empty render → default title → primary id (order no)
    const emptyView = viewListRow('labeling', { id: 'po1', orderNo: 'SO-1' }, view);
    expect(emptyView.title).toBe('SO-1');
  });

  it('labelCount chip shows the matched label count, hidden at zero', () => {
    const row = labelingRow();
    const chip = viewListChip('labeling', { ...row, labelCount: 2 });
    expect(chip).toEqual({
      kind: 'label',
      labelKey: 'labeling.labelsChip',
      params: { count: 2 },
      cls: 'badge--pending',
    });
    expect(viewListChip('labeling', { ...row, labelCount: 0 })).toBeNull();
  });

  it('labeling chip catalog = picking order-field chips + labelCount', () => {
    expect(PDA_LIST_CHIP_FIELDS.labeling).toEqual([
      'status',
      'allocation_status',
      'working_by_name',
      'labelCount',
      'none',
    ]);
  });
});

describe('useLabelingOrders', () => {
  const getLabelingOrders = vi.fn();

  beforeEach(() => {
    getLabelingOrders.mockReset();
    vi.stubGlobal('ref', <T,>(value: T) => ({ value }));
    vi.stubGlobal('computed', <T,>(fn: () => T) => ({ get value() { return fn(); } }));
    vi.stubGlobal('useWarehouse', () => ({ getLabelingOrders }));
    vi.stubGlobal('useErrorMessage', () => (e: unknown) => String(e));
    vi.resetModules();
  });

  async function fresh() {
    return (await import('../composables/useLabelingOrders')).useLabelingOrders();
  }

  it('loads the first page and reports hasMore from the total', async () => {
    getLabelingOrders.mockResolvedValue({ rows: [labelingRow({ id: 'a' })], total: 2 });
    const s = await fresh();

    await s.load(true);

    expect(getLabelingOrders).toHaveBeenCalledWith({ search: undefined, limit: 50, offset: 0 });
    expect(s.rows.value.map((r) => r.id)).toEqual(['a']);
    expect(s.total.value).toBe(2);
    expect(s.hasMore.value).toBe(true);
  });

  it('appends the next page on load-more and trims the search term', async () => {
    getLabelingOrders
      .mockResolvedValueOnce({ rows: [labelingRow({ id: 'a' })], total: 2 })
      .mockResolvedValueOnce({ rows: [labelingRow({ id: 'b' })], total: 2 });
    const s = await fresh();
    s.search.value = '  SO-1  ';

    await s.load(true);
    await s.load(false);

    expect(getLabelingOrders).toHaveBeenNthCalledWith(1, { search: 'SO-1', limit: 50, offset: 0 });
    expect(getLabelingOrders).toHaveBeenNthCalledWith(2, { search: 'SO-1', limit: 50, offset: 1 });
    expect(s.rows.value.map((r) => r.id)).toEqual(['a', 'b']);
    expect(s.hasMore.value).toBe(false);
  });

  it('refresh re-fetches the whole loaded window', async () => {
    getLabelingOrders.mockResolvedValue({ rows: [labelingRow({ id: 'a' })], total: 1 });
    const s = await fresh();
    await s.load(true);
    getLabelingOrders.mockResolvedValue({ rows: [], total: 0 });

    await s.refresh();

    expect(getLabelingOrders).toHaveBeenLastCalledWith({ search: undefined, limit: 50, offset: 0 });
    expect(s.rows.value).toEqual([]);
    expect(s.total.value).toBe(0);
  });

  it('a failed reset clears the rows and records the error', async () => {
    getLabelingOrders.mockRejectedValue(new Error('offline'));
    const s = await fresh();

    await s.load(true);

    expect(s.rows.value).toEqual([]);
    expect(s.loadError.value).toContain('offline');
  });
});
