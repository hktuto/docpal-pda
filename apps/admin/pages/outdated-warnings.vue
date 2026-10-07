<script setup lang="ts">
import type { OutdatedWarningRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

// Supplier outdated date-code scan warnings (spec
// docs/superpowers/specs/2026-10-07-supplier-outdated-datecode-warning-design.md).
// Resolution is whole-order: one action stamps every unresolved warning of the
// order and completes it when it was held at completion.
const flow = useFlowApi();
const { t } = useI18n();

// State/order-kind filter server-side; supplier filter client-side (the list
// endpoint has no supplier param). Pending by default.
const resolvedFilter = ref("false"); // "false" | "true" | "" (all)
const orderKind = ref(""); // "" | "picking" | "putaway"
const suppliers = ref<string[]>([]);

// Deep links (order detail warning chips land on ?orderKind=picking).
useUrlQueryState({
  resolved: { state: resolvedFilter, defaultValue: "false" },
  orderKind: { state: orderKind, defaultValue: "" },
});

const resolvedOptions = computed<SearchableSelectOption[]>(() => [
  { value: "false", label: t("admin.pages.outdatedWarnings.statePending") },
  { value: "true", label: t("admin.pages.outdatedWarnings.stateResolved") },
]);
const orderKindOptions = computed<SearchableSelectOption[]>(() => [
  { value: "picking", label: t("admin.pages.outdatedWarnings.kindPicking") },
  { value: "putaway", label: t("admin.pages.outdatedWarnings.kindPutaway") },
]);

const rows = ref<OutdatedWarningRow[]>([]);
const loading = ref(true);
const error = ref("");
const notice = ref("");

const supplierOptions = computed<SearchableSelectOption[]>(() => {
  const seen = new Map<string, string>();
  for (const r of rows.value) {
    if (!seen.has(r.supplierCode)) {
      seen.set(r.supplierCode, r.supplierName ? `${r.supplierCode} — ${r.supplierName}` : r.supplierCode);
    }
  }
  return [...seen.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, label]) => ({ value, label }));
});

const filteredRows = computed(() =>
  suppliers.value.length === 0 ? rows.value : rows.value.filter((r) => suppliers.value.includes(r.supplierCode))
);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = await flow.listOutdatedWarnings({
      resolved: resolvedFilter.value === "" ? undefined : resolvedFilter.value === "true",
      orderKind: (orderKind.value || undefined) as "picking" | "putaway" | undefined,
    });
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

watch([resolvedFilter, orderKind], load);

const columnDefs = computed<AdminColumnDef<OutdatedWarningRow>[]>(() => [
  {
    key: "orderKind",
    label: t("admin.pages.outdatedWarnings.flow"),
    accessor: (r) => t(r.orderKind === "picking" ? "admin.pages.outdatedWarnings.kindPicking" : "admin.pages.outdatedWarnings.kindPutaway"),
    size: 90,
  },
  {
    key: "orderNo",
    label: t("admin.pages.outdatedWarnings.order"),
    accessor: (r) => r.orderNo ?? "",
    size: 160,
  },
  {
    key: "partNo",
    label: t("admin.pages.outdatedWarnings.part"),
    accessor: (r) => r.wclItemNo ?? r.partNo ?? "",
    size: 150,
  },
  {
    key: "supplier",
    label: t("admin.pages.outdatedWarnings.supplier"),
    accessor: (r) => r.supplierName ?? r.supplierCode,
    size: 160,
  },
  { key: "dateCode", label: t("admin.pages.outdatedWarnings.dateCode"), size: 90 },
  { key: "limitMonths", label: t("admin.pages.outdatedWarnings.limit"), size: 90 },
  { key: "qty", label: t("admin.pages.outdatedWarnings.qty"), accessor: (r) => r.qty ?? "", size: 70 },
  {
    key: "scannedBy",
    label: t("admin.pages.outdatedWarnings.scannedBy"),
    accessor: (r) => r.scannedByName ?? r.scannedBy,
    size: 120,
  },
  {
    key: "scannedAt",
    label: t("admin.pages.outdatedWarnings.scannedAt"),
    accessor: (r) => r.scannedAt,
    size: 150,
  },
  {
    key: "state",
    label: t("admin.pages.outdatedWarnings.state"),
    accessor: (r) => (r.resolvedAt ? t("admin.pages.outdatedWarnings.stateResolved") : t("admin.pages.outdatedWarnings.statePending")),
    size: 90,
  },
  {
    key: "resolution",
    label: t("admin.pages.outdatedWarnings.resolution"),
    accessor: (r) => (r.resolvedAt ? `${r.resolvedByName ?? r.resolvedBy ?? ""} ${r.resolutionNote ?? ""}` : ""),
    size: 200,
  },
]);

