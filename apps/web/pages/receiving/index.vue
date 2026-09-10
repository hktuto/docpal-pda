<template>
  <div>
    <div class="list-toolbar">
      <div class="filters">
        <button
          v-for="opt in filters"
          :key="opt.value"
          class="filter-chip"
          :class="{ 'filter-chip--active': filter === opt.value }"
          @click="filter = opt.value"
        >
          {{ $t(opt.labelKey) }}
        </button>
        <button
          type="button"
          class="refresh-btn"
          :aria-label="$t('common.refresh')"
          :disabled="loading"
          @click="refresh"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
        </button>
      </div>

      <input
        v-model="search"
        class="search"
        type="text"
        :placeholder="$t('common.searchByRefOrSupplier')"
      />
    </div>

    <p v-if="loading && rows.length === 0" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: loadError }) }}</p>
    <p v-else-if="rows.length === 0" class="empty">{{ $t('common.noReceivingOrders') }}</p>

    <div v-else class="list-panel">
      <NuxtLink
        v-for="ro in rows"
        :key="ro.id"
        :to="`/receiving/${ro.id}`"
        class="list-row"
      >
        <div class="list-row__main">
          <div class="list-row__line1">
            <span class="list-row__title">{{ ro.batchNo }}</span>
          </div>
          <div class="list-row__meta">
            {{ ro.supplierName || $t('common.noSupplier') }}
            · {{ ro.deliveryDate ? new Date(ro.deliveryDate).toLocaleDateString() : $t('common.noDate') }}
          </div>
        </div>
        <div class="list-row__aside">
          <span class="badge" :class="badgeClass(ro.status)">{{ statusLabel.receiving(ro.status) }}</span>
          <span v-if="ro.remainingItems > 0" class="badge badge--info">
            {{ $t('receiving.remaining', { count: ro.remainingItems }) }}
          </span>
          <span v-if="ro.pendingPickingOrders > 0" class="badge badge--info">
            {{ ro.pendingPickingOrders }} {{ $t('status.picking.picking') }}
          </span>
        </div>
        <svg class="list-row__chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
      </NuxtLink>
    </div>

    <div v-if="rows.length > 0" class="list-footer">
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
  </div>
</template>

<script setup lang="ts">
import { badgeClass } from "~/composables/useStatusBadge";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useWarehouse } from "~/composables/useWarehouse";
import type { ReceivingFilter, ReceivingOrderListQuery, ReceivingOrderListRow } from "~/services/types";

definePageMeta({ title: "meta.receiving" });

const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();

useHead({ title: t("receiving.title") });

const filters: { labelKey: string; value: ReceivingFilter }[] = [
  { labelKey: "common.all", value: "all" },
  { labelKey: "status.receiving.pending", value: "pending" },
  // { labelKey: "status.receiving.provisional_received", value: "provisional_received" },
  { labelKey: "status.receiving.in_hand", value: "in_hand" },
  { labelKey: "status.receiving.clear", value: "clear" },
];

const filter = ref<ReceivingFilter>("pending");
const search = ref("");

const PAGE_SIZE = 50;
const rows = ref<ReceivingOrderListRow[]>([]);
const total = ref(0);
const loading = ref(true);
const loadError = ref<string | null>(null);
const hasMore = computed(() => rows.value.length < total.value);

function listQuery(limit: number, offset: number): ReceivingOrderListQuery {
  const term = search.value.trim();
  return { search: term || undefined, limit, offset };
}

async function load(reset: boolean) {
  loading.value = true;
  loadError.value = null;
  try {
    const page = await warehouse.getReceivingOrders(
      filter.value,
      listQuery(PAGE_SIZE, reset ? 0 : rows.value.length)
    );
    rows.value = reset ? page.rows : [...rows.value, ...page.rows];
    total.value = page.total;
  } catch (e: any) {
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
    const page = await warehouse.getReceivingOrders(
      filter.value,
      listQuery(Math.max(rows.value.length, PAGE_SIZE), 0)
    );
    rows.value = page.rows;
    total.value = page.total;
  } catch (e: any) {
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

watch(filter, () => load(true));
useVisibleReload(refresh, ["/receiving-orders"]);
</script>

<style scoped>
.filters {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  overflow-x: auto;
  padding-bottom: 0.25rem;
}

.filter-chip {
  flex-shrink: 0;
  padding: 0.45rem 1rem;
  font-size: 0.8125rem;
  font-weight: 600;
  border: 1px solid var(--border);
  border-radius: 9999px;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.filter-chip--active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}

.refresh-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  border: 1px solid var(--border);
  border-radius: 9999px;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
}

.refresh-btn:disabled {
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

.list-footer__count {
  font-size: 0.8125rem;
  color: var(--muted);
}

</style>
