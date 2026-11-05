import { useWarehouseEvents } from "~/composables/useWarehouseEvents";

/**
 * Reload on mount and when the app regains visibility (Capacitor has no
 * live-query support). With `topics`, the mounted page also subscribes to
 * matching server events (useWarehouseEvents) and reloads when one arrives;
 * the subscription is dropped on unmount.
 *
 * SSE-triggered reloads are trailing-debounced (500 ms, same shape as the
 * admin useChangeNotice): one confirm-arrival emits allocation.computed plus
 * several *order.updated events, and each used to fire its own full reload
 * (audit 2026-11-06 #7). The old duplicate `focus` listener is dropped —
 * Android resume fires it alongside visibilitychange, doubling every
 * background→foreground refetch.
 */
export function useVisibleReload(load: () => void | Promise<void>, topics?: string[]) {
  async function onVisible() {
    if (document.visibilityState === "visible") {
      await load();
    }
  }

  const events = topics?.length ? useWarehouseEvents() : null;
  let unsubscribe: (() => void) | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function debouncedLoad() {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void load();
    }, 500);
  }

  onMounted(() => {
    load();
    document.addEventListener("visibilitychange", onVisible);
    if (events && topics) {
      unsubscribe = events.subscribe(topics, debouncedLoad);
    }
  });

  onUnmounted(() => {
    document.removeEventListener("visibilitychange", onVisible);
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    unsubscribe?.();
  });
}
