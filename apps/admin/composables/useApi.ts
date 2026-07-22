/**
 * Configured API client for the backend admin API (runtimeConfig.public.apiBaseUrl).
 * Attaches the JWT from localStorage (`admin_token`) to every request; on a 401
 * the session is cleared and the user is sent back to /login.
 */
export function useApi(): ApiClient {
  const config = useRuntimeConfig();
  return createApiClient(config.public.apiBaseUrl as string, {
    getToken: () => (import.meta.client ? localStorage.getItem("admin_token") : null),
    onUnauthorized: () => {
      if (!import.meta.client) return;
      localStorage.removeItem("admin_token");
      localStorage.removeItem("admin_user");
      navigateTo("/login");
    },
  });
}
