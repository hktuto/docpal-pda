import { setNetworkErrorHandler } from "~/services/apiClient";

const POLL_MS = 20_000;
const FETCH_TIMEOUT_MS = 4_000;

/**
 * Backend reachability watchdog. Pings `${apiBaseUrl}/health` (unauthenticated)
 * on an interval plus on app resume, and exposes `serverDown` for the global
 * maintenance overlay. apiClient also reports fetch-level failures here so a
 * dead server surfaces immediately instead of at the next poll.
 * Module-level singleton — safe to call from multiple components.
 */
const serverDown = ref(false);
const checking = ref(false);
let started = false;

export function useServerHealth() {
  const { public: { apiBaseUrl } } = useRuntimeConfig();

  async function checkServer(): Promise<boolean> {
    if (checking.value) return !serverDown.value;
    checking.value = true;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(`${apiBaseUrl}/health`, { signal: controller.signal });
        serverDown.value = !res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      serverDown.value = true;
    } finally {
      checking.value = false;
    }
    return !serverDown.value;
  }

  function onVisibilityOrFocus() {
    if (document.visibilityState === "visible") void checkServer();
  }

  function start() {
    if (started || typeof window === "undefined") return;
    started = true;
    setNetworkErrorHandler(() => {
      serverDown.value = true;
    });
    void checkServer();
    window.setInterval(() => void checkServer(), POLL_MS);
    document.addEventListener("visibilitychange", onVisibilityOrFocus);
    window.addEventListener("focus", onVisibilityOrFocus);
  }

  return { serverDown, checking, checkServer, start };
}
