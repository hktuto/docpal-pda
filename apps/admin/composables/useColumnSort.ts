import { ref, watch, type Ref } from "vue";

export type SortDir = "asc" | "desc";

/**
 * Clickable column sorting shared by CrudTable and list/detail pages:
 * clicking a header cycles none → asc → desc → none; `sortRows` compares
 * numbers numerically and everything else as strings.
 *
 * Pass a `storageKey` to persist the sort state in localStorage so it
 * survives reloads/navigation; omit it for transient sort (default).
 */
export function useColumnSort(storageKey?: string) {
  const sortKey: Ref<string | null> = ref(null);
  const sortDir: Ref<SortDir> = ref("asc");

  if (storageKey && typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { key?: unknown; dir?: unknown };
        if (typeof parsed.key === "string" && (parsed.dir === "asc" || parsed.dir === "desc")) {
          sortKey.value = parsed.key;
          sortDir.value = parsed.dir;
        }
      }
    } catch {
      // Corrupt/legacy value — ignore and start unsorted.
    }
    watch([sortKey, sortDir], ([key, dir]) => {
      try {
        if (key === null) localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, JSON.stringify({ key, dir }));
      } catch {
        // Storage unavailable (quota/private mode) — sorting still works.
      }
    });
  }

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

  // `getVal` resolves derived/display values for a column; defaults to the
  // raw `row[key]` property lookup.
  function sortRows<T>(rows: T[], getVal?: (row: T, key: string) => unknown): T[] {
    if (!sortKey.value) return rows;
    const key = sortKey.value;
    const dir = sortDir.value === "asc" ? 1 : -1;
    const val = (r: T) => (getVal ? getVal(r, key) : (r as any)[key]);
    return [...rows].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va ?? "").localeCompare(String(vb ?? ""), undefined, { numeric: true }) * dir;
    });
  }

  return { sortKey, sortDir, toggleSort, sortRows };
}
