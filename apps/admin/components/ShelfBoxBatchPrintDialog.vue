<script setup lang="ts">
// Batch A4 shelf-box label print: the selected box ids are laid out 3 x 8 per
// A4 page (QR on the left encoding the box id, box id text on the right — the
// same layout as the single box label and the shelf labels), each page
// rendered to a PNG here and printed via /print/files — one print job per
// page, each confirmed via waitForPrintJob before reporting success. The
// printer picker lists the print service's agent printers; the chosen printer
// is remembered in localStorage.
import {
  listPrinters,
  parsePrinterKey,
  printFile,
  printerKey,
  renderShelfBoxBatchPagePng,
  SHELF_BATCH_CELLS_PER_PAGE,
  waitForPrintJob,
  type PrinterInfo,
} from "~/utils/print";
import { useWarehouseLabelLayout } from "~/composables/useWarehouseLabelLayout";

const { layout: labelLayout } = useWarehouseLabelLayout();

const props = defineProps<{
  boxIds: string[];
}>();
const emit = defineEmits<{ close: [] }>();

const printing = ref(false);
const dlg = useOverlayDismiss(() => {
  if (!printing.value) emit("close");
});

const printerName = ref(import.meta.client ? (localStorage.getItem("label_printer") ?? "") : "");
const printers = ref<PrinterInfo[]>([]);
const copies = ref(1);
const progress = ref("");
const error = ref("");
const done = ref(false);

// Selected printer as "<serviceId>.<deviceKey>" (the picker value); free text
// is not printable — /print/files needs the serviceId + deviceKey pair.
const selectedPrinter = computed(() => parsePrinterKey(printerName.value.trim()));

// One blob per A4 page; object URLs back the preview images.
const pageBlobs: Blob[] = [];
const previews = ref<string[]>([]);

onMounted(async () => {
  try {
    printers.value = await listPrinters();
  } catch {
    printers.value = [];
  }
  for (let i = 0; i < props.boxIds.length; i += SHELF_BATCH_CELLS_PER_PAGE) {
    const png = await renderShelfBoxBatchPagePng(
      props.boxIds.slice(i, i + SHELF_BATCH_CELLS_PER_PAGE),
      labelLayout.value
    );
    pageBlobs.push(png);
    previews.value.push(URL.createObjectURL(png));
  }
});

onBeforeUnmount(() => previews.value.forEach((u) => URL.revokeObjectURL(u)));

async function print() {
  const printer = selectedPrinter.value;
  if (!printer || printing.value) return;
  printing.value = true;
  error.value = "";
  done.value = false;
  try {
    for (const [i, png] of pageBlobs.entries()) {
      progress.value = `${i + 1} / ${pageBlobs.length}`;
      const job = await printFile(png, `box-labels-page-${i + 1}.png`, {
        serviceId: printer.serviceId,
        deviceKey: printer.deviceKey,
        copies: Math.max(1, copies.value),
      });
      await waitForPrintJob(job.jobId);
    }
    localStorage.setItem("label_printer", printerName.value.trim());
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
    <div class="dialog shelf-batch-dialog">
      <h2>{{ $t("admin.print.batchTitle", { count: boxIds.length }) }}</h2>
      <div class="shelf-sheet-preview">
        <img v-for="(src, pi) in previews" :key="pi" :src="src" :alt="`page ${pi + 1}`" />
      </div>
      <div class="form-row">
        <label for="sbb-printer">{{ $t("admin.print.printer") }}</label>
        <input
          id="sbb-printer"
          v-model="printerName"
          type="text"
          list="sbbp-printers"
          autocomplete="off"
          data-1p-ignore
          data-lpignore="true"
          :placeholder="$t('admin.print.printerPlaceholder')"
        />
        <datalist id="sbbp-printers">
          <option v-for="p in printers" :key="printerKey(p)" :label="p.alias || p.name" :value="printerKey(p)" />
        </datalist>
      </div>
      <div class="form-row">
        <label for="sbbp-copies">{{ $t("admin.print.copies") }}</label>
        <input id="sbbp-copies" v-model.number="copies" type="number" min="1" />
      </div>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <div v-if="done" class="success-banner">
        {{ $t("admin.print.success", { count: boxIds.length }) }}
      </div>
      <div class="dialog-actions">
        <button class="btn" :disabled="printing" @click="emit('close')">
          {{ $t("admin.common.close") }}
        </button>
        <button class="btn btn-primary" :disabled="!selectedPrinter || !pageBlobs.length || printing" @click="print">
          {{ printing ? $t("admin.print.printing", { progress }) : $t("admin.print.print") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shelf-batch-dialog {
  width: min(47.5rem, 100%);
}
.shelf-sheet-preview {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-bottom: 0.875rem;
  padding: 1rem;
  max-height: 50vh;
  overflow-y: auto;
  background: #e5e7eb;
  border-radius: 0.375rem;
}
.shelf-sheet-preview img {
  display: block;
  width: 100%;
  background: #fff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}
.success-banner {
  padding: 0.5rem 0.75rem;
  border: 1px solid #86c8a0;
  border-radius: 0.375rem;
  background: #ecf9f1;
  color: #1e7a46;
  font-size: 0.8125rem;
}
</style>