const { table, resetColumnState } = useAdminTable({
  tableId: "outdated-warnings",
  columns: columnDefs,
  rows: filteredRows,
  getRowId: (r) => r.id,
  defaultPageSize: 50,
});

function orderLink(r: OutdatedWarningRow): string | null {
  if (r.orderKind === "picking") return `/picking-orders/${r.orderId}`;
  if (r.orderKind === "putaway") return `/receiving/${r.orderId}`;
  return null;
}

// Resolve dialog: one row's "Resolve order" resolves the WHOLE order.
const resolveRow = ref<OutdatedWarningRow | null>(null);
const resolveNote = ref("");
const resolveError = ref("");
const resolving = ref(false);
const resolveDismiss = useOverlayDismiss(() => (resolveRow.value = null));

const pendingCountForResolve = computed(() =>
  resolveRow.value
    ? rows.value.filter((r) => r.orderKind === resolveRow.value!.orderKind && r.orderId === resolveRow.value!.orderId && !r.resolvedAt).length
    : 0
);

function openResolve(r: OutdatedWarningRow) {
  resolveRow.value = r;
  resolveNote.value = "";
  resolveError.value = "";
}

async function submitResolve() {
  const r = resolveRow.value;
  if (!r || resolving.value) return;
  resolving.value = true;
  resolveError.value = "";
  try {
    const res = await flow.resolveOrderOutdatedWarnings(r.orderKind, r.orderId, resolveNote.value);
    resolveRow.value = null;
    await load();
    notice.value = t("admin.pages.outdatedWarnings.resolvedDone", { count: res.resolved, orderNo: r.orderNo ?? r.orderId });
    setTimeout(() => (notice.value = ""), 8000);
  } catch (e: any) {
    resolveError.value = e.message;
  } finally {
    resolving.value = false;
  }
}

onMounted(load);

