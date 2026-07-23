<template>
  <div>
    <input
      v-model="search"
      class="search"
      type="text"
      :placeholder="$t('common.searchByRefPoOrCustomer')"
    />

    <p v-if="loading" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: loadError }) }}</p>
    <p v-else-if="reportMessage" class="empty" style="color: #92400e;">{{ reportMessage }}</p>
    <p v-else-if="rows.length === 0" class="empty">{{ $t('common.noPickingOrders') }}</p>

    <div
      v-for="po in rows"
      :key="po.id"
      class="card list-card"
      :class="{ 'card--disabled': !isSelectable(po.status) }"
    >
      <div class="list-card__header">
        <div style="display: flex; align-items: flex-start; gap: 0.75rem; flex: 1;">
          <input
            v-if="isSelectable(po.status)"
            type="checkbox"
            :checked="selectedIds.has(po.id)"
            @change="toggleSelection(po.id)"
          />
          <NuxtLink :to="`/picking/${po.id}`" class="list-card__title">
            {{ po.orderNo }}
          </NuxtLink>
        </div>
        <span class="badge" :class="badgeClass(po.status)">{{ statusLabel.picking(po.status) }}</span>
      </div>
      <p class="list-card__meta">
        {{ [po.customerCode, po.poNo].filter(Boolean).join(' · ') || $t('common.noData') }}
      </p>
      <div class="list-card__footer">
        <span class="list-card__date">
          {{ po.deliveryDate ? new Date(po.deliveryDate).toLocaleDateString() : $t('common.noDate') }}
        </span>
        <span v-if="po.workingByName" class="list-card__lock">{{ $t('picking.lockedBy', { name: po.workingByName }) }}</span>
        <span class="list-card__ship">{{ $t('picking.shipTo', { destination: po.shipTo || $t('common.noData') }) }}</span>
      </div>
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
  </div>
</template>

<script setup lang="ts">
import { useVisibleReload } from "~/composables/useVisibleReload";
import { badgeClass } from "~/composables/useStatusBadge";
import { useWarehouse } from "~/composables/useWarehouse";
import type {
  PickingOrderListRow,
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
const rawRows = ref<PickingOrderListRow[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const reportMessage = ref<string | null>(null);
const selectedIds = ref<Set<string>>(new Set());
const modalOpen = ref(false);
const reporting = ref(false);

async function load() {
  loading.value = true;
  loadError.value = null;
  reportMessage.value = null;
  try {
    rawRows.value = await warehouse.getPickingOrders();
  } catch (e) {
    loadError.value = errorMessage(e);
    rawRows.value = [];
  } finally {
    loading.value = false;
  }
}

const rows = computed(() => {
  const term = search.value.trim().toLowerCase();
  if (!term) return rawRows.value;
  return rawRows.value.filter(
    (r) =>
      r.orderNo.toLowerCase().includes(term) ||
      (r.poNo?.toLowerCase().includes(term) ?? false) ||
      (r.customerCode?.toLowerCase().includes(term) ?? false)
  );
});

const selectedOrders = computed(() =>
  rawRows.value
    .filter((r) => selectedIds.value.has(r.id))
    .map((r) => ({ id: r.id, orderNo: r.orderNo, totalQty: r.totalQty }))
);

const hasSelection = computed(() => selectedOrders.value.length > 0);

function isSelectable(status: string) {
  return status !== "finished" && status !== "issue";
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

useVisibleReload(load, ["/picking-orders"]);
</script>

<style scoped>
.list-card__title:hover {
  text-decoration: underline;
}

.list-card__ship {
  margin-left: auto;
  font-size: 0.8125rem;
  color: var(--muted);
}

.list-card__lock {
  font-size: 0.8125rem;
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

.card--disabled {
  opacity: 0.65;
}

.list-card:last-child {
  margin-bottom: 5rem;
}
</style>
