<template>
  <div :style="hasSelection ? 'padding-bottom: 5rem;' : undefined">
    <AppListPage
      v-model:search="search"
      search-placeholder="common.searchByRefPoOrCustomer"
      :loading="loading"
      :error="loadError"
      :notice="reportMessage"
      :empty="rows.length === 0"
      empty-text="common.noPickingOrders"
      :shown="rows.length"
      :total="total"
      :has-more="false"
      :reload="load"
      :topics="['/picking-orders']"
      @apply="load"
    >
      <template #toolbar-actions>
        <button
          type="button"
          class="filter-btn"
          :class="{ 'filter-btn--active': hasActiveFilter }"
          :aria-label="$t('picking.filter.title')"
          @click="filterOpen = true"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
          </svg>
          <span v-if="hasActiveFilter" class="filter-btn__dot" aria-hidden="true"></span>
        </button>
      </template>

      <template v-for="group in groupedRows" :key="group.status">
        <h2 class="status-group__title">
          {{ statusLabel.picking(group.status) }}
          <span class="status-group__count">{{ group.rows.length }}</span>
        </h2>
        <AppListRow
          v-for="po in group.rows"
          :key="po.id"
          :to="`/picking/${po.id}`"
          :disabled="!isSelectable(po.status)"
          :title="rowView(po).title"
          :meta="rowMeta(po)"
          :chip-text="rowChip(po)?.text"
          :chip-class="rowChip(po)?.cls"
        >
          <template v-if="isSelectable(po.status)" #leading>
            <input
              type="checkbox"
              class="app-list-row__check"
              :checked="selectedIds.has(po.id)"
              @change="toggleSelection(po.id)"
            />
          </template>
        </AppListRow>
      </template>
    </AppListPage>

    <div v-if="hasSelection" class="bulk-actions">
      <span>{{ $t('common.selectedCount', { count: selectedOrders.length }) }}</span>
      <button class="btn btn--small btn--danger" @click="openModal">
        {{ $t('picking.reportIssue') }}
      </button>
    </div>

    <PickingIssueReportModal
      v-model="modalOpen"
      :orders="selectedOrders"
      :saving="reporting"
      @saved="onReportSaved"
    />

    <PickingFilterModal
      v-model="filterOpen"
      :statuses="filterStatuses"
      :allocation="filterAllocation"
      @apply="onFilterApply"
    />
  </div>
</template>

<script setup lang="ts">
import { useWarehouse } from "~/composables/useWarehouse";
import { viewListChip, viewListRow } from "~/utils/viewConfig";
import PickingFilterModal from "~/components/picking/PickingFilterModal.vue";
import PickingIssueReportModal from "~/components/PickingIssueReportModal.vue";
import type {
  PickingOrderListRow,
  PickingOrderListQuery,
  PickingIssueReason,
  ReportPickingIssueEntry,
} from "~/services/types";

definePageMeta({ title: "meta.picking" });

const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
// Row title/meta/chip come from the warehouse's pdaViewConfig flow config
// (spec 2026-10-04-pda-app-rewrite-design.md); on a backend without the key
// the legacy listTemplates + the extra meta line + work-lock chip render.
const { viewConfig, viewConfigLoaded, renderChip } = useViewConfig();
const rowView = (po: PickingOrderListRow) => viewListRow("picking", po, viewConfig.value);
function rowMeta(po: PickingOrderListRow): string[] {
  const meta = rowView(po).meta;
  return viewConfigLoaded.value ? meta : [...meta, rowExtra(po)];
}
function rowChip(po: PickingOrderListRow) {
  if (!viewConfigLoaded.value) {
    return po.workingByName
      ? { text: t("picking.lockedBy", { name: po.workingByName }), cls: "badge--pending" }
      : null;
  }
  return renderChip(viewListChip("picking", po, viewConfig.value));
}

useHead({ title: t("picking.title") });

const search = ref("");
const rows = ref<PickingOrderListRow[]>([]);
const total = ref(0);
const loading = ref(true);
const loadError = ref<string | null>(null);
const reportMessage = ref<string | null>(null);
const selectedIds = ref<Set<string>>(new Set());
const modalOpen = ref(false);
const reporting = ref(false);
const filterOpen = ref(false);
// Applied list filters; an empty array means "no filter" for that group.
const filterStatuses = ref<string[]>([]);
const filterAllocation = ref<string[]>([]);

// The PDA only ever shows confirmed work: statuses at/after `allocated`
// (pending/skip/issue/shipped stay admin-only). An empty status filter
// falls back to this set rather than "no filter".
const PDA_VISIBLE_STATUSES = ["allocated", "picking", "finished"];

