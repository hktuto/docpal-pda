import { computed, ref, toValue, watch, type MaybeRef, type Ref } from "vue";
import {
  columnOrderingFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnDef,
  type ColumnOrderState,
  type ColumnSizingState,
  type ColumnVisibilityState,
  type PaginationState,
  type SortingState,
  type Updater,
  type VueTable,
} from "@tanstack/vue-table";

/**
 * Column definition for useAdminTable/DataTable. `label` is a plain string —
 * callers pass already-translated labels (a computed array of defs keeps them
 * reactive to locale switches). `accessor` resolves derived/sort values;
 * without it the raw `row[key]` property is used.
 */
export interface AdminColumnDef<T = any> {
  key: string;
  label: string;
  sortable?: boolean;
  accessor?: (row: T) => unknown;
  /** Initial column width in px, before any user resize (persisted resizes win). */
  size?: number;
  minSize?: number;
  maxSize?: number;
  defaultHidden?: boolean;
}

export interface AdminTableOptions<T> {
  /** Persistence identity: state is stored under `admin-table:<tableId>`. */
  tableId: string;
  /**
   * Share column state (sort, sizing, order, visibility) live across table
   * instances with the same key — for pages rendering the same table
   * repeatedly (e.g. per-group tables on receiving detail). Persistence is
   * stored under `admin-table:<syncKey>`; defaults to tableId (no sharing).
   * Pagination and rows always stay per-instance.
   */
  syncKey?: string;
  columns: MaybeRef<AdminColumnDef<T>[]>;
  rows: Ref<T[]>;
  getRowId?: (row: T) => string;
  /** Server mode: sorting/paging are manual and driven by query-param reloads. */
  server?: { total: Ref<number> };
  defaultPageSize?: number;
}

interface ColumnStateRefs {
  sorting: Ref<SortingState>;
  columnSizing: Ref<ColumnSizingState>;
  columnOrder: Ref<ColumnOrderState>;
  columnVisibility: Ref<ColumnVisibilityState>;
}

// Live column-state registry for syncKey sharing (module-level; the admin
// app is SPA-only, so no cross-request leakage).
const columnStateRegistry = new Map<string, ColumnStateRefs>();

// Client processing + column-state features. Server mode reuses the same
// features with manualSorting/manualPagination, which bypass the row models.
const adminTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
    text: sortFn_text,
  },
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
  columnSizingFeature,
  columnResizingFeature,
  columnOrderingFeature,
  columnVisibilityFeature,
});

export type AdminTable<T = any> = VueTable<typeof adminTableFeatures, T>;

interface PersistedTableState {
  sorting?: SortingState;
  sizing?: ColumnSizingState;
  order?: ColumnOrderState;
  visibility?: ColumnVisibilityState;
}

function applyUpdater<T>(updater: Updater<T>, old: T): T {
  return typeof updater === "function" ? (updater as (old: T) => T)(old) : updater;
}

/**
 * Leaf columns in their current visual order (persisted columnOrder applied,
 * with columns missing from the order appended in their natural position).
 * Used by DataTable's column menu for display and reorder controls.
 */
export function orderedLeafColumns(table: AdminTable<any>) {
  const leaf = table.getAllLeafColumns();
  const known = new Set(leaf.map((c) => c.id));
  const ids = (table.atoms.columnOrder?.get() ?? []).filter((id) => known.has(id));
  for (const c of leaf) if (!ids.includes(c.id)) ids.push(c.id);
  return ids.map((id) => leaf.find((c) => c.id === id)!);
}

