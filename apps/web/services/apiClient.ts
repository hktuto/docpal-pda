import { I18nError } from "~/composables/i18nError";
import { getCached, setCached, invalidatePrefix, clearApiCache } from "./apiCache";

/** Plain Error with the HTTP status attached, for errors without an i18n key. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Parsed JSON-object error body, when the server returned one. */
    public body?: Record<string, unknown>
  ) {
    super(message);
  }
}

/**
 * The backend reports domain errors as plain-text snake_case i18n keys
 * (I18N_KEY_PATTERN), which pass through as an I18nError verbatim, whether
 * or not the key exists in the locale files. Structured JSON error bodies
 * (e.g. scan 409 {message, candidates}) surface as an ApiError carrying the
 * parsed body. Anything else becomes an ApiError with the status code.
 */
const I18N_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Parse a response body as a JSON object; returns null for anything else. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON — fall through
  }
  return null;
}

export type QueryParams = Record<
  string,
  string | number | boolean | undefined | null
>;

export interface ApiClientOptions {
  baseUrl: string;
}

export interface ApiClient {
  get<T>(path: string, params?: QueryParams, opts?: { cache?: boolean }): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string, body?: unknown): Promise<T>;
  /** Fire-and-forget DELETE that survives page unload (fetch keepalive).
   *  Used for best-effort releases on page leave; errors are swallowed. */
  keepaliveDel(path: string): void;
}

// Session token wiring: the auth adapter (services/adapters/apiAuth.ts)
// registers a getter once at module load; every apiClient request then sends
// `Authorization: Bearer <token>` when a session exists. Module-level so the
// auth client and the warehouse client share the same token source.
let tokenGetter: (() => string | null) | null = null;

export function setTokenGetter(fn: () => string | null): void {
  tokenGetter = fn;
}

/** localStorage keys holding the session (written by the auth adapter). */
const TOKEN_STORAGE_KEY = "warehouse-token";
const USER_ID_STORAGE_KEY = "warehouse-user-id";
const USER_STORAGE_KEY = "warehouse-user";

/**
 * A 401 means the session is gone/invalid: clear the stored session and send
 * the user back to /login. Skipped for the login call itself (a 401 there is
 * just "invalid credentials" and must surface to the caller) and guarded
 * against redirect loops when already on the login page.
 */
function handleUnauthorized(path: string): void {
  if (path === "/auth/login") return;
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(USER_ID_STORAGE_KEY);
    localStorage.removeItem(USER_STORAGE_KEY);
  } catch {
    // Storage unavailable (tests/SSR) — nothing to clear.
  }
  // Drop every cached GET: responses were fetched under the dead session.
  clearApiCache();
  if (typeof window === "undefined") return;
  if (window.location.pathname === "/login") return;
  // navigateTo is a Nuxt auto-import; fall back to a hard navigation where it
  // is not available (plain vitest runtime).
  if (typeof navigateTo === "function") {
    void navigateTo("/login");
  } else {
    window.location.assign("/login");
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  function buildUrl(path: string, params?: QueryParams): string {
    let url = baseUrl + path;
    if (params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          search.append(key, String(value));
        }
      }
      const qs = search.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  // Local mutations invalidate cached GETs. The own first-path-segment prefix
  // is always invalidated; MUTATION_INVALIDATIONS adds the related read models
  // whose URLs live under a different segment (e.g. scan-to-pick POSTs under
  // /picking-items but the picking detail reads /picking-orders/:id).
  const MUTATION_INVALIDATIONS: Record<string, string[]> = {
    "receiving-orders": ["/put-away", "/stock-search"],
    "receiving-invoice-items": ["/receiving-orders"],
    "picking-orders": ["/measuring-tasks", "/receiving-orders", "/put-away", "/stock-search"],
    "picking-items": ["/picking-orders", "/receiving-orders", "/stock-search"],
    packages: ["/picking-orders", "/measuring-tasks", "/receiving-orders"],
    "shipping-boxes": ["/picking-orders", "/measuring-tasks", "/receiving-orders"],
    "shelf-boxes": ["/put-away", "/receiving-orders", "/stock-search"],
    "put-away-scans": ["/put-away", "/receiving-orders"],
    "measuring-tasks": ["/picking-orders"],
    "goods-verify-tasks": ["/stock-search"],
  };

  function invalidateForMutation(method: string, path: string): void {
    if (method === "GET") return;
    const segment = path.split("/")[1];
    if (!segment) return;
    invalidatePrefix(`/${segment}`);
    for (const extra of MUTATION_INVALIDATIONS[segment] ?? []) {
      invalidatePrefix(extra);
    }
  }

  async function request<T>(
    method: string,
    path: string,
    opts: { params?: QueryParams; body?: unknown } = {}
  ): Promise<T> {
    const init: RequestInit = { method };
    const headers: Record<string, string> = {};
    const token = tokenGetter?.();
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    if (Object.keys(headers).length > 0) {
      init.headers = headers;
    }

    let res: Response;
    try {
      res = await fetch(buildUrl(path, opts.params), init);
    } catch {
      throw new I18nError("network_error");
    }

    if (res.status === 401) {
      handleUnauthorized(path);
      // Always an ApiError (never an I18nError, even when the body is a
      // snake_case word like "unauthorized") so callers can reliably detect
      // an invalid session by status.
      const text = (await res.text()).trim();
      throw new ApiError(text || "unauthorized", res.status);
    }

    if (!res.ok) {
      const text = (await res.text()).trim();
      // Structured JSON error bodies (e.g. scan 409 {message, candidates})
      // surface as an ApiError carrying the parsed body; plain-text
      // snake_case bodies pass through as i18n keys below.
      const body = parseJsonObject(text);
      if (body) {
        const message =
          typeof body.message === "string"
            ? body.message
            : `${res.status}: ${text}`;
        throw new ApiError(message, res.status, body);
      }
      if (I18N_KEY_PATTERN.test(text)) {
        throw new I18nError(text);
      }
      throw new ApiError(`${res.status}: ${text}`, res.status);
    }

    if (res.status === 204) {
      invalidateForMutation(method, path);
      return undefined as T;
    }
    try {
      const data = (await res.json()) as T;
      invalidateForMutation(method, path);
      return data;
    } catch {
      throw new ApiError(`${res.status}: invalid JSON response`, res.status);
    }
  }

  async function get<T>(
    path: string,
    params?: QueryParams,
    opts?: { cache?: boolean }
  ): Promise<T> {
    if (opts?.cache === false) {
      return request<T>("GET", path, { params });
    }
    const url = buildUrl(path, params);
    const hit = getCached<T>(url);
    if (hit !== null) return hit;
    const data = await request<T>("GET", path, { params });
    setCached(url, data);
    return data;
  }

  return {
    get,
    post: <T>(path: string, body?: unknown) =>
      request<T>("POST", path, { body }),
    patch: <T>(path: string, body?: unknown) =>
      request<T>("PATCH", path, { body }),
    del: <T>(path: string, body?: unknown) =>
      request<T>("DELETE", path, { body }),
    keepaliveDel(path: string): void {
      const headers: Record<string, string> = {};
      const token = tokenGetter?.();
      if (token) headers.authorization = `Bearer ${token}`;
      // keepalive lets the request outlive the page (unload/navigation);
      // the response is intentionally not awaited.
      void fetch(buildUrl(path), { method: "DELETE", headers, keepalive: true }).catch(() => {});
    },
  };
}
