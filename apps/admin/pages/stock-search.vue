<script setup lang="ts">
import type { StockSearchLot, StockSearchOptions, StockSearchParams, StockSearchResult, StockSearchSummary } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

const api = useApi();
const flow = useFlowApi();
const { t } = useI18n();

const suppliers = ref<{ id: string; code: string; name: string }[]>([]);
const options = ref<StockSearchOptions | null>(null);

// Filters (empty array = no filter / all).
const supplierCode = ref<string[]>([]);
const brand = ref<string[]>([]);
const orgId = ref<string[]>([]);
const subInventoryCode = ref<string[]>([]);
const zone = ref<string[]>([]);
const shelfCode = ref<string[]>([]);
const partNo = ref("");
const drawingNo = ref("");

// Date-code range (WWYY): native date pickers converted to WWYY codes, same
// pattern as the picking availability modal (utils/dateCode.ts).
const dcFrom = ref("");
const dcTo = ref("");
const dcFromDate = computed(() => (dcFrom.value ? new Date(`${dcFrom.value}T00:00:00`) : null));
const dcToDate = computed(() => (dcTo.value ? new Date(`${dcTo.value}T00:00:00`) : null));
const dcFromCode = computed(() => (dcFromDate.value ? dateToDateCode(dcFromDate.value) : ""));
const dcToCode = computed(() => (dcToDate.value ? dateToDateCode(dcToDate.value) : ""));
const dcActive = computed(() => !!dcFromDate.value || !!dcToDate.value);

const result = ref<StockSearchResult | null>(null);
const summary = ref<StockSearchSummary | null>(null);
const searched = ref(false);
const loading = ref(false);
const error = ref("");

// Ungrouped mode is server-paged: lotsRows/lotsTotal come from the paged
// endpoint; group-by mode keeps the legacy full fetch in `result`.
const lotsRows = ref<StockSearchLot[]>([]);
const lotsTotal = ref(0);

// --- filter dropdown options (from /stock-search/options + /admin/suppliers) ---

const supplierOptions = computed<SearchableSelectOption[]>(() =>
  suppliers.value.map((s) => ({ value: s.code, label: `${s.code} — ${s.name}` }))
);
const brandOptions = computed<SearchableSelectOption[]>(() =>
  (options.value?.brands ?? []).map((b) => ({ value: b, label: b }))
);
// org_id → dropdown label: org_info.office_code, falling back to the org id.
const orgLabels = computed(() => {
  const m = new Map<number, string>();
  for (const l of options.value?.locations ?? []) {
    if (l.orgId === null || m.has(l.orgId)) continue;
    m.set(l.orgId, l.officeCode ?? String(l.orgId));
  }
  return m;
});
const orgOptions = computed<SearchableSelectOption[]>(() =>
  [...orgLabels.value.entries()]
    .sort(([a], [b]) => a - b)
    .map(([o, label]) => ({ value: String(o), label }))
);
// Grouped by org (contiguous per backend ORDER BY org_id, code). The same
// sub-inventory code can exist in several orgs — it appears once per org and
// every occurrence shares the same checkbox state (the filter value is the
// code alone).
const subInventoryOptions = computed<SearchableSelectOption[]>(() => {
  const out: SearchableSelectOption[] = [];
  for (const l of options.value?.locations ?? []) {
    if (l.orgId === null || !l.subInventoryCode) continue;
    if (orgId.value.length && !orgId.value.includes(String(l.orgId))) continue;
    out.push({
      value: l.subInventoryCode,
      label: l.description ? `${l.subInventoryCode} — ${l.description}` : l.subInventoryCode,
      group: orgLabels.value.get(l.orgId) ?? String(l.orgId),
    });
  }
  return out;
});
const zoneOptions = computed<SearchableSelectOption[]>(() =>
  (options.value?.zones ?? []).map((z) => ({ value: z, label: z }))
);
const shelfOptions = computed<SearchableSelectOption[]>(() =>
  (options.value?.shelves ?? [])
    .filter((s) => !zone.value.length || (s.zone !== null && zone.value.includes(s.zone)))
    .map((s) => ({ value: s.code, label: s.zone ? `${s.code} — ${s.zone}` : s.code }))
);

// Prune dependent selections when the parent filter no longer contains them.
watch(orgId, () => {
  const valid = new Set(subInventoryOptions.value.map((o) => o.value));
  const next = subInventoryCode.value.filter((v) => valid.has(v));
  if (next.length !== subInventoryCode.value.length) subInventoryCode.value = next;
});
watch(zone, () => {
  const valid = new Set(shelfOptions.value.map((o) => o.value));
  const next = shelfCode.value.filter((v) => valid.has(v));
  if (next.length !== shelfCode.value.length) shelfCode.value = next;
});

