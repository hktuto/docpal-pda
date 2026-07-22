import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApiClient, ApiError, setTokenGetter } from './apiClient';
import { clearApiCache } from './apiCache';
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

function createLocalStorageFake(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => map.set(key, value),
  };
}

describe('createApiClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    // The token getter is module-level (shared with apiAuth) — reset it.
    setTokenGetter(() => null);
    clearApiCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET builds URL from baseUrl + path + query and returns parsed JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '1' }));
    const client = createApiClient({ baseUrl: 'http://api.test' });

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
    const client = createApiClient({ baseUrl: 'http://api.test' });

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
    const client = createApiClient({ baseUrl: 'http://api.test' });

    const promise = client.get('/boxes/1');
    await expect(promise).rejects.toThrow(I18nError);
    await expect(promise).rejects.toMatchObject({ code: 'box_is_not_open' });
  });

  it('throws an ApiError carrying the parsed body for JSON-object error responses', async () => {
    const body = {
      message: 'multiple_matches',
      candidates: [{ id: 'a1' }, { id: 'a2' }],
    };
    fetchMock.mockResolvedValue(errorResponse(JSON.stringify(body), 409));
    const client = createApiClient({ baseUrl: 'http://api.test' });

    const promise = client.post('/picking-items/pi1/scan', { allocationId: 'x', qty: 1 });
    await expect(promise).rejects.toThrow(ApiError);
    await expect(promise).rejects.not.toThrow(I18nError);
    await expect(promise).rejects.toMatchObject({
      status: 409,
      message: 'multiple_matches',
      body,
    });
  });

  it('falls back to "<status>: <text>" message when the JSON error body has no message', async () => {
    fetchMock.mockResolvedValue(errorResponse(JSON.stringify({ code: 1 }), 400));
    const client = createApiClient({ baseUrl: 'http://api.test' });

    const promise = client.get('/orders');
    await expect(promise).rejects.toThrow(ApiError);
    await expect(promise).rejects.toMatchObject({
      status: 400,
      body: { code: 1 },
    });
    await expect(promise).rejects.toThrow(/400/);
  });

  it('treats a JSON array error body as plain text (no ApiError body)', async () => {
    fetchMock.mockResolvedValue(errorResponse(JSON.stringify([1, 2]), 500));
    const client = createApiClient({ baseUrl: 'http://api.test' });

    const promise = client.get('/orders');
    await expect(promise).rejects.toThrow(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 500, body: undefined });
  });

  it('throws a plain Error containing the status for unmapped error text', async () => {
    fetchMock.mockResolvedValue(errorResponse('something exploded', 500));
    const client = createApiClient({ baseUrl: 'http://api.test' });

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
    const client = createApiClient({ baseUrl: 'http://api.test' });

    const promise = client.get('/orders');
    await expect(promise).rejects.toThrow(ApiError);
    await expect(promise).rejects.not.toThrow(SyntaxError);
    await expect(promise).rejects.toMatchObject({ status: 200 });
  });

  it('throws I18nError("network_error") when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const client = createApiClient({ baseUrl: 'http://api.test' });

    const promise = client.get('/orders');
    await expect(promise).rejects.toThrow(I18nError);
    await expect(promise).rejects.toMatchObject({ code: 'network_error' });
  });

  it('normalizes a trailing slash in baseUrl', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '1' }));
    const client = createApiClient({ baseUrl: 'http://api.test/' });

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
    const client = createApiClient({ baseUrl: 'http://api.test' });

    const result = await client.del('/orders/1');

    expect(result).toBeUndefined();
  });

  it('GET sends no body and no content-type header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '1' }));
    const client = createApiClient({ baseUrl: 'http://api.test' });

    await client.get('/orders');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it('sends Authorization: Bearer when the shared token getter returns a token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '1' }));
    setTokenGetter(() => 'jwt-token');
    const client = createApiClient({ baseUrl: 'http://api.test' });

    await client.get('/orders');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({
      authorization: 'Bearer jwt-token',
    });

    await client.post('/orders', { foo: 1 });
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toEqual({
      authorization: 'Bearer jwt-token',
      'content-type': 'application/json',
    });
  });

  it('sends no Authorization header without a token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '1' }));
    const client = createApiClient({ baseUrl: 'http://api.test' });

    await client.get('/orders');

    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toBeUndefined();
  });

  it('a 401 clears the stored session and throws an ApiError with the status', async () => {
    const storage = createLocalStorageFake();
    storage.setItem('warehouse-token', 'stale');
    storage.setItem('warehouse-user-id', 'u1');
    vi.stubGlobal('localStorage', storage);
    fetchMock.mockResolvedValue(errorResponse('unauthorized', 401));
    setTokenGetter(() => 'stale');
    const client = createApiClient({ baseUrl: 'http://api.test' });

    const promise = client.get('/orders');
    await expect(promise).rejects.toThrow(ApiError);
    await expect(promise).rejects.not.toThrow(I18nError);
    await expect(promise).rejects.toMatchObject({ status: 401 });
    expect(storage.getItem('warehouse-token')).toBeNull();
    expect(storage.getItem('warehouse-user-id')).toBeNull();
  });

  it('a 401 from /auth/login does not clear the stored session', async () => {
    const storage = createLocalStorageFake();
    storage.setItem('warehouse-token', 'keep');
    vi.stubGlobal('localStorage', storage);
    fetchMock.mockResolvedValue(errorResponse('invalid credentials', 401));
    const client = createApiClient({ baseUrl: 'http://api.test' });

    const promise = client.post('/auth/login', { username: 'x', password: 'y' });
    await expect(promise).rejects.toMatchObject({ status: 401 });
    expect(storage.getItem('warehouse-token')).toBe('keep');
  });

  it('URL-encodes query param values', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '1' }));
    const client = createApiClient({ baseUrl: 'http://api.test' });

    await client.get('/orders', { q: 'a b&c' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/orders?q=a+b%26c',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('serves a repeated GET from the cache (fetch called once)', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ id: '1' }]));
    const client = createApiClient({ baseUrl: 'http://api.test' });

    const first = await client.get('/orders', { status: 'open' });
    const second = await client.get('/orders', { status: 'open' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('GET with { cache: false } always fetches', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '1' }));
    const client = createApiClient({ baseUrl: 'http://api.test' });

    await client.get('/orders');
    await client.get('/orders', undefined, { cache: false });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('POST invalidates the cached first-path-segment prefix', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const client = createApiClient({ baseUrl: 'http://api.test' });

    await client.get('/orders'); // cached
    await client.get('/orders/1'); // different URL: separate fetch + cache entry
    await client.post('/orders/1/confirm', {});
    await client.get('/orders'); // prefix /orders invalidated → refetch
    await client.get('/orders/1'); // same prefix → refetch too

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[3][0]).toBe('http://api.test/orders');
    expect(fetchMock.mock.calls[4][0]).toBe('http://api.test/orders/1');
  });

  it('POST does not invalidate other prefixes', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const client = createApiClient({ baseUrl: 'http://api.test' });

    await client.get('/orders'); // cached
    await client.post('/picking-items/pi1/scan', {});
    await client.get('/orders'); // still cached

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('POST invalidates mapped cross-prefix reads (scan → picking detail)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const client = createApiClient({ baseUrl: 'http://api.test' });

    await client.get('/picking-orders/po1'); // cached
    await client.get('/measuring-tasks/mt1'); // cached
    await client.post('/picking-items/pi1/scan', {});
    await client.get('/picking-orders/po1'); // invalidated via map → refetch
    await client.get('/measuring-tasks/mt1'); // not mapped from picking-items → cached

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('POST /shipping-boxes invalidates picking + measuring reads', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const client = createApiClient({ baseUrl: 'http://api.test' });

    await client.get('/picking-orders/po1'); // cached
    await client.get('/measuring-tasks/mt1'); // cached
    await client.post('/shipping-boxes/sb1/close', {});
    await client.get('/picking-orders/po1'); // refetch
    await client.get('/measuring-tasks/mt1'); // refetch

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
