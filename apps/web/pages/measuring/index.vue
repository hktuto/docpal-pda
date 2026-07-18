<template>
  <div>
    <p class="page-hint">
      {{ $t('measuring.hint') }}
    </p>

    <p v-if="loading" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: loadError }) }}</p>
    <p v-else-if="rows.length === 0" class="empty">{{ $t('common.noPendingMeasuringTasks') }}</p>

    <NuxtLink
      v-for="task in rows"
      :key="task.id"
      :to="`/measuring/${task.id}`"
      class="card list-card"
    >
      <div class="list-card__header">
        <span class="list-card__title">{{ task.refNo }}</span>
        <span class="badge" :class="badgeClass(task.status)">{{ statusLabel.measuring(task.status) }}</span>
      </div>
      <p class="list-card__meta">
        {{ task.shipTo || $t('common.noData') }}
      </p>
      <div class="list-card__footer">
        <span class="list-card__date">
          {{ $t('measuring.boxesClosed', { count: task.closedBoxCount, total: task.boxCount }) }}
        </span>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { badgeClass } from "~/composables/useStatusBadge";
import type { MeasuringTaskListRow } from "~/services/types";

definePageMeta({ title: "meta.measuring" });

const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();

useHead({ title: t('measuring.title') });

const rawRows = ref<MeasuringTaskListRow[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    // Pending only — the old client behavior (completed tasks are history).
    rawRows.value = await warehouse.getMeasuringTasks("pending");
  } catch (e: unknown) {
    loadError.value = errorMessage(e);
    rawRows.value = [];
  } finally {
    loading.value = false;
  }
}

const rows = computed(() => rawRows.value);

useVisibleReload(load);
</script>

<style scoped>
.page-hint {
  margin: -0.25rem 0 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}

</style>
