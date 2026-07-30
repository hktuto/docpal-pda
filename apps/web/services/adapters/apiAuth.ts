import { I18nError } from "~/composables/i18nError";
import { createApiClient, ApiError, setTokenGetter } from "../apiClient";
import { clearApiCache } from "../apiCache";
import type { AuthService, CreateAuthServiceOptions } from "../auth";
import type { User } from "../types";

const TOKEN_KEY = "warehouse-token";
const USER_ID_KEY = "warehouse-user-id";
const USER_KEY = "warehouse-user";

/** JWT session user as returned by POST /auth/login and GET /auth/me. */
interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  groupCodes: string[];
  /** Optional — the auth payload may omit it. */
  createdDate?: string | null;
}

/** Read the session token; null when signed out or storage is unavailable. */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Read the persisted session user (incl. groupCodes) synchronously — lets
 * pages/composables check group membership before the /auth/me round-trip
 * completes. Null when signed out or storage is unavailable.
 */
export function getStoredUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

function clearSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_ID_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

// Every apiClient (this auth client and the warehouse adapter's) shares the
// same Bearer-token source.
setTokenGetter(getToken);

function toUser(user: SessionUser): User {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    groupCodes: user.groupCodes,
    // The API auth payload may omit createdDate.
    createdDate: user.createdDate ? new Date(user.createdDate) : null,
  };
}

export function createApiAuthService(options: CreateAuthServiceOptions): AuthService {
  const client = createApiClient({ baseUrl: options.apiBaseUrl ?? "" });

  return {
    async login(username: string, password: string): Promise<User> {
      try {
        const res = await client.post<{ user: SessionUser; token: string }>(
          "/auth/login",
          { username, password }
        );
        localStorage.setItem(TOKEN_KEY, res.token);
        localStorage.setItem(USER_ID_KEY, res.user.id);
        localStorage.setItem(USER_KEY, JSON.stringify(res.user));
        return toUser(res.user);
      } catch (e) {
        // The API returns 401 with the plain text "invalid credentials",
        // which apiClient surfaces as an ApiError.
        if (e instanceof ApiError && e.status === 401) {
          throw new I18nError("invalid_username_or_password");
        }
        throw e;
      }
    },

    async logout(): Promise<void> {
      // Stateless JWT: signing out is just dropping the stored session. The
      // GET cache goes too — its entries were fetched under this session.
      clearSession();
      clearApiCache();
    },

    async getCurrentUser(): Promise<User | null> {
      if (!getToken()) return null;

      try {
        // Never cached: this is the session-validity check. The fresh user
        // also refreshes the persisted copy (group membership can change).
        const me = await client.get<SessionUser>("/auth/me", undefined, { cache: false });
        localStorage.setItem(USER_KEY, JSON.stringify(me));
        return toUser(me);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          clearSession();
          return null;
        }
        throw e;
      }
    },
  };
}
