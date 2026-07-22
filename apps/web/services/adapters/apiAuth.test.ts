import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApiAuthService, getToken, getStoredUser } from './apiAuth';
import { setTokenGetter } from '../apiClient';
import { I18nError } from '~/composables/i18nError';

const TOKEN_KEY = 'warehouse-token';
const USER_ID_KEY = 'warehouse-user-id';
const USER_KEY = 'warehouse-user';

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

const SESSION_USER = {
  id: 'u1',
  username: 'operator',
  displayName: 'Operator One',
  groupCodes: ['operator'],
};

const EXPECTED_USER = {
  id: 'u1',
  username: 'operator',
  displayName: 'Operator One',
  groupCodes: ['operator'],
  createdAt: null,
};

describe('createApiAuthService', () => {
  const fetchMock = vi.fn();
  let storage: Storage;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    storage = createLocalStorageFake();
    vi.stubGlobal('localStorage', storage);
    // apiAuth registers getToken at module load; make sure nothing leaked.
    setTokenGetter(getToken);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('login posts credentials, stores the session and maps the user', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: SESSION_USER, token: 'jwt-1' }));
    const auth = createApiAuthService({ apiBaseUrl: 'http://api.test' });

    const user = await auth.login('operator', 'DocPal2026!');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'operator', password: 'DocPal2026!' }),
      })
    );
    expect(storage.getItem(TOKEN_KEY)).toBe('jwt-1');
    expect(storage.getItem(USER_ID_KEY)).toBe('u1');
    expect(storage.getItem(USER_KEY)).toBe(JSON.stringify(SESSION_USER));
    expect(user).toEqual(EXPECTED_USER);
  });

  it('getStoredUser reads the persisted session user (with groupCodes)', () => {
    expect(getStoredUser()).toBeNull();
    storage.setItem(USER_KEY, JSON.stringify(SESSION_USER));
    expect(getStoredUser()).toEqual(SESSION_USER);
  });

  it('login maps a 401 to I18nError("invalid_username_or_password")', async () => {
    fetchMock.mockResolvedValue(errorResponse('invalid credentials', 401));
    const auth = createApiAuthService({ apiBaseUrl: 'http://api.test' });

    const promise = auth.login('operator', 'wrong');
    await expect(promise).rejects.toThrow(I18nError);
    await expect(promise).rejects.toMatchObject({ code: 'invalid_username_or_password' });
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('getToken reads the stored token', async () => {
    expect(getToken()).toBeNull();
    storage.setItem(TOKEN_KEY, 'jwt-1');
    expect(getToken()).toBe('jwt-1');
  });

  it('getCurrentUser returns null without fetching when there is no token', async () => {
    const auth = createApiAuthService({ apiBaseUrl: 'http://api.test' });

    const user = await auth.getCurrentUser();

    expect(user).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getCurrentUser calls GET /auth/me with the bearer token and maps the user', async () => {
    storage.setItem(TOKEN_KEY, 'jwt-1');
    storage.setItem(USER_ID_KEY, 'u1');
    fetchMock.mockResolvedValue(jsonResponse(SESSION_USER));
    const auth = createApiAuthService({ apiBaseUrl: 'http://api.test' });

    const user = await auth.getCurrentUser();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/auth/me',
      expect.objectContaining({
        method: 'GET',
        headers: { authorization: 'Bearer jwt-1' },
      })
    );
    expect(user).toEqual(EXPECTED_USER);
    // The fresh user refreshes the persisted copy (groups can change).
    expect(storage.getItem(USER_KEY)).toBe(JSON.stringify(SESSION_USER));
  });

  it('getCurrentUser clears the session and returns null on 401', async () => {
    storage.setItem(TOKEN_KEY, 'stale');
    storage.setItem(USER_ID_KEY, 'u1');
    storage.setItem(USER_KEY, JSON.stringify(SESSION_USER));
    fetchMock.mockResolvedValue(errorResponse('unauthorized', 401));
    const auth = createApiAuthService({ apiBaseUrl: 'http://api.test' });

    const user = await auth.getCurrentUser();

    expect(user).toBeNull();
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    expect(storage.getItem(USER_ID_KEY)).toBeNull();
    expect(storage.getItem(USER_KEY)).toBeNull();
  });

  it('logout clears the stored session without fetching', async () => {
    storage.setItem(TOKEN_KEY, 'jwt-1');
    storage.setItem(USER_ID_KEY, 'u1');
    storage.setItem(USER_KEY, JSON.stringify(SESSION_USER));
    const auth = createApiAuthService({ apiBaseUrl: 'http://api.test' });

    await expect(auth.logout()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    expect(storage.getItem(USER_ID_KEY)).toBeNull();
    expect(storage.getItem(USER_KEY)).toBeNull();
  });
});
