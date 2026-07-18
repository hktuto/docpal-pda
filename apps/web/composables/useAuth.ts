import { createAuthService } from "~/services/auth";
import type { User } from "~/services/types";

const STORAGE_KEY = "warehouse-user-id";

export function useAuth() {
  const currentUser = useState<User | null>("auth-user", () => null);

  const authService = createAuthService({
    apiBaseUrl: useRuntimeConfig().public.apiBaseUrl as string | undefined,
  });

  async function login(username: string, password: string) {
    const user = await authService.login(username, password);
    currentUser.value = user;
    localStorage.setItem(STORAGE_KEY, user.id);
    return user;
  }

  async function logout() {
    await authService.logout();
    currentUser.value = null;
    localStorage.removeItem(STORAGE_KEY);
  }

  async function restore() {
    const user = await authService.getCurrentUser();
    if (user) {
      currentUser.value = user;
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  return {
    currentUser: readonly(currentUser),
    login,
    logout,
    restore,
  };
}
