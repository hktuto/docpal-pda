<template>
  <div>
    <p class="page-hint">
      {{ $t(taskMode ? 'putAway.tasksHint' : 'putAway.hint') }}
    </p>

    <p v-if="pending" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: error }) }}</p>
    <template v-else-if="taskMode">
      <p v-if="tasks.length === 0" class="empty">{{ $t('putAway.noTasks') }}</p>
      <div v-else class="list-panel">
        <NuxtLink
          v-for="task in tasks"
          :key="task.id"
          :to="`/put-away/${task.receivingOrderId}?task=${task.id}`"
          class="list-row"
        >
          <div class="list-row__main">
            <div class="list-row__line1">
              <span class="list-row__title">{{ formatRow("put-away", "title", task) }}</span>
            </div>
            <div v-if="formatRow('put-away', 'meta', task)" class="list-row__meta">
              {{ formatRow("put-away", "meta", task) }}
            </div>
          </div>
          <div class="list-row__aside">
            <span class="badge" :class="badgeClass(task.status)">{{ statusLabel.putAway(task.status) }}</span>
            <span>{{ $t('putAway.taskProgress', { unboxed: task.unboxedItems, received: task.receivedItems }) }}</span>
          </div>
          <svg class="list-row__chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        </NuxtLink>
      </div>
    </template>
    <template v-else>
      <p v-if="candidates.length === 0" class="empty">{{ $t('common.noReceivingOrdersNeedPutAway') }}</p>
      <div v-else class="list-panel">
        <NuxtLink
          v-for="ro in candidates"
          :key="ro.id"
          :to="`/put-away/${ro.id}`"
          class="list-row"
        >
          <div class="list-row__main">
            <div class="list-row__line1">
              <span class="list-row__title">{{ formatRow("put-away", "title", ro) }}</span>
            </div>
            <div v-if="formatRow('put-away', 'meta', ro)" class="list-row__meta">
              {{ formatRow("put-away", "meta", ro) }}
            </div>
          </div>
          <div class="list-row__aside">
            <span class="badge" :class="badgeClass(ro.status)">{{ statusLabel.receiving(ro.status) }}</span>
            <span>{{ $t('putAway.unboxedItems', { count: ro.unboxedItems }) }}</span>
          </div>
          <svg class="list-row__chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        </NuxtLink>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { badgeClass } from "~/composables/useStatusBadge";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useWarehouse } from "~/composables/useWarehouse";
import type { PutAwayCandidate, PutAwayTaskListRow } from "~/services/types";

definePageMeta({ title: "meta.putAway" });

const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const { putAwayConfig, loadFlowSteps } = useFlowSteps();
// Row title/meta come from the warehouse's pdaListTemplates flow config
// (spec 2026-09-21-pda-list-row-templates-design.md); tasks and candidates
// share the put-away list config.
const { formatRow } = useListTemplates();

useHead({ title: t("putAway.title") });

const pending = ref(true);
const error = ref<string | null>(null);
const candidates = ref<PutAwayCandidate[]>([]);
const tasks = ref<PutAwayTaskListRow[]>([]);

// Task-queue mode: the backend auto-creates one put-away task per receiving
// order (putAway.autoCreateTasks); otherwise the derived candidates list.
const taskMode = computed(() => putAwayConfig.value.autoCreateTasks);

async function load() {
  try {
    // Make sure the config is resolved before picking the list source.
    await loadFlowSteps();
    if (taskMode.value) {
      tasks.value = await warehouse.listPutAwayTasks("pending");
    } else {
      candidates.value = await warehouse.getPutAwayCandidates();
    }
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

useVisibleReload(load, ["/put-away-tasks"]);
</script>

<style scoped>
.page-hint {
  margin: -0.25rem 0 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}

</style>
