<template>
  <AppListPage
    :loading="pending"
    :error="error"
    :empty="taskMode ? tasks.length === 0 : candidates.length === 0"
    :empty-text="taskMode ? 'putAway.noTasks' : 'common.noReceivingOrdersNeedPutAway'"
    :shown="taskMode ? tasks.length : candidates.length"
    :total="taskMode ? tasks.length : candidates.length"
    :has-more="false"
    hide-footer
    :reload="load"
    :topics="['/put-away-tasks']"
  >
    <template #header>
      <p class="page-hint">
        {{ $t(taskMode ? 'putAway.tasksHint' : 'putAway.hint') }}
      </p>
      <!-- CN only: scan-to-open — the admin CN order detail exports an Excel
           whose QR payload is the PDA route /put-away/<orderId>?task=<taskId>.
           The autofocused input receives hardware scans (broadcast fills the
           focused input; the wedge types into it) and opens the task on
           Enter. Standard warehouses never render this row. -->
      <div v-if="cnMode" class="scan-to-open">
        <label class="scan-to-open__label" for="put-away-scan-to-open">
          {{ $t('putAway.cn.scanToOpen') }}
        </label>
        <input
          id="put-away-scan-to-open"
          v-model="scanToOpen"
          type="text"
          class="scan-to-open__input"
          autocomplete="off"
          autofocus
          :placeholder="$t('putAway.cn.scanToOpenPlaceholder')"
          @keydown.enter.prevent="onScanToOpen"
        />
      </div>
    </template>

    <template v-if="taskMode">
      <AppListRow
        v-for="task in tasks"
        :key="task.id"
        :to="`/put-away/${task.receivingOrderId}?task=${task.id}`"
        :title="rowView(task).title"
        :meta="rowMeta(task, $t('putAway.taskProgress', { unboxed: task.unboxedItems, received: task.receivedItems }))"
        :chip-text="rowChip(task)?.text"
        :chip-class="rowChip(task)?.cls"
      />
    </template>
    <template v-else>
      <AppListRow
        v-for="ro in candidates"
        :key="ro.id"
        :to="`/put-away/${ro.id}`"
        :title="rowView(ro).title"
        :meta="rowMeta(ro, $t('putAway.unboxedItems', { count: ro.unboxedItems }))"
        :chip-text="rowChip(ro)?.text"
        :chip-class="rowChip(ro)?.cls"
        :warn-text="ro.outdatedWarningCount > 0 ? $t('outdatedWarning.chip', { count: ro.outdatedWarningCount }) : undefined"
      />
    </template>
  </AppListPage>
</template>

<script setup lang="ts">
import { badgeClass } from "~/composables/useStatusBadge";
import { useWarehouse } from "~/composables/useWarehouse";
import { viewListChip, viewListRow } from "~/utils/viewConfig";
import { parsePutAwayOpenScan } from "~/utils/putAwayScanToOpen";
import type { PutAwayCandidate, PutAwayTaskListRow } from "~/services/types";

definePageMeta({ title: "meta.putAway" });

const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const { showToast } = useToast();
const warehouse = useWarehouse();
const { putAwayConfig, cnReceiving, loadFlowSteps } = useFlowSteps();
// Row title/meta/chip come from the warehouse's pdaViewConfig flow config
// (spec 2026-10-04-pda-app-rewrite-design.md); tasks and candidates share the
// put-away list config. On a backend without the key the legacy listTemplates
// + the extra meta line render instead.
const { viewConfig, viewConfigLoaded, renderChip } = useViewConfig();
const rowView = (row: PutAwayCandidate | PutAwayTaskListRow) => viewListRow("put-away", row, viewConfig.value);
function rowMeta(row: PutAwayCandidate | PutAwayTaskListRow, extraLine: string): string[] {
  const meta = rowView(row).meta;
  return viewConfigLoaded.value ? meta : [...meta, extraLine];
}
function rowChip(row: PutAwayCandidate | PutAwayTaskListRow) {
  if (!viewConfigLoaded.value) {
    return taskMode.value
      ? { text: statusLabel.putAway(row.status), cls: badgeClass(row.status) }
      : { text: statusLabel.receiving(row.status), cls: badgeClass(row.status) };
  }
  // Candidate rows carry receiving statuses, task rows put-away statuses.
  return renderChip(
    viewListChip("put-away", row, viewConfig.value, {
      statusLabelFn: taskMode.value ? "putAway" : "receiving",
    })
  );
}

useHead({ title: t("putAway.title") });

const pending = ref(true);
const error = ref<string | null>(null);
const candidates = ref<PutAwayCandidate[]>([]);
const tasks = ref<PutAwayTaskListRow[]>([]);

// CN customer-receiving mode: the CN flow only has the task queue (the CN
// finalize cron creates one pending task per order), so the list source is
// always the CN task list regardless of putAway.autoCreateTasks.
const cnMode = computed(() => cnReceiving.value);
// Task-queue mode: the backend auto-creates one put-away task per receiving
// order (putAway.autoCreateTasks); otherwise the derived candidates list.
const taskMode = computed(() => cnMode.value || putAwayConfig.value.autoCreateTasks);

async function load() {
  try {
    // Make sure the config is resolved before picking the list source.
    await loadFlowSteps();
    if (cnMode.value) {
      tasks.value = await warehouse.listCnPutAwayTasks("pending");
    } else if (taskMode.value) {
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

// CN scan-to-open: the Excel QR payload is `/put-away/<orderId>?task=<taskId>`
// (a bare task UUID is accepted too). The CN detail is task-scoped — the
// [id] route segment is ignored — so we navigate with a placeholder segment.
const scanToOpen = ref("");
async function onScanToOpen() {
  const value = scanToOpen.value;
  scanToOpen.value = "";
  const parsed = parsePutAwayOpenScan(value);
  if (!parsed) {
    showToast(t("putAway.cn.scanToOpenInvalid"));
    return;
  }
  await navigateTo(`/put-away/cn?task=${parsed.taskId}`);
}
</script>

<style scoped>
.page-hint {
  margin: -0.25rem 0 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}

.scan-to-open {
  margin: -0.25rem 0 1rem;
}

.scan-to-open__label {
  display: block;
  margin-bottom: 0.25rem;
  font-size: 0.875rem;
  font-weight: 600;
}

.scan-to-open__input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font-size: 1rem;
}
</style>
