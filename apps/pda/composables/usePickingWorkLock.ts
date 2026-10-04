import { onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ApiError } from "~/services/apiClient";
import { useWarehouse } from "~/composables/useWarehouse";

const REFRESH_INTERVAL_MS = 3 * 60 * 1000; // backend expires locks 10 min after working_at

/**
 * Page-driven picking work lock (design:
 * docs/superpowers/specs/2026-07-23-picking-priority-allocation-design.md).
 * While the calling page is mounted it holds the server-side lock on the
 * picking order, so allocateAll leaves that order's allocations untouched:
 * acquire on mount, refresh every 3 min, best-effort keepalive release on
 * unmount/pagehide. Moving between the order's detail page and its
 * scan-session page (same order) keeps the lock — both pages hold it.
 *
 * `heldByOther` carries the holder's display name when a 409 lock_held comes
 * back; the page should render read-only in that case.
 */
export function usePickingWorkLock(orderId: string) {
  const warehouse = useWarehouse();
  const router = useRouter();
  const heldByOther = ref<string | null>(null);
  const acquired = ref(false);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function acquire(): Promise<void> {
    try {
      await warehouse.acquirePickingWorkLock(orderId);
      acquired.value = true;
      heldByOther.value = null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.body?.error === "lock_held") {
        acquired.value = false;
        heldByOther.value = typeof e.body.holderName === "string" ? e.body.holderName : "—";
      }
      // Other failures (offline, 5xx): keep the page usable — the next
      // refresh retries.
    }
  }

  function release(): void {
    if (!acquired.value) return;
    acquired.value = false;
    warehouse.releasePickingWorkLock(orderId);
  }

  function onPageHide(): void {
    release();
  }

  onMounted(() => {
    void acquire();
    timer = setInterval(() => void acquire(), REFRESH_INTERVAL_MS);
    window.addEventListener("pagehide", onPageHide);
  });

  onUnmounted(() => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    window.removeEventListener("pagehide", onPageHide);
    // During router navigation currentRoute already points at the target —
    // keep the lock when moving between this order's pages (detail ⇄ scan).
    const target = router.currentRoute.value.path;
    if (target === `/picking/${orderId}` || target === `/picking/scan/${orderId}`) return;
    release();
  });

  return { heldByOther, acquired, refresh: acquire };
}
