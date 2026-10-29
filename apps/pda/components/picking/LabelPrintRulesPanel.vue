<template>
  <div class="printer-row">
    <label class="printer-row__label" for="lpr-printer">{{ $t('picking.printLabels.printer') }}</label>
    <select id="lpr-printer" v-model="printerName" class="printer-row__select">
      <option value="">{{ $t('picking.printLabels.printerDefault') }}</option>
      <option v-for="p in printers" :key="printerKey(p)" :value="printerKey(p)">
        {{ p.alias || p.name || p.deviceKey }}
      </option>
    </select>
  </div>
  <ul class="match-list">
    <li v-for="match in matches" :key="match.ruleId" class="match-row">
      <div class="match-info">
        <span class="match-name">{{ match.name }}</span>
        <span class="match-meta">
          {{ $t(`picking.printLabels.labelTypes.${match.labelType}`) }} · {{ match.printTemplateId }}
        </span>
        <span class="match-meta">{{ $t('picking.printLabels.labelsCount', { count: match.labelCount }) }}</span>
        <span v-if="match.labelSource === 'external'" class="match-meta match-external">
          {{ $t('picking.printLabels.externalNote') }}
        </span>
      </div>
      <!-- External labels are provided by the customer — info row only,
           never printable (spec 2026-10-30). -->
      <button
        v-if="match.labelSource !== 'external'"
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
// The printer picker + per-rule match list + print logic shared by the
// picking-finish LabelPrintPrompt modal and the labeling detail page (spec
// docs/superpowers/specs/2026-10-28-picking-labeling-step-design.md).
import { useToast } from "~/composables/useToast";
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import InlineSpinner from "~/components/InlineSpinner.vue";
import {
  listPrinters,
  parsePrinterKey,
  printerKey,
  waitForPrintJob,
  type PrinterInfo,
} from "~/utils/print";
import type { LabelPrintRuleMatch, PickingOrderDetail } from "~/services/types";

const props = defineProps<{
  order: PickingOrderDetail;
  matches: LabelPrintRuleMatch[];
}>();

const { showToast } = useToast();
const getErrorMessage = useErrorMessage();
const warehouse = useWarehouse();

// Printer picker — the print service's agent printers (same "label_printer"
// localStorage key as the admin dialogs); empty = the template's default
// printer. A remembered key that is no longer listed still prints (the raw
// serviceId/deviceKey pair is sent as-is).
const printerName = ref(import.meta.client ? (localStorage.getItem("label_printer") ?? "") : "");
const printers = ref<PrinterInfo[]>([]);

const selectedPrinter = computed(() => parsePrinterKey(printerName.value.trim()) ?? undefined);

watch(printerName, (value) => {
  if (import.meta.client) localStorage.setItem("label_printer", value.trim());
});

// Non-fatal: without the list the picker just offers the default printer.
onMounted(async () => {
  try {
    printers.value = await listPrinters();
  } catch {
    printers.value = [];
  }
});

type RowState = "idle" | "printing" | "printed" | "failed";

const rowStates = ref<Record<string, RowState>>({});
const printingAll = ref(false);

function stateOf(ruleId: string): RowState {
  return rowStates.value[ruleId] ?? "idle";
}

// External matches (customer-provided labels) are info rows — excluded from
// printAll and from the allPrinted computation (they are not printable).
const printableMatches = computed(() =>
  props.matches.filter((m) => m.labelSource !== "external")
);

const allPrinted = computed(() =>
  printableMatches.value.every((m) => stateOf(m.ruleId) === "printed")
);

/** Clear per-row print state (the modal calls this each time it opens). */
function reset(): void {
  rowStates.value = {};
  printingAll.value = false;
}

async function printMatch(match: LabelPrintRuleMatch): Promise<void> {
  if (stateOf(match.ruleId) === "printing") return;
  rowStates.value = { ...rowStates.value, [match.ruleId]: "printing" };
  try {
    const { jobs } = await warehouse.printPickingLabel(props.order.id, match.ruleId, selectedPrinter.value);
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
    for (const match of printableMatches.value) {
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
.printer-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.printer-row__label {
  color: var(--muted);
  font-size: 0.8125rem;
  white-space: nowrap;
}

.printer-row__select {
  flex: 1;
  min-width: 0;
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
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

.match-external {
  color: var(--warning);
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
