<template>
  <AppListPage
    v-model:search="search"
    search-placeholder="internalTransfer.pda.searchPlaceholder"
    :apply-on-search="false"
    :loading="loading"
    :error="loadError"
    :empty="visibleRows.length === 0"
    empty-text="internalTransfer.pda.noTasks"
    :shown="visibleRows.length"
    :total="visibleRows.length"
    :has-more="false"
    hide-footer
    :reload="load"
    :topics="['/internal-transfer-orders']"
  >
    <template #header>
      <p class="page-hint">{{ $t('internalTransfer.pda.hint') }}</p>
    </template>

    <AppListRow
      v-for="row in visibleRows"
      :key="row.id"
      :to="`/internal-transfer/${row.id}`"
      :title="row.orderNo"
      :meta="rowMeta(row)"
      :chip-text="chipText(row)"
      :chip-class="badgeClass(row.status)"
    />
  </AppListPage>
</template>

<script setup lang="ts">
import { useWarehouse } from "~/composables/useWarehouse";
import { useErrorMessage } from "~/composables/errorMessage";
import { badgeClass } from "~/composables/useStatusBadge";
import type { InternalTransferQueueRow } from "~/services/types";

definePageMeta({ title: "meta.internalTransfer" });

const { t } = useI18n();
useHead({ title: t('internalTransfer.pda.title') });

const errorMessage = useErrorMessage();
const warehouse = useWarehouse();

const rows = ref<InternalTransferQueueRow[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

function rowMeta(row: InternalTransferQueueRow): string[] {
  const base = [`${row.itemCount} · ${row.totalQty}`];
  if (row.status === "finished") {
    base.push(t("internalTransfer.pda.toShelve", { qty: row.unshelvedQty }));
  } else {
    base.push(t("internalTransfer.pda.pickedProgress", { picked: row.pickedQty, total: row.totalQty }));
  }
  return base;
}

function chipText(row: InternalTransferQueueRow): string {
  return row.status === "finished"
    ? t("internalTransfer.pda.putAwayPending")
    : t(`internalTransfer.status.${row.status}`);
}

// Client-side search over the loaded queue (no server-side search param) —
// match order no, status label and the working user, mirroring put-away.
const search = ref("");
const visibleRows = computed(() => {
  const term = search.value.trim().toLowerCase();
  if (!term) return rows.value;
  return rows.value.filter(
    (row) =>
      row.orderNo.toLowerCase().includes(term) ||
      chipText(row).toLowerCase().includes(term) ||
      (row.workingBy?.toLowerCase().includes(term) ?? false)
  );
});

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    rows.value = await warehouse.listInternalTransferQueue();
  } catch (e: unknown) {
    loadError.value = errorMessage(e);
    rows.value = [];
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.page-hint {
  margin: -0.25rem 0 0.5rem;
  color: var(--muted);
  font-size: 0.875rem;
}
</style>
