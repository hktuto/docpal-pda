import { createAuthService } from "~/services/auth";
import { getStoredUser } from "~/services/adapters/apiAuth";
import { getApiBaseUrl } from "~/utils/serverHost";
import type { User } from "~/services/types";

// The session (warehouse-token + warehouse-user-id + warehouse-user) lives in
// localStorage, owned by the auth adapter (services/adapters/apiAuth.ts).
export function useAuth() {
  const currentUser = useState<User | null>("auth-user", () => null);

  const authService = createAuthService({
    apiBaseUrl: getApiBaseUrl(),
  });

  async function login(username: string, password: string) {
    const user = await authService.login(username, password);
    currentUser.value = user;
    return user;
  }

  async function logout() {
    await authService.logout();
    currentUser.value = null;
  }

  async function restore() {
    // Seed synchronously from the persisted session user so group membership
    // (groupCodes) is available before the /auth/me round-trip resolves…
    const stored = getStoredUser();
    if (stored) {
      currentUser.value = {
        ...stored,
        createdDate: stored.createdDate ? new Date(stored.createdDate) : null,
      };
    }
    // …then validate against the server; refreshes groups and clears the
    // session on 401.
    currentUser.value = await authService.getCurrentUser();
  }

  /** True when the current user belongs to the given group. */
  function hasGroup(code: string): boolean {
    return currentUser.value?.groupCodes.includes(code) ?? false;
  }

  return {
    currentUser: readonly(currentUser),
    login,
    logout,
    restore,
    hasGroup,
  };
}
