import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createApiClient, ApiError } from './apiClient';
import { I18nError } from '~/composables/i18nError';

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}

function errorResponse(text: string, status: number): Response {
  return {
    ok: false,
    status,
    text: async () => text,
    json: async () => {
      throw new Error('no json');
    },
  } as unknown as Response;
}

describe('createApiClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('GET builds URL from baseUrl + path + query and returns parsed JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '1' }));
    const client = createApiClient({ baseUrl: 'http://api.test', getActorId: () => 'u1' });

    const result = await client.get('/orders', {
      status: 'open',
      page: 2,
      skip: undefined,
      nil: null,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/orders?status=open&page=2',
      expect.objectContaining({ method: 'GET' })
    );
    expect(result).toEqual({ id: '1' });
  });

  it('POST sends JSON body with content-type header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const client = createApiClient({ baseUrl: 'http://api.test', getActorId: () => 'u1' });

    await client.post('/orders', { foo_bar: 1 });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/orders',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ foo_bar: 1 }),
      })
    );
  });

  it('maps i18n-key-shaped error text to I18nError with that key', async () => {
    fetchMock.mockResolvedValue(errorResponse('box_is_not_open', 400));
    const client = createApiClient({ baseUrl: 'http://api.test', getActorId: () => 'u1' });

    const promise = client.get('/boxes/1');
    await expect(promise).rejects.toThrow(I18nError);
    await expect(promise).rejects.toMatchObject({ code: 'box_is_not_open' });
  });

  it('maps known English error text to its i18n key', async () => {
    fetchMock.mockResolvedValue(errorResponse('package is not in a box', 409));
    const client = createApiClient({ baseUrl: 'http://api.test', getActorId: () => 'u1' });

    const promise = client.patch('/packages/1/verify', {});
    await expect(promise).rejects.toThrow(I18nError);
    await expect(promise).rejects.toMatchObject({ code: 'package_not_in_shipping_box' });
  });

  it('maps "shelf box is not closed" 409 text to shelf_box_is_not_closed', async () => {
    fetchMock.mockResolvedValue(errorResponse('shelf box is not closed', 409));
    const client = createApiClient({ baseUrl: 'http://api.test', getActorId: () => 'u1' });

    const promise = client.post('/verification-tasks/vt1/complete');
    await expect(promise).rejects.toThrow(I18nError);
    await expect(promise).rejects.toMatchObject({ code: 'shelf_box_is_not_closed' });
  });

  // API error sentences (verbatim from apps/api/src) that must map to an
  // errors.* i18n key instead of surfacing as raw "409: <english>".
  const ENGLISH_ERROR_CASES: [string, string][] = [
    ['picking order has an open issue', 'picking_order_has_open_issue'],
    ['picking order already finished', 'picking_order_already_finished'],
    ['scan quantity exceeds required', 'scan_quantity_exceeds_required'],
    ['insufficient lot quantity', 'insufficient_lot_quantity'],
    ['package already in a box', 'package_already_in_box'],
    ['box is not empty', 'box_is_not_empty'],
    ['no items to pick', 'no_items_to_pick'],
    ['not all items fully boxed', 'not_all_items_fully_boxed'],
    ['allocation not found', 'allocation_not_found'],
    ['allocation not found in this order', 'allocation_not_found'],
    ['qty exceeds the remaining picking need', 'quantity_exceeds_picking_need'],
    ['qty not available on this receiving order', 'quantity_not_available_receiving'],
    ['picking item part is not on this receiving order', 'receiving_picking_part_mismatch'],
    ['all packages must be verified', 'all_packages_must_be_verified'],
    ['weights must be greater than zero', 'weights_must_be_greater_than_zero'],
    ['gross weight must be >= net weight', 'gross_weight_must_be_greater_than_or_equal_to_net_weight'],
    ['cannot close an empty box', 'cannot_close_empty_shipping_box'],
    ['all shipping boxes must be closed', 'all_shipping_boxes_must_be_closed'],
    ['picking item not fully packed', 'picking_item_not_fully_packed'],
    ['scan is already in a box', 'put_away_scan_already_boxed'],
    ['scan is not in a box', 'put_away_scan_not_boxed'],
    ['put-away scan not found', 'put_away_scan_not_found'],
    ['cannot close an empty shelf box', 'cannot_close_empty_shelf_box'],
    ['shelf box is not empty', 'shelf_box_is_not_empty'],
    ['verification task not found', 'verification_task_not_found'],
    ['verification task is not pending', 'verification_task_is_not_pending'],
  ];

  it.each(ENGLISH_ERROR_CASES)(
    'maps English API error "%s" to i18n key "%s"',
    async (text, key) => {
      fetchMock.mockResolvedValue(errorResponse(text, 409));
      const client = createApiClient({ baseUrl: 'http://api.test', getActorId: () => 'u1' });

      const promise = client.get('/anything');
      await expect(promise).rejects.toThrow(I18nError);
      await expect(promise).rejects.toMatchObject({ code: key });
    }
  );

  it('throws a plain Error containing the status for unmapped error text', async () => {
    fetchMock.mockResolvedValue(errorResponse('something exploded', 500));
    const client = createApiClient({ baseUrl: 'http://api.test', getActorId: () => 'u1' });

    const promise = client.get('/orders');
    await expect(promise).rejects.toThrow(Error);
    await expect(promise).rejects.not.toThrow(I18nError);
    await expect(promise).rejects.toThrow(/500/);
    await expect(promise).rejects.toMatchObject({ status: 500 });
  });

  it('throws an Error with the status when a 2xx body is not valid JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    } as unknown as Response);
    const client = createApiClient({ baseUrl: 'http://api.test', getActorId: () => 'u1' });

    const promise = client.get('/orders');
    await expect(promise).rejects.toThrow(ApiError);
    await expect(promise).rejects.not.toThrow(SyntaxError);
    await expect(promise).rejects.toMatchObject({ status: 200 });
  });

  it('throws I18nError("network_error") when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const client = createApiClient({ baseUrl: 'http://api.test', getActorId: () => 'u1' });

    const promise = client.get('/orders');
    await expect(promise).rejects.toThrow(I18nError);
    await expect(promise).rejects.toMatchObject({ code: 'network_error' });
  });

  it('normalizes a trailing slash in baseUrl', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '1' }));
    const client = createApiClient({ baseUrl: 'http://api.test/', getActorId: () => 'u1' });

    await client.get('/orders');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/orders',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('returns undefined for 204 responses', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => '',
      json: async () => {
        throw new Error('no body');
      },
    } as unknown as Response);
    const client = createApiClient({ baseUrl: 'http://api.test', getActorId: () => 'u1' });

    const result = await client.del('/orders/1');

    expect(result).toBeUndefined();
  });

  it('GET sends no body and no content-type header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '1' }));
    const client = createApiClient({ baseUrl: 'http://api.test', getActorId: () => 'u1' });

    await client.get('/orders');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it('actorId() passes through getActorId', () => {
    const client = createApiClient({ baseUrl: 'http://api.test', getActorId: () => 'u1' });

    expect(client.actorId()).toBe('u1');
  });

  it('URL-encodes query param values', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '1' }));
    const client = createApiClient({ baseUrl: 'http://api.test', getActorId: () => 'u1' });

    await client.get('/orders', { q: 'a b&c' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/orders?q=a+b%26c',
      expect.objectContaining({ method: 'GET' })
    );
  });
});
