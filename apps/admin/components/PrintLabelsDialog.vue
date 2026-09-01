<script setup lang="ts">
// Shared print dialog for template labels (shelf / shelf-box). Printer names
// come from the backend print proxy (free text still allowed), the chosen
// printer is remembered in localStorage. Printing goes through
// dynamicPrint (one job per label), then each job is confirmed via
// waitForPrintJob before reporting success.
import {
  LABEL_TEMPLATE_ID,
  dynamicPrint,
  listPrinters,
  waitForPrintJob,
} from "~/utils/print";

const props = defineProps<{
  /** One entry per label; `title` is only shown in the dialog's summary list. */
  items: { title: string; params: Record<string, unknown> }[];
}>();
const emit = defineEmits<{ close: [] }>();

const printing = ref(false);
const dlg = useOverlayDismiss(() => {
  if (!printing.value) emit("close");
});

const printerName = ref(import.meta.client ? (localStorage.getItem("label_printer") ?? "") : "");
const printers = ref<string[]>([]);
const copies = ref(1);
const progress = ref("");
const error = ref("");
const done = ref(false);

// Non-fatal: without the list the printer field stays free text.
onMounted(async () => {
  try {
    printers.value = await listPrinters();
  } catch {
    printers.value = [];
  }
});

async function print() {
  const printer = printerName.value.trim();
  if (!printer || printing.value) return;
  printing.value = true;
  error.value = "";
  done.value = false;
  try {
    const res = await dynamicPrint({
      templateId: LABEL_TEMPLATE_ID,
      printingParams: props.items.map((i) => i.params),
      printerName: printer,
      copies: Math.max(1, copies.value),
    });
    const jobs = res.jobs ?? [];
    for (const [i, job] of jobs.entries()) {
      progress.value = `${i + 1} / ${jobs.length}`;
      await waitForPrintJob(job.jobId);
    }
    localStorage.setItem("label_printer", printer);
    done.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    printing.value = false;
    progress.value = "";
  }
}
</script>

<template>
  <div class="overlay" @mousedown="dlg.onMousedown" @click="dlg.onClick">
    <div class="dialog">
      <h2>{{ $t("admin.print.title", { count: items.length }) }}</h2>
      <ul class="print-items">
        <li v-for="(item, i) in items" :key="i">{{ item.title }}</li>
      </ul>
      <div class="form-row">
        <label for="pl-printer">{{ $t("admin.print.printer") }}</label>
        <input
          id="pl-printer"
          v-model="printerName"
          type="text"
          list="pl-printers"
          autocomplete="off"
          data-1p-ignore
          data-lpignore="true"
          :placeholder="$t('admin.print.printerPlaceholder')"
        />
        <datalist id="pl-printers">
          <option v-for="p in printers" :key="p" :value="p" />
        </datalist>
      </div>
      <div class="form-row">
        <label for="pl-copies">{{ $t("admin.print.copies") }}</label>
        <input id="pl-copies" v-model.number="copies" type="number" min="1" />
      </div>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <div v-if="done" class="success-banner">
        {{ $t("admin.print.success", { count: items.length }) }}
      </div>
      <div class="dialog-actions">
        <button class="btn" :disabled="printing" @click="emit('close')">
          {{ $t("admin.common.close") }}
        </button>
        <button class="btn btn-primary" :disabled="!printerName.trim() || printing" @click="print">
          {{ printing ? $t("admin.print.printing", { progress }) : $t("admin.print.print") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.print-items {
  margin: 0 0 14px;
  padding-left: 18px;
  max-height: 140px;
  overflow-y: auto;
  font-size: 13px;
  color: #374151;
}
.success-banner {
  padding: 8px 12px;
  border: 1px solid #86c8a0;
  border-radius: 6px;
  background: #ecf9f1;
  color: #1e7a46;
  font-size: 13px;
}
</style>
