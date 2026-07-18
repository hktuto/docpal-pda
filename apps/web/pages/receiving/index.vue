<template>
  <div>
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
    </div>

    <input
      v-model="search"
      class="search"
      type="text"
      :placeholder="$t('common.searchByRefOrSupplier')"
    />

    <p v-if="loading" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: loadError }) }}</p>
    <p v-else-if="rows.length === 0" class="empty">{{ $t('common.noReceivingOrders') }}</p>

    <NuxtLink
      v-for="ro in rows"
      :key="ro.id"
      :to="`/receiving/${ro.id}`"
      class="card list-card"
    >
      <div class="list-card__header">
        <span class="list-card__title">{{ ro.refNo }}</span>
        <span class="badge" :class="badgeClass(ro.status)">{{ statusLabel.receiving(ro.status) }}</span>
      </div>
      <p class="list-card__meta">
        {{ ro.supplierName || $t('common.noSupplier') }}
      </p>
      <div class="list-card__footer">
        <span class="list-card__date">
          {{ ro.deliveryDate ? new Date(ro.deliveryDate).toLocaleDateString() : $t('common.noDate') }}
        </span>
        <span v-if="ro.remainingItems > 0" class="badge badge--info">
          {{ $t('receiving.remaining', { count: ro.remainingItems }) }}
        </span>
        <span
          v-if="ro.pendingPickingOrders > 0"
          class="badge badge--info"
        >
          {{ ro.pendingPickingOrders }} {{ $t('status.picking.picking') }}
        </span>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { badgeClass } from "~/composables/useStatusBadge";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useWarehouse } from "~/composables/useWarehouse";
import type { ReceivingFilter, ReceivingOrderListRow } from "~/services/types";

definePageMeta({ title: "meta.receiving" });

const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();

useHead({ title: t("receiving.title") });

const filters: { labelKey: string; value: ReceivingFilter }[] = [
  { labelKey: "common.all", value: "all" },
  { labelKey: "status.receiving.pending", value: "pending" },
  { labelKey: "status.receiving.provisional_received", value: "provisional_received" },
  { labelKey: "status.receiving.in_hand", value: "in_hand" },
  { labelKey: "status.receiving.clear", value: "clear" },
];

const filter = ref<ReceivingFilter>("in_hand");
const search = ref("");

const rawRows = ref<ReceivingOrderListRow[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    rawRows.value = await warehouse.getReceivingOrders(filter.value);
  } catch (e: any) {
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
      r.refNo.toLowerCase().includes(term) ||
      (r.supplierName?.toLowerCase().includes(term) ?? false)
  );
});

watch(filter, load);
useVisibleReload(load, ["/receiving-orders"]);
</script>

<style scoped>
.filters {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
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

</style>
