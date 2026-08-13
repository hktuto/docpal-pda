import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SERVER_HOSTS,
  SERVER_HOST_STORAGE_KEY,
  getServerHostOptions,
  getSavedServerHost,
  getApiBaseUrl,
  saveServerHost,
  clearSavedServerHost,
  switchServerHost,
} from './serverHost';

function createLocalStorageFake(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: createLocalStorageFake() });
});

describe('SERVER_HOSTS', () => {
  it('lists the five regional backend API URLs in order', () => {
    expect(SERVER_HOSTS.map((h) => h.id)).toEqual(['hk', 'sz', 'sh', 'gz', 'bj']);
    expect(SERVER_HOSTS[0].url).toBe('http://192.168.1.132:3002'); // hk
    for (const host of SERVER_HOSTS.slice(1)) {
      expect(host.url).toBe('http://192.168.5.116:9002');
    }
  });

  it('is the production option list (no local entry outside dev)', () => {
    // Tests run with import.meta.dev = false, so no local entry is appended.
    expect(getServerHostOptions()).toEqual(SERVER_HOSTS);
  });
});

describe('saved host storage', () => {
  it('round-trips save / get / clear', () => {
    expect(getSavedServerHost()).toBe('');
    saveServerHost('https://wms-hk.docpal.weltronics.com:9002');
    expect(getSavedServerHost()).toBe('https://wms-hk.docpal.weltronics.com:9002');
    expect(window.localStorage.getItem(SERVER_HOST_STORAGE_KEY)).toBe(
      'https://wms-hk.docpal.weltronics.com:9002',
    );
    clearSavedServerHost();
    expect(getSavedServerHost()).toBe('');
  });

  it('returns empty when storage throws', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
      },
    });
    expect(getSavedServerHost()).toBe('');
  });

  it('discards stale web-host values written by boot-redirect builds', () => {
    for (const stale of [
      'https://mobile-wms.wclsolution.com:3000',
      'http://127.0.0.1:3103',
    ]) {
      window.localStorage.setItem(SERVER_HOST_STORAGE_KEY, stale);
      expect(getSavedServerHost()).toBe('');
      expect(window.localStorage.getItem(SERVER_HOST_STORAGE_KEY)).toBeNull();
    }
  });
});

describe('getApiBaseUrl', () => {
  it('prefers the saved backend over the runtime-config default', () => {
    // No Nuxt runtime in tests → the fallback is "".
    expect(getApiBaseUrl()).toBe('');
    saveServerHost('https://wms-sz.docpal.weltronics.com:9002');
    expect(getApiBaseUrl()).toBe('https://wms-sz.docpal.weltronics.com:9002');
  });
});

describe('switchServerHost', () => {
  it('saves the backend and clears backend-scoped state, keeping locale', () => {
    const storage = window.localStorage;
    storage.setItem('warehouse-token', 'tok');
    storage.setItem('warehouse-user-id', 'u1');
    storage.setItem('warehouse-user', '{}');
    storage.setItem('wms-events-last-id', '42');
    storage.setItem('wms-cache:http://old/api', '{}');
    storage.setItem('warehouse-locale', 'zh-HK');

    switchServerHost('https://wms-bj.docpal.weltronics.com:9002');

    expect(getSavedServerHost()).toBe('https://wms-bj.docpal.weltronics.com:9002');
    expect(storage.getItem('warehouse-token')).toBeNull();
    expect(storage.getItem('warehouse-user-id')).toBeNull();
    expect(storage.getItem('warehouse-user')).toBeNull();
    expect(storage.getItem('wms-events-last-id')).toBeNull();
    expect(storage.getItem('wms-cache:http://old/api')).toBeNull();
    expect(storage.getItem('warehouse-locale')).toBe('zh-HK');
  });
});
