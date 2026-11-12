<script setup lang="ts">
// Custom Print Label — CSV upload step: parse in the browser into JS objects
// keyed by the header names; Confirm converts them to A4-LWXY print params
// (utils/customLabelCsv.ts) paged 12 labels per A4 sheet, then a dialog shows
// the box/label counts, picks the printer, and sends the dynamic-print job.
import { parseCustomLabelCsv, convertToPrintData, type CustomLabelCsvError } from "~/utils/customLabelCsv";
import {
  listPrinters,
  parsePrinterKey,
  printDynamic,
  printerKey,
  waitForPrintJob,
  type PrinterInfo,
} from "~/utils/print";

const { t } = useI18n();
const PREVIEW_LIMIT = 10;
// LWXY A4 sticker template on the print service: a4-canvas with a 3x4 grid —
// printingParams is one entry per A4 page, each carrying up to 12 labels in
// its items[] (small labels first, then the box labels).
const CUSTOM_LABEL_TEMPLATE_ID = "a4-lwxy-3-4";
const CUSTOM_LABEL_PAGE_SLOTS = 12;
// Remembered printer for this page (separate from `label_printer` / `doc_printer`).
const CUSTOM_LABEL_PRINTER_KEY = "custom_label_printer";

const fileName = ref("");
const fileSize = ref(0);
const inputEl = ref()
const header = ref<string[]>([]);
const rows = ref<Record<string, string>[]>([]);
const errors = ref<CustomLabelCsvError[]>([]);
const parseError = ref("");
const parsed = ref(false);

function errorText(e: CustomLabelCsvError): string {
  if (e.kind === "empty") return t("admin.pages.customPrintLabel.emptyError");
  return t("admin.pages.customPrintLabel.rowCountError", {
    line: e.line,
    actual: e.actual,
    expected: e.expected,
  });
}

function cancel() {
  header.value = []
  rows.value = []
  errors.value = []
  parsed.value = false
  inputEl.value.value = ''
  fileName.value = ''
  fileSize.value = null;
}

async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  fileName.value = file?.name ?? "";
  fileSize.value = file?.size ?? 0;
  header.value = [];
  rows.value = [];
  errors.value = [];
  parseError.value = "";
  parsed.value = false;
  if (!file) return;
  parsed.value = true;
  try {
    const txt = await file.text()
    const res = await parseCustomLabelCsv(txt);
    header.value = res.header;
    rows.value = res.rows;
    errors.value = res.errors;
  } catch (err) {
    parseError.value = String(err);
  }
}

// Confirm dialog state: the converted labels are kept until the user picks a
// printer and prints (or cancels), so convertToPrintData runs only once.
const preparing = ref(false);
const confirmError = ref("");
const showConfirm = ref(false);
const boxCount = ref(0);
const smallLabelCount = ref(0);
const labelTotal = ref(0);
const printParams = ref<Record<string, unknown>[]>([]);

const printers = ref<PrinterInfo[]>([]);
const printerName = ref("");
const printing = ref(false);
const progress = ref("");
const printError = ref("");
const printDone = ref(false);

const selectedPrinter = computed(() => parsePrinterKey(printerName.value.trim()));

async function confirm() {
  if (preparing.value || rows.value.length === 0) return;
  preparing.value = true;
  confirmError.value = "";
  try {
    const { smalllabel, largeLabel } = await convertToPrintData(rows.value);
    boxCount.value = largeLabel.length ? largeLabel[largeLabel.length - 1].boxId : 0;
    smallLabelCount.value = smalllabel.length;
    labelTotal.value = smalllabel.length + largeLabel.length;
    const labels = largeLabel.reduce((ll, l) => {
      ll.push(l);// put the box label in front
      // then get all small lable in that box
      const relatedSmallLabel = smalllabel.filter(s => s.boxId === l.boxId && s.description === l.description && s.lotNo && l.lotNo)
      ll.push(...relatedSmallLabel);
      // if boxId is not last box add empty label
      if (l.boxId !== boxCount.value) {
        ll.push({})
      }
      return ll
    },[])
    // const labels = [...smalllabel, ...largeLabel];
    const pages: Record<string, unknown>[] = [];
    for (let i = 0; i < labels.length; i += CUSTOM_LABEL_PAGE_SLOTS) {
      pages.push({ items: labels.slice(i, i + CUSTOM_LABEL_PAGE_SLOTS) });
    }
    printParams.value = pages;
    showConfirm.value = true;
    printDone.value = false;
    printError.value = "";
    printerName.value = localStorage.getItem(CUSTOM_LABEL_PRINTER_KEY) ?? "";
    try {
      printers.value = await listPrinters();
    } catch {
      printers.value = [];
    }
  } catch (e) {
    confirmError.value = e instanceof Error ? e.message : String(e);
  } finally {
    preparing.value = false;
  }
}

function closeConfirm() {
  if (printing.value) return;
  showConfirm.value = false;
}
const dlg = useOverlayDismiss(closeConfirm);

