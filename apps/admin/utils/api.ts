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

// No request may hang forever — a half-open TCP connection neither resolves
// nor rejects, so the spinner would wait out the day (audit 2026-11-06 #3).
// 30 s is far above every normal admin call (xlsx exports are generated in
// the browser, not by this client).
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Plain-fetch JSON client for the admin API. On non-2xx responses it throws an
 * Error whose message is the response body text (the API returns plain-text
 * error bodies, e.g. "code is required"), so callers can surface it as-is.
 */
export function createApiClient(baseUrl: string, opts: ApiClientOptions = {}): ApiClient {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    // Backend task-queue routes drop the assignee filter for admin-console
    // callers (BUG-042); see visibilityUsername in the backend auth middleware.
    headers["X-Client"] = "admin";
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = opts.getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401 && !path.startsWith("/auth/")) {
      opts.onUnauthorized?.();
    }
    if (!res.ok) {
      const text = (await res.text()).trim();
      throw new Error(text || `Request failed (${res.status})`);
    }
    // Empty 200/204 bodies are valid ("ok" writes); res.json() on "" would
    // throw a SyntaxError and surface a success as a failure
    // (audit 2026-11-06 #9).
    const text = await res.text();
    return (text ? (JSON.parse(text) as T) : (undefined as T));
  }
  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    patch: (path, body) => request("PATCH", path, body),
    del: (path) => request("DELETE", path),
  };
}
