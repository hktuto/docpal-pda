<template>
  <div>
    <p class="page-hint">{{ $t('goodsVerify.hint') }}</p>

    <div class="toolbar">
      <input v-model="date" class="date-input" type="date" @change="load" />
      <button class="btn btn--small" :disabled="generating" @click="generate">
        {{ generating ? $t('goodsVerify.generating') : $t('goodsVerify.generate') }}
      </button>
    </div>

    <div class="filters">
      <button
        v-for="opt in statusFilters"
        :key="opt.value"
        class="filter-chip"
        :class="{ 'filter-chip--active': status === opt.value }"
        @click="status = opt.value"
      >
        {{ $t(opt.labelKey) }}
      </button>
    </div>

    <input
      v-model="search"
      class="search"
      type="text"
      :placeholder="$t('goodsVerify.searchPlaceholder')"
    />

    <p v-if="loading" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: loadError }) }}</p>
    <p v-else-if="rows.length === 0" class="empty">{{ $t('goodsVerify.empty') }}</p>

    <NuxtLink
      v-for="task in rows"
      :key="task.id"
      :to="`/goods-verify/${task.id}`"
      class="card list-card"
    >
      <div class="list-card__header">
        <span class="list-card__title">{{ task.partNo }}</span>
        <span class="badge" :class="badgeClass(task.status)">{{ statusLabel.goodsVerify(task.status) }}</span>
      </div>
      <p class="list-card__meta">
        {{ task.shelfCode || $t('common.noData') }}
        · {{ task.boxId || $t('common.noData') }}
      </p>
      <div class="list-card__footer">
        <span class="list-card__date">
          {{ $t('goodsVerify.expectedQty', { qty: task.expectedQty }) }}
        </span>
        <span v-if="task.verifiedAt" class="badge badge--info">
          {{ new Date(task.verifiedAt).toLocaleString() }}
        </span>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { useWarehouse } from "~/composables/useWarehouse";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useErrorMessage } from "~/composables/errorMessage";
import { useToast } from "~/composables/useToast";
import { badgeClass } from "~/composables/useStatusBadge";
import type { GoodsVerifyTaskListRow } from "~/services/types";

definePageMeta({ title: "meta.goodsVerify" });

const { t } = useI18n();
useHead({ title: t('goodsVerify.title') });

const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const { showToast } = useToast();

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
const generating = ref(false);

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
      r.partNo.toLowerCase().includes(term)
  );
});

async function generate() {
  generating.value = true;
  try {
    // No date — the backend defaults to its CURRENT_DATE ("today").
    const result = await warehouse.generateGoodsVerifyTasks();
    showToast(t('goodsVerify.generated', { count: result.created, date: result.date }));
    await load();
  } catch (e: unknown) {
    loadError.value = errorMessage(e);
  } finally {
    generating.value = false;
  }
}

watch(status, load);
useVisibleReload(load);
</script>

<style scoped>
.page-hint {
  margin: -0.25rem 0 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}

.toolbar {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 1rem;
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