async function print() {
  const printer = selectedPrinter.value;
  if (!printer || printing.value || printParams.value.length === 0) return;
  printing.value = true;
  printError.value = "";
  printDone.value = false;
  try {
    const res = await printDynamic({
      templateId: CUSTOM_LABEL_TEMPLATE_ID,
      printingParams: printParams.value,
      serviceId: printer.serviceId,
      deviceKey: printer.deviceKey,
    });
    for (const [i, job] of res.jobs.entries()) {
      progress.value = t("admin.pages.customPrintLabel.job", { n: i + 1, total: res.jobs.length });
      await waitForPrintJob(job.jobId);
    }
    localStorage.setItem(CUSTOM_LABEL_PRINTER_KEY, printerName.value.trim());
    printDone.value = true;
  } catch (e) {
    printError.value = e instanceof Error ? e.message : String(e);
  } finally {
    printing.value = false;
    progress.value = "";
  }
}
const sizeLabel = computed(() =>
  fileSize.value < 1024 ? `${fileSize.value} B` : `${(fileSize.value / 1024).toFixed(1)} KB`
);

</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ t("admin.pages.customPrintLabel.title") }}</h1>
    </div>

    <div v-if="!parsed" class="card">
      <p>{{ t("admin.pages.customPrintLabel.description") }}</p>
      <div class="form-row">
        <label for="custom-label-csv">{{ t("admin.pages.customPrintLabel.chooseFile") }}</label>
        <input id="custom-label-csv" ref="inputEl" type="file" accept=".csv,text/csv" @change="onFile" />
        <p v-if="fileName" class="hint">
          {{ t("admin.pages.customPrintLabel.selected", { name: fileName, size: sizeLabel }) }}
        </p>
      </div>
    </div>

    <template v-if="parsed">
      <div v-if="rows.length > 0" class="success-banner">
        {{ t("admin.pages.customPrintLabel.parsed", { count: rows.length }) }}
      </div>

      <div v-if="parseError || errors.length > 0" class="error-banner">
        <div>
          <div v-if="parseError">{{ parseError }}</div>
          <div v-for="e in errors" :key="e.line + String(e.actual)" :data-kind="e.kind">
            {{ errorText(e) }}
          </div>
        </div>
      </div>

      <template v-if="header.length > 0 && rows.length > 0">
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>#</th>
                <th v-for="h in header" :key="h">{{ h }}</th>
              </tr>
            </thead>
            <tbody class="overflowBody">
              <tr v-for="(row, i) in rows" :key="i">
                <td>{{ i + 1 }}</td>
                <td v-for="h in header" :key="h">{{ row[h] }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <div v-if="confirmError" class="error-banner">{{ confirmError }}</div>
      <div class="form-bottom">
        <button type="button" class="btn btn-small bug-btn" @click="cancel">{{ t("admin.common.cancel") }}</button>
        <button type="button" class="btn btn-small bug-btn" :disabled="preparing" @click="confirm">
          {{ preparing ? t("admin.pages.customPrintLabel.preparing") : t("admin.pages.customPrintLabel.confirm") }}
        </button>
      </div>
    </template>

    <div v-if="showConfirm" class="overlay" @mousedown="dlg.onMousedown" @click="dlg.onClick">
      <div class="dialog">
        <button type="button" class="dialog-close" :disabled="printing" @click="closeConfirm" aria-label="Close">&times;</button>
        <h2>{{ t("admin.pages.customPrintLabel.confirmTitle") }}</h2>
        <p>{{ t("admin.pages.customPrintLabel.confirmSummary", { boxes: boxCount, labels: smallLabelCount, total: labelTotal, pages: printParams.length }) }}</p>

        <div class="form-row">
          <label for="cl-printer">{{ t("admin.print.printer") }}</label>
          <SearchableSelect
            id="cl-printer"
            v-model="printerName"
            :options="printers.map((p) => ({ value: printerKey(p), label: p.alias || p.name }))"
            :all-label="t('admin.print.printerPlaceholder')"
            :aria-label="t('admin.print.printer')"
            :multiple="false"
            :show-all="false"
          />
        </div>

        <div v-if="printError" class="error-banner">{{ printError }}</div>
        <div v-if="printDone" class="success-banner">
          {{ t("admin.pages.customPrintLabel.printSuccess", { count: labelTotal, pages: printParams.length }) }}
        </div>

        <div class="dialog-actions">
          <button class="btn" :disabled="printing" @click="closeConfirm">
            {{ t("admin.common.close") }}
          </button>
          <button
            class="btn btn-primary"
            :disabled="!selectedPrinter || printing || printParams.length === 0"
            @click="print"
          >
            {{ printing ? t("admin.pages.customPrintLabel.printing", { progress }) : t("admin.print.print") }}
          </button>
        </div>
      </div>
    </div>

  </div>
</template>

<style lang="scss" scoped>
.table-wrap{
  max-height: 600px;
  overflow: auto;
}
.form-bottom{
  width:100%;
  display: flex;
  flex-flow: row nowarp;
  justify-content: flex-start;
  align-items: center;
  gap: 0.5rem;
  margin-top:2rem;
}
</style>
