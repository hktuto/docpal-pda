export interface ApiClient {
  get: <T = any>(path: string) => Promise<T>;
  post: <T = any>(path: string, body?: unknown) => Promise<T>;
  put: <T = any>(path: string, body?: unknown) => Promise<T>;
  patch: <T = any>(path: string, body?: unknown) => Promise<T>;
  del: <T = any>(path: string) => Promise<T>;
}

export interface ApiClientOptions {
  /** Bearer token attached to every request when present. */
  getToken?: () => string | null;
  /** Called on a 401 response (skipped for /auth/* paths, e.g. failed logins). */
  onUnauthorized?: () => void;
}

/**
 * Plain-fetch JSON client for the admin API. On non-2xx responses it throws an
 * Error whose message is the response body text (the API returns plain-text
 * error bodies, e.g. "code is required"), so callers can surface it as-is.
 */
export function createApiClient(baseUrl: string, opts: ApiClientOptions = {}): ApiClient {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = opts.getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !path.startsWith("/auth/")) {
      opts.onUnauthorized?.();
    }
    if (!res.ok) {
      const text = (await res.text()).trim();
      throw new Error(text || `Request failed (${res.status})`);
    }
    return (await res.json()) as T;
  }
  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    patch: (path, body) => request("PATCH", path, body),
    del: (path) => request("DELETE", path),
  };
}
