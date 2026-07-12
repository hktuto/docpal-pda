import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createApiClient } from './apiClient';
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

  it('throws a plain Error containing the status for unmapped error text', async () => {
    fetchMock.mockResolvedValue(errorResponse('something exploded', 500));
    const client = createApiClient({ baseUrl: 'http://api.test', getActorId: () => 'u1' });

    const promise = client.get('/orders');
    await expect(promise).rejects.toThrow(Error);
    await expect(promise).rejects.not.toThrow(I18nError);
    await expect(promise).rejects.toThrow(/500/);
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
});
