import { ref, type Ref } from "vue";

export type SortDir = "asc" | "desc";

/**
 * Clickable column sorting shared by CrudTable and the sub-inventories page:
 * clicking a header cycles none → asc → desc → none; `sortRows` compares
 * numbers numerically and everything else as strings.
 */
export function useColumnSort() {
  const sortKey: Ref<string | null> = ref(null);
  const sortDir: Ref<SortDir> = ref("asc");

  function toggleSort(key: string) {
    if (sortKey.value !== key) {
      sortKey.value = key;
      sortDir.value = "asc";
    } else if (sortDir.value === "asc") {
      sortDir.value = "desc";
    } else {
      sortKey.value = null;
    }
  }

  function sortRows<T>(rows: T[]): T[] {
    if (!sortKey.value) return rows;
    const key = sortKey.value;
    const dir = sortDir.value === "asc" ? 1 : -1;
    return [...rows].sort((a: any, b: any) => {
      const va = a[key];
      const vb = b[key];
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va ?? "").localeCompare(String(vb ?? "")) * dir;
    });
  }

  return { sortKey, sortDir, toggleSort, sortRows };
}
