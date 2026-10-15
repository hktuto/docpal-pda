<script setup lang="ts">
// Shared print dialog for client-rendered image labels (shelf labels). Each
// item renders itself to a PNG here and is printed via /print/files — the same
// route as the shelf-box labels and user badges — one print job per label,
// each confirmed via waitForPrintJob before reporting success. The printer
// picker lists the print service's agent printers; the chosen printer is
// remembered in localStorage.
import {
  activeLabelSizes,
  listPrinters,
  parsePrinterKey,
  printFile,
  printerKey,
  waitForPrintJob,
  type LabelSizeId,
  type PrinterInfo,
} from "~/utils/print";
import { useWarehouseLabelLayout } from "~/composables/useWarehouseLabelLayout";

const props = defineProps<{
  /** One entry per label; `title` is only shown in the dialog's summary list. */
  items: { title: string; render: (size: LabelSizeId) => Promise<Blob>; filename: string }[];
}>();
const emit = defineEmits<{ close: [] }>();

// Loads the warehouse /config so the size dropdown below shows this
// instance's catalog (SZ's four stock sizes vs HK's die-cut 24-up sheet);
// the layout itself is applied by the host's render callbacks.
useWarehouseLabelLayout();

const { t } = useI18n();
// Label size — per-warehouse catalog (SZ: 53 x 16 / 68 x 35 / 104 x 35 /
// 104 x 40 mm; HK: the die-cut 24-up A4 sheet), remembered across dialogs.
const size = useLabelSize();
const sizeOptions = computed(() =>
  activeLabelSizes.value.map((s) => ({ value: s.id, label: t(`admin.print.sizes.${s.id}`) }))
);

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

// Non-fatal: without the list the picker stays empty (a remembered printer
// key still shows, falling back to its raw value).
onMounted(async () => {
  try {
    printers.value = await listPrinters();
  } catch {
    printers.value = [];
  }
});

async function print() {
  const printer = selectedPrinter.value;
  if (!printer || printing.value) return;
  printing.value = true;
  error.value = "";
  done.value = false;
  try {
    for (const [i, item] of props.items.entries()) {
      progress.value = `${i + 1} / ${props.items.length}`;
      const png = await item.render(size.value);
      const job = await printFile(png, item.filename, {
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
    <div class="dialog">
      <button type="button" class="dialog-close" @click="emit('close')" aria-label="Close">&times;</button>
      <h2>{{ $t("admin.print.title", { count: items.length }) }}</h2>
      <ul class="print-items">
        <li v-for="(item, i) in items" :key="i">{{ item.title }}</li>
      </ul>
      <div class="form-row">
        <label for="pl-printer">{{ $t("admin.print.printer") }}</label>
        <SearchableSelect
          id="pl-printer"
          v-model="printerName"
          :options="printers.map((p) => ({ value: printerKey(p), label: p.alias || p.name }))"
          :all-label="$t('admin.print.printerPlaceholder')"
          :aria-label="$t('admin.print.printer')"
          :multiple="false"
          :show-all="false"
        />
      </div>
      <div class="form-row">
        <label for="pl-size">{{ $t("admin.print.size") }}</label>
        <select id="pl-size" v-model="size">
          <option v-for="opt in sizeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
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
        <button class="btn btn-primary" :disabled="!selectedPrinter || printing" @click="print">
          {{ printing ? $t("admin.print.printing", { progress }) : $t("admin.print.print") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.print-items {
  margin: 0 0 0.875rem;
  padding-left: 1.125rem;
  max-height: 8.75rem;
  overflow-y: auto;
  font-size: 0.8125rem;
  color: #374151;
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
