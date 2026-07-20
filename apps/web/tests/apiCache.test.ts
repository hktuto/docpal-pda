import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCached,
  setCached,
  invalidatePrefix,
  clearApiCache,
  setApiCacheEnabled,
} from '~/services/apiCache';

// Same node-env localStorage fake as services/adapters/apiAuth.test.ts.
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

describe('apiCache', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createLocalStorageFake();
    vi.stubGlobal('localStorage', storage);
    setApiCacheEnabled(true);
    clearApiCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns null for a missing url', () => {
    expect(getCached('http://api.test/orders')).toBeNull();
  });

  it('returns the cached payload within the TTL', () => {
    setCached('http://api.test/orders', [{ id: '1' }]);
    expect(getCached('http://api.test/orders')).toEqual([{ id: '1' }]);
  });

  it('mirrors entries to localStorage so a fresh memory map still hits', async () => {
    setCached('http://api.test/orders', { id: '1' });
    expect(storage.getItem('wms-cache:http://api.test/orders')).not.toBeNull();

    vi.resetModules();
    const fresh = await import('~/services/apiCache');
    expect(fresh.getCached('http://api.test/orders')).toEqual({ id: '1' });
    fresh.clearApiCache();
  });

  it('returns null after the TTL and lazily deletes the entry', () => {
    vi.useFakeTimers();
    setCached('http://api.test/orders', { id: '1' });

    vi.advanceTimersByTime(61_000);

    expect(getCached('http://api.test/orders')).toBeNull();
    expect(storage.getItem('wms-cache:http://api.test/orders')).toBeNull();
  });

  it('invalidatePrefix drops matching path prefixes, query strings included', () => {
    setCached('http://api.test/picking-orders?status=open', [1]);
    setCached('http://api.test/picking-orders/po1', { id: 'po1' });
    setCached('http://api.test/receiving-orders', [2]);

    invalidatePrefix('/picking-orders');

    expect(getCached('http://api.test/picking-orders?status=open')).toBeNull();
    expect(getCached('http://api.test/picking-orders/po1')).toBeNull();
    expect(getCached('http://api.test/receiving-orders')).toEqual([2]);
    expect(storage.getItem('wms-cache:http://api.test/picking-orders?status=open')).toBeNull();
    expect(storage.getItem('wms-cache:http://api.test/receiving-orders')).not.toBeNull();
  });

  it('invalidatePrefix also removes entries that only exist in localStorage', async () => {
    setCached('http://api.test/picking-orders', [1]);

    vi.resetModules();
    const fresh = await import('~/services/apiCache');
    fresh.invalidatePrefix('/picking-orders');

    expect(storage.getItem('wms-cache:http://api.test/picking-orders')).toBeNull();
  });

  it('evicts the oldest entry beyond 150 entries', () => {
    vi.useFakeTimers();
    for (let i = 0; i <= 150; i++) {
      setCached(`http://api.test/orders/${i}`, i);
      vi.advanceTimersByTime(1);
    }

    expect(getCached('http://api.test/orders/0')).toBeNull();
    expect(getCached('http://api.test/orders/1')).toBe(1);
    expect(getCached('http://api.test/orders/150')).toBe(150);
  });

  it('clearApiCache wipes memory and every wms-cache: storage key', () => {
    setCached('http://api.test/orders', [1]);
    storage.setItem('other-key', 'keep');

    clearApiCache();

    expect(getCached('http://api.test/orders')).toBeNull();
    expect(storage.getItem('wms-cache:http://api.test/orders')).toBeNull();
    expect(storage.getItem('other-key')).toBe('keep');
  });

  it('kill switch: disabled cache always misses and drops writes', () => {
    setCached('http://api.test/orders', [{ id: '1' }]);
    setApiCacheEnabled(false);

    expect(getCached('http://api.test/orders')).toBeNull(); // wiped on disable
    setCached('http://api.test/orders', [{ id: '2' }]); // write dropped
    expect(getCached('http://api.test/orders')).toBeNull();
    expect(storage.getItem('wms-cache:http://api.test/orders')).toBeNull();

    setApiCacheEnabled(true);
    setCached('http://api.test/orders', [{ id: '3' }]);
    expect(getCached('http://api.test/orders')).toEqual([{ id: '3' }]);
  });
});