// --- group-by (lots table): none / brand / shelf / zone ----------------------

type GroupBy = "none" | "brand" | "shelf" | "zone";
const GROUP_BY_STORAGE_KEY = "admin-group:stock-search";
const groupBy = ref<GroupBy>("none");

const groupByOptions = computed<SearchableSelectOption[]>(() => [
  { value: "none", label: t("admin.pages.stockSearch.groupNone") },
  { value: "brand", label: t("admin.pages.stockSearch.groupBrand") },
  { value: "shelf", label: t("admin.pages.stockSearch.groupShelf") },
  { value: "zone", label: t("admin.pages.stockSearch.groupZone") },
]);

if (typeof localStorage !== "undefined") {
  const stored = localStorage.getItem(GROUP_BY_STORAGE_KEY);
  if (stored === "none" || stored === "brand" || stored === "shelf" || stored === "zone") {
    groupBy.value = stored;
  }
  watch(groupBy, (v) => {
    try {
      localStorage.setItem(GROUP_BY_STORAGE_KEY, v);
    } catch {
      // Storage unavailable — grouping still works.
    }
  });
}

interface LotGroup {
  key: string;
  lots: StockSearchLot[];
}

const lotGroups = computed<LotGroup[]>(() => {
  if (groupBy.value === "none") return [];
  const keyOf = (l: StockSearchLot) =>
    groupBy.value === "brand" ? l.brand : groupBy.value === "shelf" ? (l.shelfCode ?? "") : (l.zone ?? "");
  const buckets = new Map<string, StockSearchLot[]>();
  for (const l of result.value?.lots ?? []) {
    const k = keyOf(l);
    const arr = buckets.get(k);
    if (arr) arr.push(l);
    else buckets.set(k, [l]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, lots]) => ({ key, lots }));
});

// --- tables -------------------------------------------------------------------

const lotsColumnDefs = computed<AdminColumnDef<StockSearchLot>[]>(() => [
  {
    key: "partNo",
    label: t("admin.pages.stockSearch.partNo"),
    accessor: (l) => l.wclItemNo ?? l.partNo,
    size: 150,
  },
  {
    key: "description",
    label: t("admin.pages.stockSearch.description"),
    accessor: (l) => l.description ?? "",
    size: 200,
  },
  { key: "brand", label: t("admin.pages.stockSearch.brand"), size: 80 },
  {
    key: "dateCode",
    label: t("admin.pages.stockSearch.dateCode"),
    accessor: (l) => l.dateCode ?? "",
    size: 100,
  },
  {
    key: "lotCode",
    label: t("admin.pages.stockSearch.lotCode"),
    accessor: (l) => l.lotCode ?? "",
    size: 110,
  },
  {
    key: "drawingNo",
    label: t("admin.pages.stockSearch.drawingNo"),
    accessor: (l) => l.drawingNo ?? "",
    size: 110,
  },
  {
    key: "shelfCode",
    label: t("admin.pages.stockSearch.shelf"),
    accessor: (l) => l.shelfCode ?? "",
    size: 90,
  },
  {
    key: "zone",
    label: t("admin.pages.stockSearch.zone"),
    accessor: (l) => l.zone ?? "",
    size: 70,
  },
  {
    key: "boxId",
    label: t("admin.pages.stockSearch.box"),
    accessor: (l) => l.boxId ?? "",
    size: 100,
  },
  {
    key: "orgSubInventory",
    label: t("admin.pages.stockSearch.orgSubInventory"),
    accessor: (l) => `${l.orgId ?? "—"} / ${l.subInventoryCode ?? "—"}`,
    size: 130,
  },
  { key: "totalQty", label: t("admin.pages.stockSearch.totalQty"), size: 90 },
  { key: "allocatedQty", label: t("admin.pages.stockSearch.allocatedQty"), size: 100 },
  { key: "availableQty", label: t("admin.pages.stockSearch.availableQty"), size: 100 },
]);

const {
  table: lotsTable,
  sorting: lotsSorting,
  pagination: lotsPagination,
  resetColumnState: resetLotsColumns,
} = useAdminTable({
  tableId: "stock-search-lots",
  columns: lotsColumnDefs,
  rows: lotsRows,
  server: { total: lotsTotal },
});

