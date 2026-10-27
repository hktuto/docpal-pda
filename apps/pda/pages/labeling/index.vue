<template>
  <AppListPage
    v-model:search="search"
    search-placeholder="labeling.searchPlaceholder"
    :loading="loading"
    :error="loadError"
    :empty="rows.length === 0"
    empty-text="labeling.empty"
    :shown="rows.length"
    :total="total"
    :has-more="hasMore"
    :reload="refresh"
    :topics="['/labeling-orders', '/picking-orders']"
    :applyOnSearch="true"
    @apply="load(true)"
    @load-more="load(false)"
  >
    <AppListRow
      v-for="row in rows"
      :key="row.id"
      :to="`/labeling/${row.id}`"
      :title="rowView(row).title"
      :meta="rowView(row).meta"
      :chip-text="rowChip(row)?.text"
      :chip-class="rowChip(row)?.cls"
    />
  </AppListPage>
</template>

<script setup lang="ts">
// Labeling queue (spec 2026-10-28): picking-finished orders whose label print
// rules matched at finish, waiting for labels to be printed + confirmed.
import { viewListChip, viewListRow } from "~/utils/viewConfig";
import type { LabelingOrderRow } from "~/services/types";

definePageMeta({ title: "meta.labeling" });

const { t } = useI18n();
useHead({ title: t("labeling.title") });

// Row title/meta/chip come from the warehouse's pdaViewConfig flow config
// (labeling list, spec 2026-10-28); defaults reproduce the built-in rendering
// on backends without the key. labelCount is derived from the row's live
// labelMatches for the template/chip catalogs.
const { viewConfig, renderChip } = useViewConfig();
const { search, rows, total, loading, loadError, hasMore, load, refresh } = useLabelingOrders();

function rowFields(row: LabelingOrderRow) {
  return { ...row, labelCount: row.labelMatches.length };
}
const rowView = (row: LabelingOrderRow) => viewListRow("labeling", rowFields(row), viewConfig.value);
const rowChip = (row: LabelingOrderRow) =>
  renderChip(viewListChip("labeling", rowFields(row), viewConfig.value));
</script>
