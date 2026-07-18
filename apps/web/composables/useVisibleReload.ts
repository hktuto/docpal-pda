import { useWarehouseEvents } from "~/composables/useWarehouseEvents";

/**
 * Reload on mount and when the app regains visibility/focus (Capacitor has no
 * live-query support). With `topics`, the mounted page also subscribes to
 * matching server events (useWarehouseEvents) and reloads when one arrives;
 * the subscription is dropped on unmount.
 */
export function useVisibleReload(load: () => void | Promise<void>, topics?: string[]) {
  async function onVisible() {
    if (document.visibilityState === "visible") {
      await load();
    }
  }

  const events = topics?.length ? useWarehouseEvents() : null;
  let unsubscribe: (() => void) | undefined;

  onMounted(() => {
    load();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    if (events && topics) {
      unsubscribe = events.subscribe(topics, load);
    }
  });

  onUnmounted(() => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    unsubscribe?.();
  });
}
