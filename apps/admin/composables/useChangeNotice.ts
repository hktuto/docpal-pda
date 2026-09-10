import { toValue, type MaybeRef } from "vue";

/**
 * "Data changed elsewhere" notice for admin pages. Subscribes to the given
 * SSE event types; when one arrives:
 *  - user is idle → debounced silent reload + a brief "updated" flash;
 *  - user is busy (modal open, rows selected, editing — page supplies `busy`)
 *    → a dismissible banner with a Refresh button, never blocking.
 *
 * Note: the page's own mutations can also trigger these events (e.g. the
 * allocation.finished after our own confirm-arrival) — the extra reload is
 * idempotent and harmless.
 */
export function useChangeNotice(
  types: string[],
  reload: () => void | Promise<void>,
  opts?: { busy?: MaybeRef<boolean> }
) {
  const events = useAdminEvents();
  const pending = ref(false);
  const justUpdated = ref(false);
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  async function doReload(flash: boolean) {
    await reload();
    if (flash) {
      justUpdated.value = true;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        justUpdated.value = false;
      }, 4000);
    }
  }

  function onEvent() {
    if (toValue(opts?.busy)) {
      pending.value = true;
      return;
    }
    // Sync batches emit many events at once — collapse to one reload.
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void doReload(true), 500);
  }

  async function refreshNow() {
    pending.value = false;
    clearTimeout(reloadTimer);
    await doReload(true);
  }

  function dismiss() {
    pending.value = false;
  }

  let unsubs: (() => void)[] = [];
  onMounted(() => {
    unsubs = types.map((type) => events.subscribe(type, onEvent));
  });
  onBeforeUnmount(() => {
    unsubs.forEach((u) => u());
    clearTimeout(reloadTimer);
    clearTimeout(flashTimer);
  });

  return { pending, justUpdated, refreshNow, dismiss };
}
