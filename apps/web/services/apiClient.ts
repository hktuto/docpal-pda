import { I18nError } from "~/composables/i18nError";

/** Plain Error with the HTTP status attached, for errors without an i18n key. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

/**
 * English error sentences returned by the API mapped to i18n keys under
 * `errors.*`. Only keys that exist in the web locale files are mapped;
 * anything else falls through to an ApiError with the status code.
 * Note: key-shaped API error text (I18N_KEY_PATTERN) passes through as an
 * I18nError verbatim, whether or not the key exists in the locale files.
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
  "shelf box is not closed": "shelf_box_is_not_closed",
  "box has unverified items": "not_all_shelf_box_items_verified",
  "picking order has an open issue": "picking_order_has_open_issue",
  "picking order already finished": "picking_order_already_finished",
  "scan quantity exceeds required": "scan_quantity_exceeds_required",
  "insufficient lot quantity": "insufficient_lot_quantity",
  "package already in a box": "package_already_in_box",
  "box is not empty": "box_is_not_empty",
  "no items to pick": "no_items_to_pick",
  "not all items fully boxed": "not_all_items_fully_boxed",
  "allocation not found": "allocation_not_found",
  "allocation not found in this order": "allocation_not_found",
  "qty exceeds the remaining picking need": "quantity_exceeds_picking_need",
  "qty not available on this receiving order": "quantity_not_available_receiving",
  "picking item part is not on this receiving order":
    "receiving_picking_part_mismatch",
  "all packages must be verified": "all_packages_must_be_verified",
  "weights must be greater than zero": "weights_must_be_greater_than_zero",
  "gross weight must be >= net weight":
    "gross_weight_must_be_greater_than_or_equal_to_net_weight",
  "cannot close an empty box": "cannot_close_empty_shipping_box",
  "all shipping boxes must be closed": "all_shipping_boxes_must_be_closed",
  "picking item not fully packed": "picking_item_not_fully_packed",
  "scan is already in a box": "put_away_scan_already_boxed",
  "scan is not in a box": "put_away_scan_not_boxed",
  "put-away scan not found": "put_away_scan_not_found",
  "cannot close an empty shelf box": "cannot_close_empty_shelf_box",
  "shelf box is not empty": "shelf_box_is_not_empty",
  "verification task not found": "verification_task_not_found",
  "verification task is not pending": "verification_task_is_not_pending",
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
    del: <T>(path: string, params?: QueryParams) =>
      request<T>("DELETE", path, { params }),
    actorId: () => options.getActorId?.(),
  };
}
