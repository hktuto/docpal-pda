import { I18nError } from "~/composables/i18nError";

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
  getActorId?: () => string | undefined;
}

export interface ApiClient {
  get<T>(path: string, params?: QueryParams): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string, body?: unknown): Promise<T>;
  actorId(): string | undefined;
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

  async function request<T>(
    method: string,
    path: string,
    opts: { params?: QueryParams; body?: unknown } = {}
  ): Promise<T> {
    const init: RequestInit = { method };
    if (opts.body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(buildUrl(path, opts.params), init);
    } catch {
      throw new I18nError("network_error");
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
      return undefined as T;
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new ApiError(`${res.status}: invalid JSON response`, res.status);
    }
  }

  return {
    get: <T>(path: string, params?: QueryParams) =>
      request<T>("GET", path, { params }),
    post: <T>(path: string, body?: unknown) =>
      request<T>("POST", path, { body }),
    patch: <T>(path: string, body?: unknown) =>
      request<T>("PATCH", path, { body }),
    del: <T>(path: string, body?: unknown) =>
      request<T>("DELETE", path, { body }),
    actorId: () => options.getActorId?.(),
  };
}
