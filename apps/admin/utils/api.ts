export interface ApiClient {
  get: <T = any>(path: string) => Promise<T>;
  post: <T = any>(path: string, body?: unknown) => Promise<T>;
  patch: <T = any>(path: string, body?: unknown) => Promise<T>;
  del: <T = any>(path: string) => Promise<T>;
}

/**
 * Plain-fetch JSON client for the admin API. On non-2xx responses it throws an
 * Error whose message is the response body text (the API returns plain-text
 * error bodies, e.g. "code is required"), so callers can surface it as-is.
 */
export function createApiClient(baseUrl: string): ApiClient {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = (await res.text()).trim();
      throw new Error(text || `Request failed (${res.status})`);
    }
    return (await res.json()) as T;
  }
  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
    del: (path) => request("DELETE", path),
  };
}
