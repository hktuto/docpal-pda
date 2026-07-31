import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SERVER_HOSTS,
  SERVER_HOST_STORAGE_KEY,
  LEGACY_SERVER_HOST_STORAGE_KEY,
  getServerHostOptions,
  getSavedServerHost,
  getEffectiveServerHost,
  saveServerHost,
  clearSavedServerHost,
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
  it('lists the five regional hosts in order', () => {
    expect(SERVER_HOSTS.map((h) => h.id)).toEqual(['hk', 'sz', 'sh', 'gz', 'bj']);
    for (const host of SERVER_HOSTS) {
      expect(host.url).toBe(`https://wms-${host.id}.docpal.weltronics.com:3000`);
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
    saveServerHost('https://wms-hk.docpal.weltronics.com');
    expect(getSavedServerHost()).toBe('https://wms-hk.docpal.weltronics.com');
    expect(window.localStorage.getItem(SERVER_HOST_STORAGE_KEY)).toBe(
      'https://wms-hk.docpal.weltronics.com',
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

  it('getEffectiveServerHost prefers the saved host and falls back to legacy', () => {
    window.localStorage.setItem(LEGACY_SERVER_HOST_STORAGE_KEY, 'https://legacy.example.com');
    expect(getEffectiveServerHost()).toBe('https://legacy.example.com');
    saveServerHost('https://wms-sz.docpal.weltronics.com');
    expect(getEffectiveServerHost()).toBe('https://wms-sz.docpal.weltronics.com');
  });
});