// Grouped mode: one DataTable per group, lazily created and cached by group
// key (same idiom as receiving detail). syncKey shares sort/column state
// across all group tables and with the ungrouped lots table. Groups render
// all their rows (no Pager), so pageSize stays large.
type GroupTable = ReturnType<typeof useAdminTable<StockSearchLot>>;
const groupTables = new Map<string, GroupTable>();

function tableForGroup(key: string): GroupTable {
  let inst = groupTables.get(key);
  if (!inst) {
    inst = useAdminTable<StockSearchLot>({
      tableId: "stock-search-lots",
      syncKey: "stock-search-lots",
      columns: lotsColumnDefs,
      rows: computed(() => lotGroups.value.find((g) => g.key === key)?.lots ?? []),
      defaultPageSize: 1000,
    });
    groupTables.set(key, inst);
  }
  return inst;
}

// Pager uses a 1-based page; the table uses a 0-based pageIndex.
const lotsPage = computed({
  get: () => lotsPagination.value.pageIndex + 1,
  set: (v: number) => {
    lotsPagination.value = { ...lotsPagination.value, pageIndex: v - 1 };
  },
});
const lotsPageSize = computed({
  get: () => lotsPagination.value.pageSize,
  set: (v: number) => {
    lotsPagination.value = { pageIndex: 0, pageSize: v };
  },
});

async function loadSuppliers() {
  try {
    suppliers.value = await api.get("/admin/suppliers");
  } catch {
    suppliers.value = [];
  }
}

async function loadOptions() {
  try {
    options.value = await flow.stockSearchOptions();
  } catch {
    options.value = null;
  }
}

// Summary header totals — follows the current search filters ({} = overall).
async function loadSummary(params: StockSearchParams = {}) {
  try {
    summary.value = await flow.stockSearchSummary(params);
  } catch {
    summary.value = null;
  }
}

function currentFilters(): StockSearchParams {
  return {
    supplierCode: supplierCode.value.length ? supplierCode.value : undefined,
    brand: brand.value.length ? brand.value : undefined,
    orgId: orgId.value.length ? orgId.value.map(Number) : undefined,
    subInventoryCode: subInventoryCode.value.length ? subInventoryCode.value : undefined,
    zone: zone.value.length ? zone.value : undefined,
    shelfCode: shelfCode.value.length ? shelfCode.value : undefined,
    partNo: partNo.value.trim() || undefined,
    drawingNo: drawingNo.value.trim() || undefined,
    dateCodeFrom: dcFromCode.value || undefined,
    dateCodeTo: dcToCode.value || undefined,
  };
}

// Sort params for the paged endpoint from the shared table sorting state.
function sortParams(): { sort?: string; dir?: "asc" | "desc" } {
  const sort = lotsSorting.value[0];
  return sort ? { sort: sort.id, dir: sort.desc ? "desc" : "asc" } : {};
}

// Refetch the current server page with the current filters/sort. No-op
// outside ungrouped mode (the sorting/page state is shared with the
// client-side group tables).
async function reloadPage() {
  if (!searched.value || groupBy.value !== "none") return;
  const res = await flow.stockSearchPage({
    ...currentFilters(),
    page: lotsPage.value,
    pageSize: lotsPagination.value.pageSize,
    ...sortParams(),
  });
  lotsRows.value = res.rows;
  lotsTotal.value = res.total;
}

watch([lotsPage, lotsPageSize], reloadPage);
watch(lotsSorting, () => {
  if (!searched.value || groupBy.value !== "none") return;
  if (lotsPage.value !== 1) lotsPage.value = 1; // the page watcher refetches
  else reloadPage();
});
// Mode switch refetches in the right mode (server-paged vs full client-side).
watch(groupBy, () => {
  if (searched.value) search();
});

