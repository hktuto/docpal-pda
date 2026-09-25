<script setup lang="ts">
// Batch A4 shelf-label print: the selected shelves are laid out 3 x 4 per A4
// page (QR + shelf code + zone per cell), each page rendered to a PNG here
// and printed via /print/files — one print job per page, each confirmed via
// waitForPrintJob before reporting success. The printer picker lists the
// print service's agent printers; the chosen printer is remembered in
// localStorage.
import {
  listPrinters,
  parsePrinterKey,
  printFile,
  printerKey,
  renderShelfBatchPagePng,
  SHELF_BATCH_CELLS_PER_PAGE,
  waitForPrintJob,
  type PrinterInfo,
} from "~/utils/print";

const props = defineProps<{
  items: { code: string; zone?: string | null }[];
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
  for (let i = 0; i < props.items.length; i += SHELF_BATCH_CELLS_PER_PAGE) {
    const png = await renderShelfBatchPagePng(props.items.slice(i, i + SHELF_BATCH_CELLS_PER_PAGE));
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
      const job = await printFile(png, `shelf-labels-page-${i + 1}.png`, {
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
      <h2>{{ $t("admin.print.batchTitle", { count: items.length }) }}</h2>
      <div class="shelf-sheet-preview">
        <img v-for="(src, pi) in previews" :key="pi" :src="src" :alt="`page ${pi + 1}`" />
      </div>
      <div class="form-row">
        <label for="sb-printer">{{ $t("admin.print.printer") }}</label>
        <input
          id="sb-printer"
          v-model="printerName"
          type="text"
          list="sbp-printers"
          autocomplete="off"
          data-1p-ignore
          data-lpignore="true"
          :placeholder="$t('admin.print.printerPlaceholder')"
        />
        <datalist id="sbp-printers">
          <option v-for="p in printers" :key="printerKey(p)" :label="p.alias || p.name" :value="printerKey(p)" />
        </datalist>
      </div>
      <div class="form-row">
        <label for="sbp-copies">{{ $t("admin.print.copies") }}</label>
        <input id="sbp-copies" v-model.number="copies" type="number" min="1" />
      </div>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <div v-if="done" class="success-banner">
        {{ $t("admin.print.success", { count: items.length }) }}
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
