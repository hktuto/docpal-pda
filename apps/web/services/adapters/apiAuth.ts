import { I18nError } from "~/composables/i18nError";
import { createApiClient, ApiError } from "../apiClient";
import type { AuthService, CreateAuthServiceOptions } from "../auth";
import type { User, UserRole } from "../types";

const STORAGE_KEY = "warehouse-user-id";

interface AuthUser {
  id: string;
  username: string;
  name: string;
  role: UserRole;
}

function toUser(user: AuthUser): User {
  return {
    id: user.id,
    username: user.username,
    displayName: user.name,
    role: user.role,
    // The API auth payload has no created_at column.
    createdAt: null,
  };
}

export function createApiAuthService(options: CreateAuthServiceOptions): AuthService {
  const client = createApiClient({ baseUrl: options.apiBaseUrl ?? "" });

  return {
    async login(username: string, password: string): Promise<User> {
      try {
        const user = await client.post<AuthUser>("/auth/login", { username, password });
        return toUser(user);
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
      // useAuth clears the localStorage key itself; nothing to do server-side.
    },

    async getCurrentUser(): Promise<User | null> {
      const id = localStorage.getItem(STORAGE_KEY);
      if (!id) return null;

      try {
        return toUser(await client.get<AuthUser>(`/auth/users/${id}`));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          localStorage.removeItem(STORAGE_KEY);
          return null;
        }
        throw e;
      }
    },
  };
}