async function search() {
  loading.value = true;
  error.value = "";
  try {
    const filters = currentFilters();
    if (groupBy.value === "none") {
      result.value = null;
      await loadSummary(filters);
      searched.value = true;
      // Reset to page 1 — the page watcher refetches; when already on page 1,
      // fetch directly.
      if (lotsPage.value !== 1) lotsPage.value = 1;
      else await reloadPage();
    } else {
      const [res] = await Promise.all([flow.stockSearch(filters), loadSummary(filters)]);
      result.value = res;
      searched.value = true;
    }
    // Stock may have changed — refresh the dropdown option sets too.
    loadOptions();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

// Export ALL lots matching the current filters (ignoring paging/grouping) as
// .xlsx — same columns and labels as the lots table. Group mode reuses the
// full fetch already in `result`; server mode does a full fetch at export
// time.
async function exportExcel() {
  if (!searched.value) return;
  const lots = groupBy.value !== "none" ? (result.value?.lots ?? []) : (await flow.stockSearch(currentFilters())).lots;
  if (!lots.length) return;
  const XLSX = await import("xlsx");
  const cols = lotsColumnDefs.value;
  const aoa = [
    cols.map((c) => c.label),
    ...lots.map((l) =>
      cols.map((c) => (c.accessor ? c.accessor(l) : (((l as Record<string, unknown>)[c.key] as string | number | null) ?? "")))
    ),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, t("admin.pages.stockSearch.lots"));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  XLSX.writeFile(wb, `stock-search-${stamp}.xlsx`);
}

onMounted(() => {
  loadSuppliers();
  loadOptions();
  loadSummary();
});

// Re-run the current search when stock levels change elsewhere. No-op until
// the user has searched at least once.
const {
  pending: changePending,
  justUpdated: changeUpdated,
  refreshNow,
  dismiss,
} = useChangeNotice(["allocation.computed", "put_away_task.completed"], async () => {
  if (searched.value) await search();
  else await loadSummary();
});
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.stockSearch.title") }}</h1>
    </div>

    <div v-if="summary" class="summary">
      <div class="summary-card">
        <span class="summary-label">{{ $t("admin.pages.stockSearch.summaryItems") }}</span>
        <span class="summary-value">{{ summary.partCount.toLocaleString() }}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">{{ $t("admin.pages.stockSearch.summaryOnHandQty") }}</span>
        <span class="summary-value">{{ summary.totalQty.toLocaleString() }}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">{{ $t("admin.pages.stockSearch.summaryAllocatedQty") }}</span>
        <span class="summary-value">{{ summary.allocatedQty.toLocaleString() }}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">{{ $t("admin.pages.stockSearch.summaryAvailableQty") }}</span>
        <span class="summary-value">{{ summary.availableQty.toLocaleString() }}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">{{ $t("admin.pages.stockSearch.summaryOutdatedItems", { years: summary.outdatedYears }) }}</span>
        <span class="summary-value">{{ summary.outdatedPartCount.toLocaleString() }}</span>
        <span class="summary-note">{{
          $t("admin.pages.stockSearch.summaryOutdatedNote", {
            lots: summary.outdatedLotCount.toLocaleString(),
            qty: summary.outdatedQty.toLocaleString(),
          })
        }}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">{{ $t("admin.pages.stockSearch.summaryLots") }}</span>
        <span class="summary-value">{{ summary.lotCount.toLocaleString() }}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">{{ $t("admin.pages.stockSearch.summaryShelves") }}</span>
        <span class="summary-value">{{ summary.shelfCount.toLocaleString() }}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">{{ $t("admin.pages.stockSearch.summaryLastUpdate") }}</span>
        <span class="summary-value summary-date">{{ formatDateTime(summary.lastUpdateDate) }}</span>
      </div>
    </div>

    <div class="filters">
      <SearchableSelect
        v-model="supplierCode"
        :options="supplierOptions"
        :all-label="$t('admin.pages.stockSearch.allSuppliers')"
        :aria-label="$t('admin.pages.stockSearch.supplier')"
        class="filter-item"
      />
      <SearchableSelect
        v-model="brand"
        :options="brandOptions"
        :all-label="$t('admin.pages.stockSearch.allBrands')"
        :aria-label="$t('admin.pages.stockSearch.brand')"
        class="filter-item"
      />
      <SearchableSelect
        v-model="orgId"
        :options="orgOptions"
        :all-label="$t('admin.pages.stockSearch.allOrgs')"
        :aria-label="$t('admin.pages.stockSearch.org')"
        class="filter-item filter-narrow"
      />
      <SearchableSelect
        v-model="subInventoryCode"
        :options="subInventoryOptions"
        :all-label="$t('admin.pages.stockSearch.allSubInventories')"
        :aria-label="$t('admin.pages.stockSearch.subInventory')"
        class="filter-item"
      />
      <SearchableSelect
        v-model="zone"
        :options="zoneOptions"
        :all-label="$t('admin.pages.stockSearch.allZones')"
        :aria-label="$t('admin.pages.stockSearch.zone')"
        class="filter-item filter-narrow"
      />
      <SearchableSelect
        v-model="shelfCode"
        :options="shelfOptions"
        :all-label="$t('admin.pages.stockSearch.allShelves')"
        :aria-label="$t('admin.pages.stockSearch.shelf')"
        class="filter-item"
      />
      <input
        v-model="partNo"
        :placeholder="$t('admin.pages.stockSearch.partNoPlaceholder')"
        @keyup.enter="search"
      />
      <input
        v-model="drawingNo"
        :placeholder="$t('admin.pages.stockSearch.drawingNoPlaceholder')"
        @keyup.enter="search"
      />
      <label class="dc-filter">
        {{ $t("admin.pages.stockSearch.dateCodeFrom") }}
        <input v-model="dcFrom" type="date" />
        <span v-if="dcFromCode" class="muted">{{ dcFromCode }}</span>
      </label>
      <label class="dc-filter">
        {{ $t("admin.pages.stockSearch.dateCodeTo") }}
        <input v-model="dcTo" type="date" />
        <span v-if="dcToCode" class="muted">{{ dcToCode }}</span>
      </label>
      <button v-if="dcActive" class="btn btn-small" @click="dcFrom = ''; dcTo = ''">
        {{ $t("admin.pages.stockSearch.dateCodeClear") }}
      </button>
      <SearchableSelect
        v-model="groupBy"
        :options="groupByOptions"
        :all-label="$t('admin.pages.stockSearch.groupBy')"
        :aria-label="$t('admin.pages.stockSearch.groupBy')"
        :multiple="false"
        :show-all="false"
      />
      <button class="btn btn-primary" :disabled="loading" @click="search">
        {{ $t("admin.common.search") }}
      </button>
      <button class="btn" :disabled="loading || !searched" @click="exportExcel">
        {{ $t("admin.pages.stockSearch.exportExcel") }}
      </button>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <ChangeNotice :pending="changePending" :just-updated="changeUpdated" @refresh="refreshNow" @dismiss="dismiss" />
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>
    <p v-else-if="!searched" class="muted">{{ $t("admin.pages.stockSearch.hint") }}</p>

    <template v-else-if="searched">
      <h2 v-if="groupBy !== 'none'" class="section-title">{{ $t("admin.pages.stockSearch.lots") }}</h2>
      <template v-if="groupBy === 'none'">
        <DataTable
          :table="lotsTable"
          :empty-text="$t('admin.pages.stockSearch.noLots')"
          :on-reset-columns="resetLotsColumns"
        >
          <template #cell-description="{ row }">
            <span class="wrap">{{ row.description ?? "—" }}</span>
          </template>
        </DataTable>
        <Pager v-model:page="lotsPage" v-model:page-size="lotsPageSize" :total="lotsTotal" />
      </template>
      <template v-else>
        <template v-for="g in lotGroups" :key="g.key">
          <h3 class="group-title">
            {{ g.key || "—" }}
            <span class="muted">— {{ $t("admin.pages.stockSearch.lotsCount", { count: g.lots.length }) }}</span>
          </h3>
          <DataTable
            :table="tableForGroup(g.key).table"
            sync-scroll-key="stock-search-lots"
            :empty-text="$t('admin.pages.stockSearch.noLots')"
            :on-reset-columns="tableForGroup(g.key).resetColumnState"
          >
            <template #cell-description="{ row }">
              <span class="wrap">{{ row.description ?? "—" }}</span>
            </template>
          </DataTable>
        </template>
        <p v-if="lotGroups.length === 0" class="muted">{{ $t("admin.pages.stockSearch.noLots") }}</p>
      </template>
    </template>
  </div>
</template>

<style scoped>
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.625rem;
  margin-bottom: 0.875rem;
}
.summary-card {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: 0.5rem 0.875rem;
  border: 1px solid #d9e2ec;
  border-radius: 0.375rem;
  background: #f8fafc;
  min-width: 6.875rem;
}
.summary-label {
  font-size: 0.6875rem;
  color: #7b8794;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.summary-value {
  font-size: 1.125rem;
  font-weight: 600;
  color: #243b53;
}
.summary-date {
  font-size: 0.8125rem;
  font-weight: 500;
  align-self: flex-end;
  margin-top: auto;
}
.summary-note {
  font-size: 0.6875rem;
  color: #7b8794;
}
.dc-filter {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.8125rem;
  color: #52606d;
}
.dc-filter input[type="date"] {
  padding: 0.25rem 0.375rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  font-size: 0.8125rem;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.625rem;
  margin-bottom: 0.75rem;
}
.filters input {
  flex: 1;
  min-width: 10rem;
}
.filter-item {
  width: 11.875rem;
}
.filter-narrow {
  width: 7.5rem;
}
.section-title {
  font-size: 0.9375rem;
  margin: 1.125rem 0 0.5rem;
  color: #52606d;
}
.group-title {
  font-size: 0.875rem;
  margin: 0.875rem 0 0.25rem;
  color: #37424e;
}
.wrap {
  white-space: normal;
}
</style>