// Live updates: new/resolved warnings elsewhere (PDA scans, other admins).
const changeBusy = computed(() => resolveRow.value !== null);
const {
  pending: changePending,
  justUpdated: changeUpdated,
  refreshNow,
  dismiss,
} = useChangeNotice(["outdated.warning.created", "outdated.warning.resolved"], load, { busy: changeBusy });
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.outdatedWarnings.title") }}</h1>
    </div>

    <div class="filters">
      <SearchableSelect
        v-model="resolvedFilter"
        :options="resolvedOptions"
        :all-label="$t('admin.pages.outdatedWarnings.allStates')"
        :aria-label="$t('admin.pages.outdatedWarnings.state')"
        :multiple="false"
        class="filter-item"
      />
      <SearchableSelect
        v-model="orderKind"
        :options="orderKindOptions"
        :all-label="$t('admin.pages.outdatedWarnings.allKinds')"
        :aria-label="$t('admin.pages.outdatedWarnings.flow')"
        :multiple="false"
        class="filter-item"
      />
      <SearchableSelect
        v-model="suppliers"
        :options="supplierOptions"
        :all-label="$t('admin.pages.outdatedWarnings.allSuppliers')"
        :aria-label="$t('admin.pages.outdatedWarnings.supplier')"
        class="filter-item"
      />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="notice" class="notice-banner">{{ notice }}</div>
    <ChangeNotice :pending="changePending" :just-updated="changeUpdated" @refresh="refreshNow" @dismiss="dismiss" />
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <DataTable
      v-else
      :table="table"
      :empty-text="$t('admin.pages.outdatedWarnings.none')"
      :on-reset-columns="resetColumnState"
    >
      <template #cell-orderKind="{ row }">
        {{ $t(row.orderKind === "picking" ? "admin.pages.outdatedWarnings.kindPicking" : "admin.pages.outdatedWarnings.kindPutaway") }}
      </template>
      <template #cell-orderNo="{ row }">
        <NuxtLink v-if="orderLink(row)" :to="orderLink(row)!">{{ row.orderNo ?? row.orderId }}</NuxtLink>
        <span v-else>{{ row.orderNo ?? row.orderId }}</span>
      </template>
      <template #cell-partNo="{ row }">
        {{ row.wclItemNo ?? row.partNo }}
        <div v-if="row.wclItemNo && row.partNo && row.partNo !== row.wclItemNo" class="muted sub-line">{{ row.partNo }}</div>
      </template>
      <template #cell-supplier="{ row }">
        {{ row.supplierName ?? row.supplierCode }}
        <div v-if="row.supplierName" class="muted sub-line">{{ row.supplierCode }}</div>
      </template>
      <template #cell-scannedAt="{ row }">{{ formatDateTime(row.scannedAt) }}</template>
      <template #cell-state="{ row }">
        <span class="state-badge" :class="row.resolvedAt ? 'state-resolved' : 'state-pending'">
          {{ row.resolvedAt ? $t("admin.pages.outdatedWarnings.stateResolved") : $t("admin.pages.outdatedWarnings.statePending") }}
        </span>
      </template>
      <template #cell-resolution="{ row }">
        <template v-if="row.resolvedAt">
          <div>{{ row.resolvedByName ?? row.resolvedBy }} · {{ formatDateTime(row.resolvedAt) }}</div>
          <div v-if="row.resolutionNote" class="muted sub-line wrap">{{ row.resolutionNote }}</div>
        </template>
        <span v-else class="muted">—</span>
      </template>
      <template #actions="{ row }">
        <button v-if="!row.resolvedAt" class="btn btn-small btn-primary" @click="openResolve(row)">
          {{ $t("admin.pages.outdatedWarnings.resolveOrder") }}
        </button>
      </template>
    </DataTable>

    <div v-if="resolveRow" class="overlay" @mousedown="resolveDismiss.onMousedown" @click="resolveDismiss.onClick">
      <div class="dialog">
        <h2>
          {{ $t("admin.pages.outdatedWarnings.resolveTitle", { orderNo: resolveRow.orderNo ?? resolveRow.orderId }) }}
        </h2>
        <p class="muted">{{ $t("admin.pages.outdatedWarnings.resolveHint", { count: pendingCountForResolve }) }}</p>
        <div v-if="resolveError" class="error-banner">{{ resolveError }}</div>
        <form @submit.prevent="submitResolve">
          <div class="form-row">
            <label for="ow-note">{{ $t("admin.pages.outdatedWarnings.note") }}</label>
            <input
              id="ow-note"
              v-model="resolveNote"
              type="text"
              :placeholder="$t('admin.pages.outdatedWarnings.notePlaceholder')"
            />
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn" @click="resolveRow = null">{{ $t("admin.common.cancel") }}</button>
            <button type="submit" class="btn btn-primary" :disabled="resolving">
              {{ resolving ? $t("admin.common.saving") : $t("admin.pages.outdatedWarnings.resolveSubmit") }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.625rem;
  margin-bottom: 0.75rem;
}
.filter-item {
  width: 12.5rem;
}
.notice-banner {
  margin-bottom: 0.75rem;
  padding: 0.5625rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.875rem;
  background: #e9f7ef;
  border: 1px solid #b5e2c8;
  color: #1e7a46;
}
.sub-line {
  font-size: 0.75rem;
}
.wrap {
  white-space: normal;
}
.state-badge {
  display: inline-block;
  padding: 0.0625rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
}
.state-pending {
  background: #fdf3d7;
  border: 1px solid #e8c96a;
  color: #8a6d1a;
}
.state-resolved {
  background: #e9f7ef;
  border: 1px solid #b5e2c8;
  color: #1e7a46;
}
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 32, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.dialog {
  background: #fff;
  border-radius: 0.5rem;
  box-shadow: 0 12px 32px rgba(15, 23, 32, 0.25);
  padding: 1.25rem;
  width: 26rem;
  max-width: calc(100vw - 2rem);
}
.dialog h2 {
  margin: 0 0 0.375rem;
  font-size: 1.0625rem;
}
.dialog .form-row {
  margin-top: 0.75rem;
}
.dialog .form-row input {
  width: 100%;
  padding: 0.4375rem 0.5625rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  font-size: 0.875rem;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.625rem;
  margin-top: 1.125rem;
}
</style>