// The list renders as one section per status (all matching rows are fetched
// so every section is complete); this is the section display order:
// in-progress work first, then orders ready to pick, then completed.
const STATUS_GROUP_ORDER = ["picking", "allocated", "finished"];

const hasActiveFilter = computed(
  () => filterStatuses.value.length > 0 || filterAllocation.value.length > 0
);

const groupedRows = computed(() => {
  const byStatus = new Map<string, PickingOrderListRow[]>();
  for (const row of rows.value) {
    const list = byStatus.get(row.status);
    if (list) list.push(row);
    else byStatus.set(row.status, [row]);
  }
  const rank = (status: string) => {
    const index = STATUS_GROUP_ORDER.indexOf(status);
    return index === -1 ? STATUS_GROUP_ORDER.length : index;
  };
  return [...byStatus.keys()]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((status) => ({ status, rows: byStatus.get(status)! }));
});

// The old aside carried the delivery date / ship-to; the single-column row
// puts them on the second meta line. The work lock becomes the inline chip.
function rowExtra(po: PickingOrderListRow): string {
  const date = po.deliveryDate ? new Date(po.deliveryDate).toLocaleDateString() : t("common.noDate");
  return `${date} · ${t("picking.shipTo", { destination: po.shipTo || t("common.noData") })}`;
}

function onFilterApply(payload: { statuses: string[]; allocation: string[] }) {
  filterStatuses.value = payload.statuses;
  filterAllocation.value = payload.allocation;
  load();
}

function listQuery(): PickingOrderListQuery {
  const term = search.value.trim();
  return {
    status: (filterStatuses.value.length > 0 ? filterStatuses.value : PDA_VISIBLE_STATUSES).join(","),
    allocation: filterAllocation.value.length > 0 ? filterAllocation.value.join(",") : undefined,
    search: term || undefined,
  };
}

async function load() {
  loading.value = true;
  loadError.value = null;
  reportMessage.value = null;
  try {
    const page = await warehouse.getPickingOrders(listQuery());
    rows.value = page.rows;
    total.value = page.total;
  } catch (e) {
    loadError.value = errorMessage(e);
    rows.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

const selectedOrders = computed(() =>
  rows.value
    .filter((r) => selectedIds.value.has(r.id))
    .map((r) => ({ id: r.id, orderNo: r.orderNo, totalQty: r.totalQty }))
);

const hasSelection = computed(() => selectedOrders.value.length > 0);

function isSelectable(status: string) {
  return status !== "finished" && status !== "issue" && status !== "shipped";
}

function toggleSelection(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selectedIds.value = next;
}

function openModal() {
  if (!hasSelection.value) return;
  modalOpen.value = true;
}

async function onReportSaved(payload: {
  reason: PickingIssueReason;
  qty: number | null;
  packSize: number | null;
  note: string | null;
  remarks: Record<string, string>;
}) {
  reporting.value = true;
  try {
    // The dialog's shared fields apply to every selected order; only the
    // remark is per-order.
    const entries: ReportPickingIssueEntry[] = selectedOrders.value.map((o) => ({
      pickingOrderId: o.id,
      reason: payload.reason,
      qty: payload.qty,
      packSize: payload.packSize,
      note: payload.note,
      remark: payload.remarks[o.id]?.trim() || null,
    }));
    const result = await warehouse.reportPickingOrderIssues(entries);
    selectedIds.value = new Set();
    modalOpen.value = false;
    await load();
    if (result.reported.length > 0) {
      reportMessage.value = t('picking.issueReportSummary', {
        reported: result.reported.length,
        skipped: result.skipped.length,
      });
    }
  } catch (e) {
    loadError.value = errorMessage(e);
  } finally {
    reporting.value = false;
  }
}
</script>

<style scoped>
.filter-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.75rem;
  height: 2.75rem;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
}

.filter-btn--active {
  color: var(--primary);
  border-color: var(--primary);
}

.filter-btn__dot {
  position: absolute;
  top: 0.35rem;
  right: 0.35rem;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--primary);
}

.status-group__title {
  display: flex;
  align-items: center;
  padding: 0.35rem 0.75rem;
  gap: 0.5rem;
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--muted);
  margin: 0;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}

.status-group__count {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 9999px;
  padding: 0 0.5rem;
  font-size: 0.75rem;
  line-height: 1.25rem;
}

.app-list-row__check {
  width: 1.25rem;
  height: 1.25rem;
  flex-shrink: 0;
  accent-color: var(--primary);
}

.bulk-actions {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--surface);
  border-top: 1px solid var(--border);
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.06);
}
</style>
