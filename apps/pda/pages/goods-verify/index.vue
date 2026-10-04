<template>
  <AppListPage
    v-model:search="search"
    v-model:filter="status"
    search-placeholder="goodsVerify.searchPlaceholder"
    :filters="statusFilters"
    :apply-on-search="false"
    :loading="loading"
    :error="loadError"
    :empty="rows.length === 0"
    empty-text="goodsVerify.empty"
    :shown="rows.length"
    :total="rows.length"
    :has-more="false"
    hide-footer
    :reload="load"
    :topics="['/goods-verify-tasks']"
    @apply="load"
  >
    <template #header>
      <p class="page-hint">{{ $t('goodsVerify.hint') }}</p>
      <div class="toolbar">
        <input v-model="date" class="date-input" type="date" @change="load" />
      </div>
    </template>

    <AppListRow
      v-for="task in rows"
      :key="task.id"
      :to="`/goods-verify/${task.id}`"
      :title="formatRow('goods-verify', 'title', task)"
      :meta="[formatRow('goods-verify', 'meta', task), rowExtra(task)]"
      :chip-text="statusLabel.goodsVerify(task.status)"
      :chip-class="badgeClass(task.status)"
    />
  </AppListPage>
</template>

<script setup lang="ts">
import { useWarehouse } from "~/composables/useWarehouse";
import { useErrorMessage } from "~/composables/errorMessage";
import { badgeClass } from "~/composables/useStatusBadge";
import type { GoodsVerifyTaskListRow } from "~/services/types";

definePageMeta({ title: "meta.goodsVerify" });

const { t } = useI18n();
useHead({ title: t('goodsVerify.title') });

const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
// Row title/meta come from the warehouse's pdaListTemplates flow config
// (spec 2026-09-21-pda-list-row-templates-design.md).
const { formatRow } = useListTemplates();

// UTC date — matches the backend's "today" (the DB session runs in UTC).
const date = ref(new Date().toISOString().slice(0, 10));
const status = ref("pending");
const search = ref("");

const statusFilters: { labelKey: string; value: string }[] = [
  { labelKey: "common.all", value: "" },
  { labelKey: "status.goodsVerify.pending", value: "pending" },
  { labelKey: "status.goodsVerify.verified", value: "verified" },
  { labelKey: "status.goodsVerify.skipped", value: "skipped" },
];

const rawRows = ref<GoodsVerifyTaskListRow[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

// The old aside carried expected qty / verified time; the single-column row
// puts them on the second meta line.
function rowExtra(task: GoodsVerifyTaskListRow): string {
  const parts = [t("goodsVerify.expectedQty", { qty: task.expectedQty })];
  if (task.verifiedAt) parts.push(new Date(task.verifiedAt).toLocaleString());
  return parts.join(" · ");
}

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    rawRows.value = await warehouse.getGoodsVerifyTasks({
      date: date.value || undefined,
      status: status.value || undefined,
    });
  } catch (e: unknown) {
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
      (r.shelfCode?.toLowerCase().includes(term) ?? false) ||
      (r.boxId?.toLowerCase().includes(term) ?? false) ||
      r.partNo.toLowerCase().includes(term) ||
      (r.wclItemNo?.toLowerCase().includes(term) ?? false)
  );
});
</script>

<style scoped>
.page-hint {
  margin: -0.25rem 0 0.5rem;
  color: var(--muted);
  font-size: 0.875rem;
}

.toolbar {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.5rem;
}

.date-input {
  flex: 1;
  min-width: 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font-size: 0.9375rem;
}
</style>
