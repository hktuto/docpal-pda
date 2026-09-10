<template>
  <div>
    <div class="list-toolbar">
      <div class="search-row">
        <input
          v-model="search"
          class="search"
          type="text"
          :placeholder="$t('common.searchByRefPoOrCustomer')"
        />
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
        <button
          type="button"
          class="filter-btn"
          :aria-label="$t('common.refresh')"
          :disabled="loading"
          @click="refresh"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
        </button>
      </div>
    </div>

    <p v-if="loading && rows.length === 0" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: loadError }) }}</p>
    <p v-else-if="reportMessage" class="empty" style="color: #92400e;">{{ reportMessage }}</p>
    <p v-else-if="rows.length === 0" class="empty">{{ $t('common.noPickingOrders') }}</p>

    <div v-else class="list-panel list-panel--clear-bulk-bar">
      <div
        v-for="po in rows"
        :key="po.id"
        class="list-row"
        :class="{ 'list-row--disabled': !isSelectable(po.status) }"
      >
        <input
          v-if="isSelectable(po.status)"
          type="checkbox"
          class="list-row__check"
          :checked="selectedIds.has(po.id)"
          @change="toggleSelection(po.id)"
        />
        <NuxtLink :to="`/picking/${po.id}`" class="list-row__main">
          <div class="list-row__line1">
            <span class="list-row__title">{{ po.orderNo }}</span>
            <span class="badge" :class="badgeClass(po.status)">{{ statusLabel.picking(po.status) }}</span>
            <span v-if="isSelectable(po.status)" class="badge" :class="badgeClass(po.allocationStatus)">
              {{ statusLabel.allocation(po.allocationStatus) }}
            </span>
          </div>
          <div class="list-row__meta">
            {{ [po.customerCode, po.poNo].filter(Boolean).join(' · ') || $t('common.noData') }}
          </div>
        </NuxtLink>
        <div class="list-row__aside">
          <span>{{ po.deliveryDate ? new Date(po.deliveryDate).toLocaleDateString() : $t('common.noDate') }}</span>
          <span v-if="po.workingByName" class="list-row__lock">{{ $t('picking.lockedBy', { name: po.workingByName }) }}</span>
          <span>{{ $t('picking.shipTo', { destination: po.shipTo || $t('common.noData') }) }}</span>
        </div>
        <svg class="list-row__chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
      </div>
    </div>

    <div
      v-if="rows.length > 0"
      class="list-footer"
      :class="{ 'list-footer--clear-bulk-bar': hasSelection }"
    >
      <span class="list-footer__count">{{ $t('common.showingOf', { shown: rows.length, total }) }}</span>
      <button
        v-if="hasMore"
        type="button"
        class="btn btn--small"
        :disabled="loading"
        @click="load(false)"
      >
        {{ $t('common.loadMore') }}
      </button>
    </div>

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
import { useVisibleReload } from "~/composables/useVisibleReload";
import { badgeClass } from "~/composables/useStatusBadge";
import { useWarehouse } from "~/composables/useWarehouse";
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

useHead({ title: t("picking.title") });

const search = ref("");
const PAGE_SIZE = 50;
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

const hasActiveFilter = computed(
  () => filterStatuses.value.length > 0 || filterAllocation.value.length > 0
);

const hasMore = computed(() => rows.value.length < total.value);

function onFilterApply(payload: { statuses: string[]; allocation: string[] }) {
  filterStatuses.value = payload.statuses;
  filterAllocation.value = payload.allocation;
  load(true);
}

function listQuery(limit: number, offset: number): PickingOrderListQuery {
  const term = search.value.trim();
  return {
    status: filterStatuses.value.length > 0 ? filterStatuses.value.join(",") : undefined,
    allocation: filterAllocation.value.length > 0 ? filterAllocation.value.join(",") : undefined,
    search: term || undefined,
    limit,
    offset,
  };
}

async function load(reset: boolean) {
  loading.value = true;
  loadError.value = null;
  reportMessage.value = null;
  try {
    const page = await warehouse.getPickingOrders(
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
  reportMessage.value = null;
  try {
    const page = await warehouse.getPickingOrders(
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

let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => load(true), 300);
});
onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer);
});

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
    await load(true);
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

useVisibleReload(refresh, ["/picking-orders"]);
</script>

<style scoped>
.search-row {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.search-row .search {
  flex: 1;
}

.filter-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.75rem;
  height: 2.75rem;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
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

.filter-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.list-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-top: 0.75rem;
}

.list-footer--clear-bulk-bar {
  margin-bottom: 5rem;
}

.list-footer__count {
  font-size: 0.8125rem;
  color: var(--muted);
}

.list-row__lock {
  font-size: 0.75rem;
  color: #92400e;
  background: #fef3c7;
  border-radius: 4px;
  padding: 0.1rem 0.4rem;
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

.list-panel--clear-bulk-bar {
  margin-bottom: 5rem;
}
</style>
