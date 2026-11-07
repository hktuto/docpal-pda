<template>
  <AppListPage
    :loading="loading"
    :error="loadError"
    :empty="rows.length === 0"
    empty-text="putBack.noTasks"
    :shown="rows.length"
    :total="rows.length"
    :has-more="false"
    hide-footer
    :reload="load"
    :topics="['/put-back-tasks']"
  >
    <template #header>
      <p class="page-hint">{{ $t('putBack.hint') }}</p>
    </template>

    <AppListRow
      v-for="task in rows"
      :key="task.id"
      :to="`/put-back/${task.id}`"
      :title="task.orderNo"
      :meta="[`${task.itemCount} · ${task.totalQty}`]"
      :chip-text="$t(`putBack.status.${task.status}`)"
      :chip-class="badgeClass(task.status)"
      :mine-text="mineText(task)"
    />
  </AppListPage>
</template>

<script setup lang="ts">
import { useWarehouse } from "~/composables/useWarehouse";
import { useErrorMessage } from "~/composables/errorMessage";
import { badgeClass } from "~/composables/useStatusBadge";
import { useAssignedToMe } from "~/composables/useAssignedToMe";
import type { PutBackTaskListRow } from "~/services/types";

definePageMeta({ title: "meta.putBack" });

const { t } = useI18n();
useHead({ title: t('putBack.title') });

const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const { mineText } = useAssignedToMe();

const rows = ref<PutBackTaskListRow[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    rows.value = await warehouse.listPutBackTasks("pending");
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
