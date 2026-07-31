import { Capacitor } from "@capacitor/core";

/**
 * Server host picker support. The release APK boots from the bundled assets
 * (origin http://localhost), so the boot plugin, the /server picker page, and
 * public/maintenance.html all share this one localStorage key on that origin.
 * The saved value is the full base URL the WebView should load the app from;
 * the chosen host serves the app with its own matching apiBaseUrl runtime
 * config, so content and API can never drift apart.
 */
export const SERVER_HOST_STORAGE_KEY = "pda-server-host";

export interface ServerHostOption {
  id: string;
  url: string;
}

export const SERVER_HOSTS: ServerHostOption[] = [
  { id: "hk", url: "https://mobile-wms.wclsolution.com:3000" },
  { id: "sz", url: "https://wms-sz.docpal.weltronics.com:3000" },
  { id: "sh", url: "https://wms-sh.docpal.weltronics.com:3000" },
  { id: "gz", url: "https://wms-gz.docpal.weltronics.com:3000" },
  { id: "bj", url: "https://wms-bj.docpal.weltronics.com:3000" },
];

const LOCAL_DEV_HOST: ServerHostOption = { id: "local", url: "http://127.0.0.1:3000" };

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

export function getSavedServerHost(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(SERVER_HOST_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function saveServerHost(url: string) {
  try {
    window.localStorage.setItem(SERVER_HOST_STORAGE_KEY, url);
  } catch {
    /* WebView storage unavailable — picker still navigates */
  }
}

export function clearSavedServerHost() {
  try {
    window.localStorage.removeItem(SERVER_HOST_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Legacy override key written by older maintenance.html builds. */
export const LEGACY_SERVER_HOST_STORAGE_KEY = "pda-server-url-override";

/**
 * The host the boot redirect should use: the picker-saved host, falling back
 * to a legacy maintenance-page override so existing devices keep working.
 */
export function getEffectiveServerHost(): string {
  const saved = getSavedServerHost();
  if (saved) return saved;
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LEGACY_SERVER_HOST_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

/**
 * True when the app is running from the assets bundled into the APK
 * (androidScheme http → http://localhost). Dev live reload serves from
 * 127.0.0.1:3000 and remote hosts serve from their own origin — both false,
 * so neither ever triggers the boot redirect.
 */
export function isBundledOrigin(): boolean {
  return (
    typeof window !== "undefined" &&
    Capacitor.isNativePlatform() &&
    window.location.hostname === "localhost"
  );
}
