<template>
  <div
    v-if="open"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="label-print-title"
    @click.self="close"
    @keydown.esc="close"
  >
    <div class="modal">
      <div class="modal__header">
        <div>
          <h3 id="label-print-title">{{ $t('picking.printLabels.title') }}</h3>
          <p class="modal__subtitle">{{ $t('picking.printLabels.subtitle', { orderNo: order.orderNo }) }}</p>
        </div>
        <button class="modal__close" :aria-label="$t('common.close')" @click="close">×</button>
      </div>

      <div class="modal__body">
        <ul class="match-list">
          <li v-for="match in matches" :key="match.ruleId" class="match-row">
            <div class="match-info">
              <span class="match-name">{{ match.name }}</span>
              <span class="match-meta">
                {{ $t(`picking.printLabels.labelTypes.${match.labelType}`) }} · {{ match.printTemplateId }}
              </span>
              <span class="match-meta">{{ $t('picking.printLabels.labelsCount', { count: labelCount(match) }) }}</span>
            </div>
            <button
              class="btn btn--small"
              :class="{
                'match-print--printed': stateOf(match.ruleId) === 'printed',
                'match-print--failed': stateOf(match.ruleId) === 'failed',
              }"
              :disabled="stateOf(match.ruleId) === 'printing'"
              @click="printMatch(match)"
            >
              <template v-if="stateOf(match.ruleId) === 'printing'">
                <InlineSpinner /> {{ $t('picking.printLabels.printing') }}
              </template>
              <template v-else-if="stateOf(match.ruleId) === 'printed'">
                {{ $t('picking.printLabels.printed') }}
              </template>
              <template v-else-if="stateOf(match.ruleId) === 'failed'">
                {{ $t('picking.printLabels.printFailed') }}
              </template>
              <template v-else>
                {{ $t('picking.printLabels.print') }}
              </template>
            </button>
          </li>
        </ul>

        <div class="modal__footer">
          <button class="btn btn--secondary" @click="close">{{ $t('picking.printLabels.skip') }}</button>
          <button class="btn" :disabled="printingAll || allPrinted" @click="printAll">
            <template v-if="printingAll"><InlineSpinner /> {{ $t('picking.printLabels.printing') }}</template>
            <template v-else>{{ $t('picking.printLabels.printAll') }}</template>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useToast } from "~/composables/useToast";
import { useErrorMessage } from "~/composables/errorMessage";
import InlineSpinner from "~/components/InlineSpinner.vue";
import { dynamicPrint, waitForPrintJob } from "~/utils/print";
import { buildLabelPrintParams } from "~/utils/labelPrintParams";
import type { LabelPrintRuleMatch, PickingOrderDetail } from "~/services/types";

const props = defineProps<{
  open: boolean;
  order: PickingOrderDetail;
  matches: LabelPrintRuleMatch[];
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
}>();

const { showToast } = useToast();
const getErrorMessage = useErrorMessage();

type RowState = "idle" | "printing" | "printed" | "failed";

const rowStates = ref<Record<string, RowState>>({});
const printingAll = ref(false);
// Label counts never change while the prompt is open — build each match's
// params once, lazily, and reuse them for the actual print call.
const paramsCache = new Map<string, Record<string, unknown>[]>();

function stateOf(ruleId: string): RowState {
  return rowStates.value[ruleId] ?? "idle";
}

function paramsFor(match: LabelPrintRuleMatch): Record<string, unknown>[] {
  let params = paramsCache.get(match.ruleId);
  if (!params) {
    params = buildLabelPrintParams(match.labelType, props.order);
    paramsCache.set(match.ruleId, params);
  }
  return params;
}

function labelCount(match: LabelPrintRuleMatch): number {
  return paramsFor(match).length;
}

const allPrinted = computed(() =>
  props.matches.every((m) => stateOf(m.ruleId) === "printed")
);

watch(
  () => props.open,
  (open) => {
    if (open) {
      rowStates.value = {};
      printingAll.value = false;
      paramsCache.clear();
    }
  }
);

function close() {
  // Closing mid-print is fine — any in-flight jobs finish in the background.
  emit("update:open", false);
}

async function printMatch(match: LabelPrintRuleMatch): Promise<void> {
  if (stateOf(match.ruleId) === "printing") return;
  rowStates.value = { ...rowStates.value, [match.ruleId]: "printing" };
  try {
    const { jobs } = await dynamicPrint({
      templateId: match.printTemplateId,
      printingParams: paramsFor(match),
    });
    for (const job of jobs) {
      await waitForPrintJob(job.jobId);
    }
    rowStates.value = { ...rowStates.value, [match.ruleId]: "printed" };
  } catch (e) {
    rowStates.value = { ...rowStates.value, [match.ruleId]: "failed" };
    showToast(getErrorMessage(e));
  }
}

async function printAll(): Promise<void> {
  if (printingAll.value) return;
  printingAll.value = true;
  try {
    for (const match of props.matches) {
      if (stateOf(match.ruleId) !== "printed") {
        await printMatch(match);
      }
    }
  } finally {
    printingAll.value = false;
  }
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 100;
}

.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  width: 100%;
  max-width: 26.25rem;
  max-height: 90vh;
  overflow-y: auto;
}

.modal__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 1rem;
  border-bottom: 1px solid var(--border);
}

.modal__header h3 {
  margin: 0;
}

.modal__subtitle {
  margin: 0.25rem 0 0;
  color: var(--muted);
  font-size: 0.8125rem;
}

.modal__close {
  background: transparent;
  border: none;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  color: var(--muted);
}

.modal__body {
  padding: 1rem;
}

.match-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.match-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem;
}

.match-info {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.match-name {
  font-weight: 600;
}

.match-meta {
  color: var(--muted);
  font-size: 0.8125rem;
}

.match-print--printed {
  background: #10b981;
  border-color: #10b981;
}

.match-print--failed {
  background: var(--danger);
  border-color: var(--danger);
}

.modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1rem;
}
</style>
