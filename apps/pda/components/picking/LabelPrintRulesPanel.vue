<template>
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
</template>

<script setup lang="ts">
// The per-rule match list + print logic shared by the picking-finish
// LabelPrintPrompt modal and the labeling detail page (spec
// docs/superpowers/specs/2026-10-28-picking-labeling-step-design.md).
import { useToast } from "~/composables/useToast";
import { useErrorMessage } from "~/composables/errorMessage";
import InlineSpinner from "~/components/InlineSpinner.vue";
import { dynamicPrint, waitForPrintJob } from "~/utils/print";
import { buildLabelPrintParams } from "~/utils/labelPrintParams";
import type { LabelPrintRuleMatch, PickingOrderDetail } from "~/services/types";

const props = defineProps<{
  order: PickingOrderDetail;
  matches: LabelPrintRuleMatch[];
}>();

const { showToast } = useToast();
const getErrorMessage = useErrorMessage();

type RowState = "idle" | "printing" | "printed" | "failed";

const rowStates = ref<Record<string, RowState>>({});
const printingAll = ref(false);
// Label counts never change while the panel is shown — build each match's
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

/** Clear per-row print state (the modal calls this each time it opens). */
function reset(): void {
  rowStates.value = {};
  printingAll.value = false;
  paramsCache.clear();
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

defineExpose({ printAll, reset, printingAll, allPrinted });
</script>

<style scoped>
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
</style>
