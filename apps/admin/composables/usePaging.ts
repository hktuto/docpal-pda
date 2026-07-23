import { computed, ref, watch, type Ref } from "vue";

/**
 * Client-side paging for admin list pages: slice a (filtered) row array and
 * reset to page 1 whenever the source changes (reload/filter).
 */
export function usePaging<T>(source: Ref<T[]>, defaultSize = 20) {
  const page = ref(1);
  const pageSize = ref(defaultSize);
  const total = computed(() => source.value.length);
  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
  const paged = computed(() => {
    const start = (page.value - 1) * pageSize.value;
    return source.value.slice(start, start + pageSize.value);
  });

  watch([source, pageSize], () => {
    page.value = 1;
  });
  // Clamp when the source shrinks under the current page.
  watch(pageCount, (n) => {
    if (page.value > n) page.value = n;
  });

  return { page, pageSize, pageCount, total, paged };
}
