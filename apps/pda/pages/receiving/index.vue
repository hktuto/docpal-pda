<template>
  <AppListPage
    v-model:search="search"
    v-model:filter="filter"
    search-placeholder="common.searchByRefOrSupplier"
    :filters="filters"
    :loading="loading"
    :error="loadError"
    :empty="rows.length === 0"
    empty-text="common.noReceivingOrders"
    :shown="rows.length"
    :total="total"
    :has-more="hasMore"
    :reload="refresh"
    :topics="['/receiving-orders']"
    @apply="load(true)"
    @load-more="load(false)"
  >
    <AppListRow
      v-for="ro in rows"
      :key="ro.id"
      :to="`/receiving/${ro.id}`"
      :title="rowTitle(ro)"
      :meta="[rowMeta(ro), rowExtra(ro)]"
      :chip-text="statusLabel.receiving(ro.status)"
      :chip-class="badgeClass(ro.status)"
    />
  </AppListPage>
</template>

<script setup lang="ts">
import { badgeClass } from "~/composables/useStatusBadge";
import { useWarehouse } from "~/composables/useWarehouse";
import type { ReceivingFilter, ReceivingOrderListQuery, ReceivingOrderListRow } from "~/services/types";

definePageMeta({ title: "meta.receiving" });

const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
// Row title/meta come from the warehouse's pdaListTemplates flow config
// (spec 2026-09-21-pda-list-row-templates-design.md).
const { formatRow } = useListTemplates();
const rowTitle = (ro: ReceivingOrderListRow) => formatRow("receiving", "title", ro);
const rowMeta = (ro: ReceivingOrderListRow) => formatRow("receiving", "meta", ro);

// The old two-column row showed remaining/pending counts as aside badges;
// the single-column row carries them on the second meta line instead.
function rowExtra(ro: ReceivingOrderListRow): string {
  const parts: string[] = [];
  if (ro.remainingItems > 0) parts.push(t("receiving.remaining", { count: ro.remainingItems }));
  if (ro.pendingPickingOrders > 0) parts.push(`${ro.pendingPickingOrders} ${t("status.picking.picking")}`);
  return parts.join(" · ");
}

useHead({ title: t("receiving.title") });

const filters: { labelKey: string; value: ReceivingFilter }[] = [
  { labelKey: "common.all", value: "all" },
  { labelKey: "status.receiving.pending", value: "pending" },
  { labelKey: "status.receiving.in_hand", value: "in_hand" },
  { labelKey: "status.receiving.clear", value: "clear" },
];

const filter = ref<ReceivingFilter>("in_hand");
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
</script>
