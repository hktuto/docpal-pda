<script setup lang="ts">
// Print dialog for client-rendered A4 documents (CR-049, spec
// docs/superpowers/specs/2026-11-06-admin-document-png-print-design.md) —
// the CN receiving confirmation and the picking list. Modeled on
// PrintLabelsDialog.vue: the host passes a `build` callback producing the
// PrintDocument, this dialog renders the pages to PNGs (the preview
// thumbnails are the actual print pages downscaled by the browser — what
// you see is what prints) and sends them via /print/files. The print
// service accepts exactly ONE file per job (file/filePath/pdfPath/
// imagePath are mutually exclusive, docs/backend/print-service.md), so
// pages print as sequential per-page jobs, each confirmed via
// waitForPrintJob. The chosen printer is remembered in the `doc_printer`
// localStorage key (documents and labels live on different machines).
import {
  loadDocPrinter,
  renderDocumentPngs,
  saveDocPrinter,
  type PrintDocument,
} from "~/utils/documentPrint";
import {
  listPrinters,
  parsePrinterKey,
  printFile,
  printerKey,
  waitForPrintJob,
  type PrinterInfo,
} from "~/utils/print";

const props = defineProps<{
  /** Produces the document to print (may fetch; errors surface in the dialog). */
  build: () => Promise<PrintDocument>;
  /** Print-job file name prefix — pages upload as `${filenameBase}-p${i}.png`. */
  filenameBase: string;
}>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

const printing = ref(false);
const dlg = useOverlayDismiss(() => {
  if (!printing.value) emit("close");
});

const printerName = ref(loadDocPrinter());
const printers = ref<PrinterInfo[]>([]);
const copies = ref(1);
const progress = ref("");
const error = ref("");
const done = ref(false);

// Preview state: the built document's full-resolution page PNGs, shown
// downscaled and reused verbatim for printing.
const preparing = ref(false);
const buildError = ref("");
const pageBlobs = ref<Blob[]>([]);
const previews = ref<string[]>([]); // object URLs into pageBlobs

// Selected printer as "<serviceId>.<deviceKey>" (the picker value); free text
// is not printable — /print/files needs the serviceId + deviceKey pair.
const selectedPrinter = computed(() => parsePrinterKey(printerName.value.trim()));

function clearPreviews() {
  for (const url of previews.value) URL.revokeObjectURL(url);
  previews.value = [];
  pageBlobs.value = [];
}

async function prepare() {
  if (preparing.value || printing.value) return;
  preparing.value = true;
  buildError.value = "";
  done.value = false;
  clearPreviews();
  try {
    const doc = await props.build();
    const blobs = await renderDocumentPngs(doc);
    pageBlobs.value = blobs;
    previews.value = blobs.map((b) => URL.createObjectURL(b));
  } catch (e) {
    buildError.value = e instanceof Error ? e.message : String(e);
  } finally {
    preparing.value = false;
  }
}

// Non-fatal: without the printer list the picker stays empty (a remembered
// printer key still shows, falling back to its raw value).
onMounted(async () => {
  await prepare();
  try {
    printers.value = await listPrinters();
  } catch {
    printers.value = [];
  }
});

onBeforeUnmount(clearPreviews);

async function print() {
  const printer = selectedPrinter.value;
  if (!printer || printing.value || pageBlobs.value.length === 0) return;
  printing.value = true;
  error.value = "";
  done.value = false;
  try {
    for (const [i, blob] of pageBlobs.value.entries()) {
      progress.value = t("admin.printDoc.page", { n: i + 1, total: pageBlobs.value.length });
      const job = await printFile(blob, `${props.filenameBase}-p${i + 1}.png`, {
        serviceId: printer.serviceId,
        deviceKey: printer.deviceKey,
        copies: Math.max(1, copies.value),
      });
      await waitForPrintJob(job.jobId);
    }
    saveDocPrinter(printerName.value.trim());
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
      <button type="button" class="dialog-close" @click="emit('close')" aria-label="Close">&times;</button>
      <h2>{{ $t("admin.printDoc.title") }}</h2>

      <div class="doc-previews">
        <p v-if="preparing" class="doc-preparing">{{ $t("admin.printDoc.preparing") }}</p>
        <div v-else-if="buildError" class="error-banner">{{ buildError }}</div>
        <template v-else>
          <figure v-for="(url, i) in previews" :key="url" class="doc-page">
            <img :src="url" :alt="$t('admin.printDoc.page', { n: i + 1, total: previews.length })" />
            <figcaption>{{ $t("admin.printDoc.page", { n: i + 1, total: previews.length }) }}</figcaption>
          </figure>
        </template>
      </div>
      <div class="form-row">
        <button class="btn" :disabled="preparing || printing" @click="prepare">
          {{ $t("admin.printDoc.refreshPreview") }}
        </button>
      </div>

      <div class="form-row">
        <label for="pd-printer">{{ $t("admin.print.printer") }}</label>
        <SearchableSelect
          id="pd-printer"
          v-model="printerName"
          :options="printers.map((p) => ({ value: printerKey(p), label: p.alias || p.name }))"
          :all-label="$t('admin.print.printerPlaceholder')"
          :aria-label="$t('admin.print.printer')"
          :multiple="false"
          :show-all="false"
        />
      </div>
      <div class="form-row">
        <label for="pd-copies">{{ $t("admin.print.copies") }}</label>
        <input id="pd-copies" v-model.number="copies" type="number" min="1" />
      </div>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <div v-if="done" class="success-banner">
        {{ $t("admin.printDoc.success", { count: pageBlobs.length }) }}
      </div>
      <div class="dialog-actions">
        <button class="btn" :disabled="printing" @click="emit('close')">
          {{ $t("admin.common.close") }}
        </button>
        <button
          class="btn btn-primary"
          :disabled="!selectedPrinter || printing || preparing || pageBlobs.length === 0"
          @click="print"
        >
          {{ printing ? $t("admin.printDoc.printing", { progress }) : $t("admin.printDoc.print") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.doc-previews {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  max-height: 22rem;
  overflow-y: auto;
  margin-bottom: 0.875rem;
}
.doc-preparing {
  margin: 0;
  font-size: 0.8125rem;
  color: #6b7280;
}
.doc-page {
  margin: 0;
  width: 16rem;
}
.doc-page img {
  width: 100%;
  border: 1px solid #d1d5db;
  border-radius: 0.25rem;
  background: #fff;
}
.doc-page figcaption {
  margin-top: 0.25rem;
  font-size: 0.75rem;
  color: #6b7280;
  text-align: center;
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
