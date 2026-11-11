<template>
  <AppListPage
    :loading="loading"
    :error="loadError"
    :empty="rows.length === 0"
    empty-text="packaging.empty"
    :shown="rows.length"
    :total="rows.length"
    :has-more="false"
    hide-footer
    :reload="load"
    :topics="['/packaging-orders', '/picking-orders', '/shipping-orders']"
  >
    <template #header>
      <p class="page-hint">{{ $t('packaging.hint') }}</p>
    </template>

    <AppListRow
      v-for="row in rows"
      :key="row.id"
      :to="`/packaging/${row.id}`"
      :title="rowView(row).title"
      :meta="rowView(row).meta"
      :chip-text="rowChip(row)?.text"
      :chip-class="rowChip(row)?.cls"
      :mine-text="mineText(row)"
    />
  </AppListPage>
</template>

<script setup lang="ts">
// Packaging queue (打包, spec 2026-11-10-packaging-shipping-steps-design.md):
// verified orders awaiting the weight + box/pallet confirm. Pending only —
// packaged orders move on to shipping (history lives on the admin side).
import { useErrorMessage } from "~/composables/errorMessage";
import { viewListChip, viewListRow } from "~/utils/viewConfig";
import type { PackagingOrderRow } from "~/services/types";

const { t } = useI18n();
useHead({ title: t("packaging.title") });

const warehouse = useWarehouse();
const errorMessage = useErrorMessage();
const { mineText } = useAssignedToMe();
const { viewConfig, renderChip } = useViewConfig();

const rows = ref<PackagingOrderRow[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    rows.value = await warehouse.getPackagingOrders("pending");
  } catch (e: unknown) {
    loadError.value = errorMessage(e);
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

// Spread (labeling pattern) — viewListRow/Chip take a plain row object.
const rowView = (row: PackagingOrderRow) => viewListRow("packaging", { ...row }, viewConfig.value);
const rowChip = (row: PackagingOrderRow) => renderChip(viewListChip("packaging", { ...row }, viewConfig.value));
</script>

<style scoped>
.page-hint {
  margin: -0.25rem 0 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}
</style>