export function useAdminTable<T>(options: AdminTableOptions<T>) {
  const isServer = !!options.server;
  const defaultPageSize = options.defaultPageSize ?? 20;
  const stateKey = options.syncKey ?? options.tableId;
  const storageKey = `admin-table:${stateKey}`;

  const defaultVisibility = (): ColumnVisibilityState => {
    const visibility: ColumnVisibilityState = {};
    for (const def of toValue(options.columns)) {
      if (def.defaultHidden) visibility[def.key] = false;
    }
    return visibility;
  };

  // Column state (sort/sizing/order/visibility) is shared live between
  // instances with the same stateKey; the first instance creates and
  // persists it. Pagination stays per-instance below.
  let shared = columnStateRegistry.get(stateKey);
  if (!shared) {
    const sorting = ref<SortingState>([]);
    const columnSizing = ref<ColumnSizingState>({});
    const columnOrder = ref<ColumnOrderState>([]);
    const columnVisibility = ref<ColumnVisibilityState>(defaultVisibility());

    // Restore persisted state, dropping entries for columns that no longer exist.
    if (typeof localStorage !== "undefined") {
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          const persisted = JSON.parse(raw) as PersistedTableState;
          const known = new Set(toValue(options.columns).map((d) => d.key));
          if (Array.isArray(persisted.sorting)) {
            sorting.value = persisted.sorting.filter((s) => known.has(s?.id));
          }
          if (persisted.sizing && typeof persisted.sizing === "object") {
            columnSizing.value = Object.fromEntries(
              Object.entries(persisted.sizing).filter(([k, v]) => known.has(k) && typeof v === "number")
            );
          }
          if (Array.isArray(persisted.order)) {
            columnOrder.value = persisted.order.filter((k): k is string => typeof k === "string" && known.has(k));
          }
          if (persisted.visibility && typeof persisted.visibility === "object") {
            for (const [k, v] of Object.entries(persisted.visibility)) {
              if (known.has(k) && typeof v === "boolean") columnVisibility.value[k] = v;
            }
          }
        }
      } catch {
        // Corrupt/legacy value — ignore and start from defaults.
      }
    }

    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    watch(
      [sorting, columnSizing, columnOrder, columnVisibility],
      () => {
        if (typeof localStorage === "undefined") return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          try {
            const state: PersistedTableState = {
              sorting: sorting.value,
              sizing: columnSizing.value,
              order: columnOrder.value,
              visibility: columnVisibility.value,
            };
            localStorage.setItem(storageKey, JSON.stringify(state));
          } catch {
            // Storage unavailable (quota/private mode) — the table still works.
          }
        }, 200);
      },
      { deep: true }
    );

    shared = { sorting, columnSizing, columnOrder, columnVisibility };
    columnStateRegistry.set(stateKey, shared);
  }
  const { sorting, columnSizing, columnOrder, columnVisibility } = shared;
  const pagination = ref<PaginationState>({ pageIndex: 0, pageSize: defaultPageSize });

  const tableColumns = computed<ColumnDef<typeof adminTableFeatures, T, any>[]>(() =>
    toValue(options.columns).map((def) => ({
      id: def.key,
      accessorFn: (row: T) => (def.accessor ? def.accessor(row) : (row as any)[def.key]),
      header: def.label,
      enableSorting: def.sortable !== false,
      // Keep the cycle asc-first for every column (numbers included).
      sortDescFirst: false,
      size: def.size,
      minSize: def.minSize,
      maxSize: def.maxSize,
    }))
  );

  const controlledState = computed(() => ({
    sorting: sorting.value,
    pagination: pagination.value,
    columnSizing: columnSizing.value,
    columnOrder: columnOrder.value,
    columnVisibility: columnVisibility.value,
  }));

  const table = useTable({
    features: adminTableFeatures,
    data: options.rows,
    columns: tableColumns,
    state: controlledState,
    onSortingChange: (u) => {
      sorting.value = applyUpdater(u, sorting.value);
    },
    onPaginationChange: (u) => {
      pagination.value = applyUpdater(u, pagination.value);
    },
    onColumnSizingChange: (u) => {
      columnSizing.value = applyUpdater(u, columnSizing.value);
    },
    onColumnOrderChange: (u) => {
      columnOrder.value = applyUpdater(u, columnOrder.value);
    },
    onColumnVisibilityChange: (u) => {
      columnVisibility.value = applyUpdater(u, columnVisibility.value);
    },
    columnResizeMode: "onChange",
    manualSorting: isServer,
    manualPagination: isServer,
    // Server mode owns paging; client mode resets to page 1 on data changes.
    autoResetPageIndex: !isServer,
    rowCount: isServer ? options.server!.total : undefined,
    getRowId: options.getRowId ? (row: T) => options.getRowId!(row) : undefined,
  });

  function resetColumnState() {
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // Storage unavailable — reset the in-memory state anyway.
      }
    }
    sorting.value = [];
    pagination.value = { pageIndex: 0, pageSize: defaultPageSize };
    columnSizing.value = {};
    columnOrder.value = [];
    columnVisibility.value = defaultVisibility();
    table.resetHeaderSizeInfo(true);
  }

  return { table, sorting, pagination, resetColumnState };
}
