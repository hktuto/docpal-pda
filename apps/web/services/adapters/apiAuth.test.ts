import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApiAuthService } from './apiAuth';
import { I18nError } from '~/composables/i18nError';

const STORAGE_KEY = 'warehouse-user-id';

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

const AUTH_USER = {
  id: 'u1',
  username: 'operator',
  name: 'Operator One',
  role: 'operator',
};

describe('createApiAuthService', () => {
  const fetchMock = vi.fn();
  let storage: Storage;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    storage = createLocalStorageFake();
    vi.stubGlobal('localStorage', storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('login posts credentials and maps AuthUser to User', async () => {
    fetchMock.mockResolvedValue(jsonResponse(AUTH_USER));
    const auth = createApiAuthService({ adapter: 'api', apiBaseUrl: 'http://api.test' });

    const user = await auth.login('operator', 'DocPal2026!');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'operator', password: 'DocPal2026!' }),
      })
    );
    expect(user).toEqual({
      id: 'u1',
      username: 'operator',
      displayName: 'Operator One',
      role: 'operator',
      createdAt: null,
    });
  });

  it('login maps a 401 to I18nError("invalid_username_or_password")', async () => {
    fetchMock.mockResolvedValue(errorResponse('invalid credentials', 401));
    const auth = createApiAuthService({ adapter: 'api', apiBaseUrl: 'http://api.test' });

    const promise = auth.login('operator', 'wrong');
    await expect(promise).rejects.toThrow(I18nError);
    await expect(promise).rejects.toMatchObject({ code: 'invalid_username_or_password' });
  });

  it('getCurrentUser returns null without fetching when no stored id', async () => {
    const auth = createApiAuthService({ adapter: 'api', apiBaseUrl: 'http://api.test' });

    const user = await auth.getCurrentUser();

    expect(user).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getCurrentUser fetches and maps the stored user', async () => {
    storage.setItem(STORAGE_KEY, 'u1');
    fetchMock.mockResolvedValue(jsonResponse(AUTH_USER));
    const auth = createApiAuthService({ adapter: 'api', apiBaseUrl: 'http://api.test' });

    const user = await auth.getCurrentUser();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/auth/users/u1',
      expect.objectContaining({ method: 'GET' })
    );
    expect(user).toEqual({
      id: 'u1',
      username: 'operator',
      displayName: 'Operator One',
      role: 'operator',
      createdAt: null,
    });
  });

  it('getCurrentUser clears the stored id and returns null on 404', async () => {
    storage.setItem(STORAGE_KEY, 'gone');
    fetchMock.mockResolvedValue(errorResponse('user not found', 404));
    const auth = createApiAuthService({ adapter: 'api', apiBaseUrl: 'http://api.test' });

    const user = await auth.getCurrentUser();

    expect(user).toBeNull();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('logout resolves without fetching', async () => {
    const auth = createApiAuthService({ adapter: 'api', apiBaseUrl: 'http://api.test' });

    await expect(auth.logout()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
