<template>
  <div class="print-product-label">
    <div class="card">
      <label class="field">
        <span class="field__label">{{ $t("printProductLabel.brand") }}</span>
        <input
          v-model="brand"
          type="text"
          autocomplete="off"
          :placeholder="$t('common.all')"
          @focus="brandOpen = true"
          @blur="brandOpen = false"
        />
        <!-- Type-to-search over the distinct-brand list (filtered locally). -->
        <ul v-if="brandOpen && brandSuggestions.length" class="part-suggestions">
          <li v-for="b in brandSuggestions" :key="b">
            <button type="button" @mousedown.prevent="pickBrand(b)">{{ b }}</button>
          </li>
        </ul>
      </label>
      <label class="field">
        <span class="field__label">{{ $t("printProductLabel.product") }}</span>
        <input
          v-model="product"
          type="text"
          autocomplete="off"
          @focus="queueSearch"
          @input="queueSearch"
          @blur="listOpen = false"
        />
        <!-- Type-to-search suggestions: server ILIKE, narrowed by brand. -->
        <ul v-if="listOpen && partResults.length" class="part-suggestions">
          <li v-for="p in partResults" :key="p.partNo">
            <button type="button" @mousedown.prevent="pickPart(p)">
              {{ p.partNo }}<span v-if="p.description" class="part-suggestions__desc"> — {{ p.description }}</span>
            </button>
          </li>
        </ul>
      </label>
      <label class="field">
        <span class="field__label">{{ $t("printProductLabel.qty") }}</span>
        <input v-model="qty" type="number" min="0" />
      </label>
      <label class="field">
        <span class="field__label">{{ $t("printProductLabel.dateCode") }}</span>
        <input v-model.trim="dateCode" type="text" autocomplete="off" />
      </label>
      <label class="field">
        <span class="field__label">{{ $t("printProductLabel.drawNo") }}</span>
        <input v-model.trim="drawNo" type="text" autocomplete="off" />
      </label>
      <button type="button" class="btn btn--ghost scan-btn" @click="scanWithCamera">
        {{ $t("printProductLabel.scanHint") }}
      </button>
    </div>

    <!-- Printer + print only appear once the product is known (mock screen 2). -->
    <div v-if="product" class="card">
      <label class="field">
        <span class="field__label">{{ $t("picking.printLabels.printer") }}</span>
        <select v-model="printerName">
          <option value="">{{ $t("picking.printLabels.printerDefault") }}</option>
          <option v-for="p in printers" :key="printerKey(p)" :value="printerKey(p)">
            {{ p.alias || p.name || p.deviceKey }}
          </option>
        </select>
      </label>
      <button type="button" class="btn print-btn" @click="print">
        {{ $t("picking.printLabels.print") }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
// Print Product Label (打印產品標籤, mock docs-newFlow/打印產品標籤.png):
// brand + part are both type-to-search comboboxes (brand list filtered
// locally, parts searched server-side and narrowed by brand) + qty / date
// code / drawing no. typed. A label scan prefills — hardware scans
// auto-deliver, the camera path is the "or scan the product" button; decode
// goes through the backend authority (utils/labelDecode.ts).
// The printer picker reuses the label-print panel's list + "label_printer"
// preference.
import { useWarehouse } from "~/composables/useWarehouse";
import { useToast } from "~/composables/useToast";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { captureLabel } from "~/composables/useLabelScan";
import { decodeLabel } from "~/utils/labelDecode";
import { parseAndIdentify, type OcrParseResult } from "~/utils/parseOcrScan";
import { listPrinters, printerKey, type PrinterInfo } from "~/utils/print";
import type { PartOption } from "~/services/types";

definePageMeta({ title: "meta.printProductLabel" });

const { t } = useI18n();
useHead({ title: t("printProductLabel.title") });

const warehouse = useWarehouse();
const { showToast } = useToast();

const brand = ref("");
const product = ref("");
const qty = ref("");
const dateCode = ref("");
const drawNo = ref("");

// Brand dropdown comes from the distinct parts.brand list (reused ad-hoc
// put-away endpoint). The part field is a type-to-search box: each keystroke
// (debounced) queries GET /parts, narrowed by the chosen brand, showing ≤ 50
// matches — the full ~100k-row master never ships to the PDA.
const brands = ref<string[]>([]);
const brandOpen = ref(false);
// Brand suggestions filter the cached distinct-brand list locally — the list
// is small, no server round-trip needed.
const brandSuggestions = computed(() => {
  const term = brand.value.trim().toLowerCase();
  return term ? brands.value.filter((b) => b.toLowerCase().includes(term)) : brands.value;
});

function pickBrand(b: string) {
  brand.value = b;
  brandOpen.value = false;
}

const partResults = ref<PartOption[]>([]);
const listOpen = ref(false);

// Monotonic request id — a slower earlier response must not overwrite a newer
// one (out-of-order debounce hits).
let searchSeq = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

async function runPartSearch() {
  const seq = ++searchSeq;
  try {
    const rows = await warehouse.getParts({
      search: product.value.trim() || undefined,
      brand: brand.value.trim() || undefined,
    });
    if (seq === searchSeq) partResults.value = rows;
  } catch {
    if (seq === searchSeq) partResults.value = [];
  }
}

function queueSearch() {
  listOpen.value = true;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(runPartSearch, 250);
}

function pickPart(p: PartOption) {
  product.value = p.partNo;
  if (!brand.value && p.brand) brand.value = p.brand;
  listOpen.value = false;
}

// Re-narrow the open suggestion list when the brand changes.
watch(brand, () => {
  if (listOpen.value) runPartSearch();
});

// Printer picker — same "label_printer" localStorage key as the label-print
// panel, so the bench page and this page share one remembered printer.
const printerName = ref(import.meta.client ? (localStorage.getItem("label_printer") ?? "") : "");
const printers = ref<PrinterInfo[]>([]);

watch(printerName, (value) => {
  if (import.meta.client) localStorage.setItem("label_printer", value);
});

// Non-fatal: without the lists the fields stay empty until the user types.
onMounted(async () => {
  try {
    printers.value = await listPrinters();
  } catch {
    printers.value = [];
  }
  try {
    brands.value = await warehouse.getAdHocPutAwayBrands();
  } catch {
    brands.value = [];
  }
});

/** Fill the form from a decoded label; false → nothing recognised (error buzz). */
async function applyScan(result: OcrParseResult): Promise<boolean> {
  if (!result.matched || !result.parsed.itemId) return false;
  const scanned = result.parsed.itemId;
  // Resolve the scanned value to the canonical master part_no + brand so it
  // lands on a dropdown option (a bare wcl/drawno otherwise would not).
  const master = await warehouse.lookupAdHocPutAwayPart(scanned);
  product.value = master?.partNo ?? scanned;
  if (master?.brand) brand.value = master.brand;
  else if (result.supplier?.brands?.length) brand.value = result.supplier.brands[0];
  if (result.parsed.qty != null) qty.value = String(result.parsed.qty);
  if (result.parsed.dateCode) dateCode.value = result.parsed.dateCode;
  return Boolean(product.value);
}

// Hardware scan (Movfast broadcast / Honeywell / keyboard wedge) prefills.
useHardwareScanner({
  onScan: async (code) => applyScan(await decodeLabel(warehouse, code)),
});

// Camera path — same capture → single-barcode decode flow as ad-hoc put-away.
async function scanWithCamera() {
  const capture = await captureLabel();
  if (!capture) return;
  const barcodes = JSON.parse(capture.barcodes || "[]");
  const single = barcodes.length === 1 ? barcodes[0] : undefined;
  const result = single
    ? await decodeLabel(warehouse, single.value)
    : parseAndIdentify({ text: capture.text, barcodes }, []);
  if (!(await applyScan(result))) showToast(t("printProductLabel.scanError"));
}

async function print() {
  // shortcut: the real print call + part→label-template mapping are TBD;
  // build the payload from the form fields + parsePrinterKey(printerName)
  // and POST it when they are supplied.
  showToast(t("printProductLabel.notWired"));
}
</script>

<style scoped>
.field {
  position: relative;
  display: block;
  margin-bottom: 0.875rem;
}

.part-suggestions {
  position: absolute;
  z-index: 20;
  left: 0;
  right: 0;
  top: 100%;
  max-height: 12rem;
  overflow-y: auto;
  margin: 0.25rem 0 0;
  padding: 0;
  list-style: none;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 4px 12px rgb(0 0 0 / 12%);
}

.part-suggestions button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.625rem 1rem;
  font-size: 0.9375rem;
  background: none;
  border: none;
  color: inherit;
}

.part-suggestions button:hover {
  background: var(--bg, #f3f4f6);
}

.part-suggestions__desc {
  color: var(--muted);
  font-size: 0.875rem;
}

.field__label {
  display: block;
  font-size: 0.9375rem;
  font-weight: 600;
  margin-bottom: 0.375rem;
}

.field select {
  width: 100%;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 1rem;
  background: var(--surface);
}

.scan-btn {
  display: block;
  width: 100%;
  margin-top: 0.25rem;
}

.print-btn {
  width: 100%;
}
</style>
