/**
 * Backend server picker support. The APK is built with `server.url` pointing
 * at the one fixed web host (see scripts/build-android-apk.mjs), so the
 * Capacitor bridge — injected natively for exactly that origin — always works
 * and hardware scanning keeps functioning. The /server picker therefore only
 * chooses which BACKEND the app calls: the saved value is an API base URL
 * applied by getApiBaseUrl() everywhere (apiClient, health check, SSE).
 *
 * Older APKs stored a WEB host URL (:3000/:3103) under the same key for the
 * retired boot redirect; those values are invalid as API base URLs and are
 * discarded on read so the device falls back to the picker.
 */
export const SERVER_HOST_STORAGE_KEY = "pda-server-host";

export interface ServerHostOption {
  id: string;
  url: string;
}

export const SERVER_HOSTS: ServerHostOption[] = [
  { id: "hk", url: "http://192.168.1.132:3002" },
  { id: "sz", url: "http://192.168.5.116:9002" },
  { id: "sh", url: "http://192.168.5.116:9002" },
  { id: "gz", url: "http://192.168.5.116:9002" },
  { id: "bj", url: "http://192.168.5.116:9002" },
];

const LOCAL_DEV_HOST: ServerHostOption = { id: "local", url: "http://127.0.0.1:3002" };

// The local entry shows automatically under the Nuxt dev server
// (import.meta.dev), or in bundled builds generated with
// NUXT_PUBLIC_SHOW_LOCAL_SERVER_HOST=1 (on-device development against a
// local backend via adb reverse).
function showLocalServerHost(): boolean {
  if (import.meta.dev) return true;
  try {
    return Boolean(useRuntimeConfig().public.showLocalServerHost);
  } catch {
    return false; // outside Nuxt (unit tests)
  }
}

export function getServerHostOptions(): ServerHostOption[] {
  return showLocalServerHost() ? [...SERVER_HOSTS, LOCAL_DEV_HOST] : SERVER_HOSTS;
}

/** Web-host ports written by the retired boot-redirect builds — not API URLs. */
const STALE_WEB_HOST_PORT = /:(3000|3103)$/;

export function getSavedServerHost(): string {
  if (typeof window === "undefined") return "";
  try {
    const saved = window.localStorage.getItem(SERVER_HOST_STORAGE_KEY) || "";
    if (saved && STALE_WEB_HOST_PORT.test(saved)) {
      window.localStorage.removeItem(SERVER_HOST_STORAGE_KEY);
      return "";
    }
    return saved;
  } catch {
    return "";
  }
}

export function saveServerHost(url: string) {
  try {
    window.localStorage.setItem(SERVER_HOST_STORAGE_KEY, url);
  } catch {
    /* WebView storage unavailable */
  }
}

export function clearSavedServerHost() {
  try {
    window.localStorage.removeItem(SERVER_HOST_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The API base URL the app should call: the picker-saved backend, falling
 * back to the build-time runtime config default.
 */
export function getApiBaseUrl(): string {
  const saved = getSavedServerHost();
  if (saved) return saved;
  try {
    return (useRuntimeConfig().public.apiBaseUrl as string) || "";
  } catch {
    return ""; // outside Nuxt (unit tests)
  }
}

// Backend-scoped state cleared on a backend switch so nothing leaks across
// environments: the session (token belongs to the old backend), the SWR GET
// cache, and the SSE event cursor. The locale preference is kept.
const SESSION_KEYS = ["warehouse-token", "warehouse-user-id", "warehouse-user"];
const API_CACHE_PREFIX = "wms-cache:";
const SSE_CURSOR_KEY = "wms-events-last-id";

export function switchServerHost(url: string) {
  saveServerHost(url);
  try {
    for (const key of SESSION_KEYS) window.localStorage.removeItem(key);
    window.localStorage.removeItem(SSE_CURSOR_KEY);
    const cacheKeys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(API_CACHE_PREFIX)) cacheKeys.push(key);
    }
    for (const key of cacheKeys) window.localStorage.removeItem(key);
  } catch {
    /* WebView storage unavailable — the new host is still saved */
  }
}
