<template>
  <div>
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
      :to="`/goods-verify/task/${task.id}`"
      class="card list-card"
    >
      <div class="list-card__header">
        <span class="list-card__title">{{ task.refNo }}</span>
        <span class="badge" :class="badgeClass(task.status)">{{ statusLabel.goodsVerifyTask(task.status) }}</span>
      </div>
      <p class="list-card__meta">
        {{ $t('goodsVerify.task.dueDate', { date: formatDate(task.dueDate) }) }}
      </p>
      <div class="list-card__footer">
        <span class="list-card__meta">
          {{ $t('goodsVerify.task.shelves', { count: task.shelfCount }) }} · {{ $t('goodsVerify.task.boxes', { count: task.boxCount }) }}
        </span>
        <span v-if="task.verifiedBoxCount > 0" class="badge badge--info">
          {{ $t('goodsVerify.task.progress', { verified: task.verifiedBoxCount, total: task.boxCount }) }}
        </span>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { badgeClass } from "~/composables/useStatusBadge";
import { useWarehouse } from "~/composables/useWarehouse";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useErrorMessage } from "~/composables/errorMessage";
import type { GoodsVerifyTaskSummary } from "~/services/types";

definePageMeta({ title: "meta.goodsVerify" });

const { t } = useI18n();
useHead({ title: t('goodsVerify.title') });

const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();

const rawRows = ref<GoodsVerifyTaskSummary[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const search = ref("");

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    rawRows.value = await warehouse.getGoodsVerifyTasks();
  } catch (e: unknown) {
    loadError.value = errorMessage(e);
    rawRows.value = [];
  } finally {
    loading.value = false;
  }
}

function formatDate(value: string | null | undefined): string {
  if (!value) return t('common.noDate');
  return new Date(value).toLocaleDateString();
}

const rows = computed(() => {
  const term = search.value.trim().toLowerCase();
  if (!term) return rawRows.value;
  return rawRows.value.filter(
    (r) =>
      r.refNo.toLowerCase().includes(term) ||
      r.status.toLowerCase().includes(term)
  );
});

useVisibleReload(load);
</script>

<style scoped>
.list-card__footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
</style>
