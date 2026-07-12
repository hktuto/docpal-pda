import { I18nError } from "~/composables/i18nError";

/**
 * English error sentences returned by the API mapped to i18n keys under
 * `errors.*`. Only keys that exist in the web locale files are mapped;
 * anything else falls through to a plain Error with the status code.
 */
const ERROR_KEY_MAP: Record<string, string> = {
  "shipping box not found": "shipping_box_not_found",
  "shelf box not found": "shelf_box_not_found",
  "receiving order not found": "receiving_order_not_found",
  "picking order not found": "picking_order_not_found",
  "measuring task not found": "measuring_task_not_found",
  "box is not open": "box_is_not_open",
  "package already verified": "package_already_verified",
  "package not found": "package_not_found",
  "package is not in a box": "package_not_in_shipping_box",
  "measuring task is not pending": "measuring_task_is_not_pending",
  "no unverified scans for part in box": "shelf_box_item_not_found",
  "shelf box is not open": "shelf_box_is_not_open",
  "box has unverified items": "not_all_shelf_box_items_verified",
};

const I18N_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

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
  del<T>(path: string, params?: QueryParams): Promise<T>;
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
      if (I18N_KEY_PATTERN.test(text)) {
        throw new I18nError(text);
      }
      const key = ERROR_KEY_MAP[text];
      if (key) {
        throw new I18nError(key);
      }
      throw new Error(`${res.status}: ${text}`);
    }

    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  return {
    get: <T>(path: string, params?: QueryParams) =>
      request<T>("GET", path, { params }),
    post: <T>(path: string, body?: unknown) =>
      request<T>("POST", path, { body }),
    patch: <T>(path: string, body?: unknown) =>
      request<T>("PATCH", path, { body }),
    del: <T>(path: string, params?: QueryParams) =>
      request<T>("DELETE", path, { params }),
    actorId: () => options.getActorId?.(),
  };
}
