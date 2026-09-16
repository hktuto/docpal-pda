// Per-user date format preferences for the admin console (spec
// 2026-09-16-admin-date-format-setting-design.md). Module-level reactive store
// so synchronous formatters (formatCell in utils/format.ts) can read the
// current patterns without a composable. Loaded once at app start from
// GET /auth/me/profile and refreshed after saving on the settings page.

import { reactive } from "vue";
import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_DATE_TIME_FORMAT,
  formatWithPattern,
  isDateOnlyString,
  toValidDate,
} from "./dateFormat";
import type { ApiClient } from "./api";

export interface DateFormatPrefs {
  dateFormat: string;
  dateTimeFormat: string;
}

const prefs = reactive<DateFormatPrefs>({
  dateFormat: DEFAULT_DATE_FORMAT,
  dateTimeFormat: DEFAULT_DATE_TIME_FORMAT,
});

export function getDatePrefs(): DateFormatPrefs {
  return prefs;
}

/** Overwrite the store from a /auth/me/profile payload (missing fields keep
 *  the current values). */
export function applyDatePreferences(p: Partial<DateFormatPrefs> | null | undefined): void {
  if (!p) return;
  if (typeof p.dateFormat === "string" && p.dateFormat) prefs.dateFormat = p.dateFormat;
  if (typeof p.dateTimeFormat === "string" && p.dateTimeFormat) prefs.dateTimeFormat = p.dateTimeFormat;
}

/** Fetch the signed-in user's patterns into the store. Call with the app's
 *  API client (useApi) — fire-and-forget at startup is fine. */
export async function loadDatePreferences(api: ApiClient): Promise<void> {
  try {
    const profile = await api.get<DateFormatPrefs>("/auth/me/profile");
    applyDatePreferences(profile);
  } catch {
    // Keep the defaults; a stale/offline backend must not break rendering.
  }
}

/** Format any date-ish cell value with the user's patterns: date-only ISO
 *  strings use the date pattern, everything else the date-time pattern.
 *  Unparseable values are returned unchanged. */
export function formatDate(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const d = toValidDate(value);
  if (!d) return String(value);
  return formatWithPattern(d, isDateOnlyString(value) ? prefs.dateFormat : prefs.dateTimeFormat);
}

/** Force the date-time pattern regardless of the value's shape. */
export function formatDateTime(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const d = toValidDate(value);
  if (!d) return String(value);
  return formatWithPattern(d, prefs.dateTimeFormat);
}
