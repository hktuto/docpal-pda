/** Configured API client for the backend admin API (runtimeConfig.public.apiBaseUrl). */
export function useApi(): ApiClient {
  const config = useRuntimeConfig();
  return createApiClient(config.public.apiBaseUrl as string);
}
