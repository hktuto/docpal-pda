<template>
  <AppListPage
    v-model:search="search"
    search-placeholder="labelPrinting.searchPlaceholder"
    :loading="loading"
    :error="loadError"
    :empty="rows.length === 0"
    empty-text="labelPrinting.empty"
    :shown="rows.length"
    :total="total"
    :has-more="hasMore"
    :reload="refresh"
    :topics="['/label-printing-orders', '/picking-orders']"
    :applyOnSearch="true"
    @apply="load(true)"
    @load-more="load(false)"
  >
    <AppListRow
      v-for="row in rows"
      :key="row.id"
      :to="`/label-printing/${row.id}`"
      :title="rowView(row).title"
      :meta="rowView(row).meta"
      :chip-text="rowChip(row)?.text"
      :chip-class="rowChip(row)?.cls"
      :mine-text="mineText(row)"
    />
  </AppListPage>
</template>

<script setup lang="ts">
// Label-printing queue (spec 2026-11-02): picking-finished orders whose
// internal label print rules matched at finish, waiting for the labels to be
// printed at the printer bench.
import { viewListChip, viewListRow } from "~/utils/viewConfig";
import type { LabelPrintingOrderRow } from "~/services/types";

definePageMeta({ title: "meta.labelPrinting" });

const { t } = useI18n();
useHead({ title: t("labelPrinting.title") });

// Row title/meta/chip come from the warehouse's pdaViewConfig flow config
// (label-printing list, spec 2026-11-02); defaults reproduce the built-in
// rendering on backends without the key. labelCount is derived from the row's
// live labelMatches for the template/chip catalogs.
const { viewConfig, renderChip } = useViewConfig();
const { mineText } = useAssignedToMe();
const { search, rows, total, loading, loadError, hasMore, load, refresh } = useLabelPrintingOrders();

function rowFields(row: LabelPrintingOrderRow) {
  return { ...row, labelCount: row.labelMatches.length };
}
const rowView = (row: LabelPrintingOrderRow) => viewListRow("label-printing", rowFields(row), viewConfig.value);
const rowChip = (row: LabelPrintingOrderRow) =>
  renderChip(viewListChip("label-printing", rowFields(row), viewConfig.value));
</script>
