<template>
  <AppListPage
    :loading="pending"
    :error="error"
    :empty="tasks.length === 0"
    empty-text="receivingScan.noTasks"
    :shown="tasks.length"
    :total="tasks.length"
    :has-more="false"
    hide-footer
    :reload="load"
    :topics="['/receiving-cn-scan-tasks']"
  >
    <template #header>
      <p class="page-hint">{{ $t('receivingScan.hint') }}</p>
    </template>

    <AppListRow
      v-for="task in tasks"
      :key="task.id"
      :to="`/receiving-cn-scan/${task.id}`"
      :title="task.batchNo"
      :meta="rowMeta(task)"
      :chip-text="$t('receivingScan.progress', { resolved: task.resolvedCount, total: task.itemCount })"
      :mine-text="mineText(task)"
    />
  </AppListPage>
</template>

<script setup lang="ts">
import type { CnScanTaskListRow } from "~/services/types";

definePageMeta({ title: "meta.receivingScan" });

const { t } = useI18n();
useHead({ title: t("receivingScan.title") });

const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const { mineText } = useAssignedToMe();

const pending = ref(true);
const error = ref<string | null>(null);
const tasks = ref<CnScanTaskListRow[]>([]);

async function load() {
  try {
    tasks.value = await warehouse.listCnScanTasks();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

function rowMeta(task: CnScanTaskListRow): string[] {
  const lines: string[] = [];
  if (task.invoiceNos) lines.push(task.invoiceNos);
  if (task.deliveryDate) lines.push(new Date(task.deliveryDate).toLocaleDateString());
  return lines;
}
</script>

<style scoped>
.page-hint {
  margin: -0.25rem 0 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}
</style>
