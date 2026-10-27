import type { LabelingOrderRow } from "~/services/types";

/**
 * Labeling queue list state (spec
 * docs/superpowers/specs/2026-10-28-picking-labeling-step-design.md):
 * search + 50-row load-more paging over GET /labeling-orders, with a
 * visibility/SSE refresh that re-fetches the already-loaded window in one
 * shot (same convention as the picking list).
 */
export function useLabelingOrders() {
  const warehouse = useWarehouse();
  const errorMessage = useErrorMessage();

  const search = ref("");
  const rows = ref<LabelingOrderRow[]>([]);
  const total = ref(0);
  const loading = ref(true);
  const loadError = ref<string | null>(null);

  const PAGE_SIZE = 50;
  const hasMore = computed(() => rows.value.length < total.value);

  function listQuery(limit: number, offset: number) {
    const term = search.value.trim();
    return { search: term || undefined, limit, offset };
  }

  async function load(reset: boolean) {
    loading.value = true;
    loadError.value = null;
    try {
      const page = await warehouse.getLabelingOrders(
        listQuery(PAGE_SIZE, reset ? 0 : rows.value.length)
      );
      rows.value = reset ? page.rows : [...rows.value, ...page.rows];
      total.value = page.total;
    } catch (e) {
      loadError.value = errorMessage(e);
      if (reset) {
        rows.value = [];
        total.value = 0;
      }
    } finally {
      loading.value = false;
    }
  }

  async function refresh() {
    loading.value = true;
    loadError.value = null;
    try {
      const page = await warehouse.getLabelingOrders(
        listQuery(Math.max(rows.value.length, PAGE_SIZE), 0)
      );
      rows.value = page.rows;
      total.value = page.total;
    } catch (e) {
      loadError.value = errorMessage(e);
    } finally {
      loading.value = false;
    }
  }

  return { search, rows, total, loading, loadError, hasMore, load, refresh };
}
