<script setup lang="ts">
import type { AdminColumnDef } from "~/composables/useAdminTable";
import {
  fillMergedCells,
  parseCnReceivingAoa,
  type AoaMergeRange,
  type CnReceivingItem,
  type CnReceivingParseResult,
} from "~/utils/cnReceivingExcel";
import { submitCnExcelUpload } from "~/utils/flowApi";

const { t } = useI18n();

// Wizard: 1 = pick the Excel file, 2 = verify/edit the decoded payload and
// confirm — confirming uploads the file + verified JSON and starts the DocPal
// workflow in one go.
const step = ref<1 | 2>(1);
const fileInput = ref<HTMLInputElement | null>(null);
const parsing = ref(false);
const error = ref("");
const file = ref<File | null>(null);
const parsed = ref<CnReceivingParseResult | null>(null);

interface DraftItem extends CnReceivingItem {
  uid: number;
}
const items = ref<DraftItem[]>([]);
let nextUid = 1;

const header = ref({
  receivedOffice: "",
  supplier: "",
  receiptNo: "",
  invoiceNo: "",
  receivedDate: "",
});

function triggerPick() {
  fileInput.value?.click();
}

async function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const picked = input.files?.[0];
  input.value = ""; // reset so the same file can be re-selected
  if (!picked) return;
  await handleFile(picked);
}

// ---- step 1 drag & drop ----

const dragOver = ref(false);
let dragDepth = 0;

function onDragEnter(e: DragEvent) {
  e.preventDefault();
  dragDepth++;
  dragOver.value = true;
}

function onDragLeave(e: DragEvent) {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragOver.value = false;
}

function onDragOver(e: DragEvent) {
  e.preventDefault(); // required so the drop event fires
}

async function onDrop(e: DragEvent) {
  e.preventDefault();
  dragDepth = 0;
  dragOver.value = false;
  if (parsing.value) return;
  const dropped = e.dataTransfer?.files?.[0];
  if (!dropped) return;
  const name = dropped.name.toLowerCase();
  if (!name.endsWith(".xls") && !name.endsWith(".xlsx")) {
    error.value = t("admin.pages.receivingCn.invalidFileType");
    return;
  }
  await handleFile(dropped);
}

async function handleFile(picked: File) {
  parsing.value = true;
  error.value = "";
  try {
    const XLSX = await import("xlsx");
    const buf = await picked.arrayBuffer();
    const wb = XLSX.read(buf);
    // Some workbooks lead with an empty cover sheet (e.g. 入数) — scan every
    // sheet and use the first one whose item table actually decodes.
    let result: CnReceivingParseResult | null = null;
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
      if (aoa.length === 0) continue;
      // Merged cells (e.g. the poNo 发货项 / carton 箱数 columns spanning an
      // item group) carry their value only in the top-left cell — fill the
      // range before parsing; `filled` marks filled-in cells so a merged
      // carton count counts once toward the totals cross-check.
      const merged = fillMergedCells(aoa as unknown[][], (ws["!merges"] as AoaMergeRange[] | undefined) ?? []);
      const parsed = parseCnReceivingAoa(merged.aoa, merged.filled);
      if (parsed.items.length > 0) {
        result = parsed;
        break;
      }
      result ??= parsed; // keep the first decode for the error path below
    }
    if (!result || result.items.length === 0) {
      throw new Error(t("admin.pages.receivingCn.noItems"));
    }
    file.value = picked;
    parsed.value = result;
    header.value = {
      receivedOffice: result.receivedOffice,
      supplier: result.supplier,
      receiptNo: result.receiptNo,
      invoiceNo: result.invoiceNo,
      receivedDate: result.receivedDate,
    };
    items.value = result.items.map((item) => ({ ...item, uid: nextUid++ }));
    error.value = "";
    step.value = 2;
  } catch (e: any) {
    file.value = null;
    parsed.value = null;
    error.value = e?.message ?? String(e);
  } finally {
    parsing.value = false;
  }
}

// ---- step 2: verify/edit ----

const columnDefs = computed<AdminColumnDef<DraftItem>[]>(() => [
  { key: "index", label: t("admin.pages.receivingCn.fields.index"), size: 56 },
  { key: "orderNo", label: t("admin.pages.receivingCn.fields.orderNo"), size: 130 },
  { key: "cartonNo", label: t("admin.pages.receivingCn.fields.cartonNo"), size: 80 },
  { key: "partNo", label: t("admin.pages.receivingCn.fields.partNo"), size: 220 },
  { key: "dateCode", label: t("admin.pages.receivingCn.fields.dateCode"), size: 90 },
  { key: "qty", label: t("admin.pages.receivingCn.fields.qty"), size: 90 },
  { key: "weight", label: t("admin.pages.receivingCn.fields.weight"), size: 90 },
  { key: "office", label: t("admin.pages.receivingCn.fields.office"), size: 100 },
  { key: "poNo", label: t("admin.pages.receivingCn.fields.poNo"), size: 120 },
  { key: "remark", label: t("admin.pages.receivingCn.fields.remark"), size: 140 },
  { key: "actions", label:t("admin.common.actions"), size: 120}
]);

const { table, resetColumnState } = useAdminTable<DraftItem>({
  tableId: "receiving-cn-new-items",
  columns: columnDefs,
  rows: items,
  getRowId: (r) => String(r.uid),
  // One page holds the whole sheet — the wizard has no pager.
  defaultPageSize: 500,
});

function removeItem(row: DraftItem) {
  items.value = items.value.filter((i) => i.uid !== row.uid);
}

function nextIndex(): number {
  return items.value.reduce((max, i) => Math.max(max, i.index), 0) + 1;
}

function addItem() {
  items.value.push({
    uid: nextUid++,
    index: nextIndex(),
    orderNo: "",
    cartonNo: "",
    partNo: "",
    dateCode: "",
    qty: "",
    weight: "",
    office: "",
    poNo: "",
    remark: "",
  });
}

function num(value: string): number {
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : 0;
}

// Cross-check: Σ edited items vs the sheet's printed 合计 row (fallback: the
// Σ captured at parse time). Warning-level only — submit stays allowed. Uses
// the same merge-aware sums as the displayed itemTotals, so the banner never
// fires when the numbers it shows are equal.
const itemTotals = computed(() => ({
  // Merge-filled carton cells (cartonMerged) show the group count on every
  // covered row but count once, matching the sheet's printed 合计.
  carton: items.value.reduce((s, i) => s + (i.cartonMerged ? 0 : num(i.cartonNo)), 0),
  qty: items.value.reduce((s, i) => s + num(i.qty), 0),
}));

const totalsMismatch = computed(() => {
  const sheet = parsed.value?.sheetTotals ?? parsed.value?.totals;
  if (!sheet) return false;
  return itemTotals.value.carton !== sheet.carton || itemTotals.value.qty !== sheet.qty;
});

const sheetTotalsLabel = computed(() => {
  const sheet = parsed.value?.sheetTotals ?? parsed.value?.totals;
  return sheet ? `${sheet.carton} / ${sheet.qty}` : "—";
});

function backToPick() {
  step.value = 1;
}

// ---- confirm: upload + start the workflow ----

const submitting = ref(false);

async function submit() {
  if (!file.value || submitting.value) return;
  submitting.value = true;
  error.value = "";
  try {
    const payload = {
      receivedOffice: header.value.receivedOffice.trim(),
      supplier: header.value.supplier.trim(),
      receiptNo: header.value.receiptNo.trim(),
      invoiceNo: header.value.invoiceNo.trim(),
      receivedDate: header.value.receivedDate,
      // Wire contract (DocPal workflow template): the submitted keys are
      // swapped relative to the sheet/UI — the 訂單號 cell value is sent as
      // `poNo` and the 发货项 cell value as `orderNo`. The UI above stays
      // labeled/parsed as the sheet presents it.
      items: items.value.map(({ uid: _uid, cartonMerged: _cm, orderNo, poNo, ...rest }) => ({ ...rest, orderNo: poNo, poNo: orderNo })),
    };
    await submitCnExcelUpload(file.value, payload);
    await navigateTo("/receiving-cn");
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    submitting.value = false;
  }
}

function cancel() {
  navigateTo("/receiving-cn");
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.receivingCn.newTitle") }}</h1>
      <div class="head-actions">
        <button class="btn" @click="cancel">{{ $t("admin.common.cancel") }}</button>
      </div>
    </div>

    <div class="steps">
      <span :class="['step', { active: step === 1 }]">1. {{ $t("admin.pages.receivingCn.stepUpload") }}</span>
      <span :class="['step', { active: step === 2 }]">2. {{ $t("admin.pages.receivingCn.stepVerify") }}</span>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <!-- Step 1: pick the Excel (click to browse or drag & drop) -->
    <div v-if="step === 1" class="panel">
      <div
        class="dropzone"
        :class="{ over: dragOver }"
        role="button"
        tabindex="0"
        @click="triggerPick"
        @keydown.enter.prevent="triggerPick"
        @dragenter="onDragEnter"
        @dragleave="onDragLeave"
        @dragover="onDragOver"
        @drop="onDrop"
      >
        <p class="hint">{{ $t("admin.pages.receivingCn.uploadHint") }}</p>
        <p class="drop-hint">{{ $t("admin.pages.receivingCn.dropHint") }}</p>
        <button class="btn btn-primary" :disabled="parsing" @click.stop="triggerPick">
          {{ parsing ? $t("admin.common.loading") : $t("admin.pages.receivingCn.pickFile") }}
        </button>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept=".xls,.xlsx"
        style="display: none"
        @change="onFilePicked"
      />
    </div>

    <!-- Step 2: verify/edit -->
    <div v-else-if="step === 2" class="panel">
      <div class="parse-summary">
        <div>
          <span class="dt">{{ $t("admin.pages.receivingCn.supplier") }}:</span>
          {{ header.supplier || "—" }}
        </div>
        <div>
          <span class="dt">{{ $t("admin.pages.receivingCn.invoiceNo") }}:</span>
          {{ header.invoiceNo || "—" }}
        </div>
        <div>
          <span class="dt">{{ $t("admin.pages.receivingCn.itemCount") }}:</span>
          {{ items.length }}
        </div>
        <div v-if="file">
          <span class="dt">{{ $t("admin.pages.receivingCn.filename") }}:</span>
          {{ file.name }}
        </div>
      </div>

      <fieldset class="header-form">
        <div class="form-row">
          <label for="cn-receivedOffice">{{ $t("admin.pages.receivingCn.fields.receivedOffice") }}</label>
          <input id="cn-receivedOffice" v-model="header.receivedOffice" type="text" />
        </div>
        <div class="form-row">
          <label for="cn-supplier">{{ $t("admin.pages.receivingCn.fields.supplier") }}</label>
          <input id="cn-supplier" v-model="header.supplier" type="text" />
        </div>
        <div class="form-row">
          <label for="cn-invoiceNo">{{ $t("admin.pages.receivingCn.fields.invoiceNo") }}</label>
          <input id="cn-invoiceNo" v-model="header.invoiceNo" type="text" />
        </div>
        <div class="form-row">
          <label for="cn-receiptNo">{{ $t("admin.pages.receivingCn.fields.receiptNo") }}</label>
          <input id="cn-receiptNo" v-model="header.receiptNo" type="text" />
        </div>
        <div class="form-row">
          <label for="cn-receivedDate">{{ $t("admin.pages.receivingCn.fields.receivedDate") }}</label>
          <input id="cn-receivedDate" v-model="header.receivedDate" type="date" />
        </div>
      </fieldset>

      <div v-if="totalsMismatch" class="error-banner">
        {{
          $t("admin.pages.receivingCn.totalsMismatch", {
            carton: itemTotals.carton,
            qty: itemTotals.qty,
            sheet: sheetTotalsLabel,
          })
        }}
      </div>

      <div class="table-actions">
        <button class="btn" @click="addItem">{{ $t("admin.pages.receivingCn.addItem") }}</button>
      </div>

      <DataTable :table="table" :empty-text="$t('admin.pages.receivingCn.noItems')" :on-reset-columns="resetColumnState">
        <template #cell-index="{ row }">{{ row.index }}</template>
        <template #cell-orderNo="{ row }">
          <input v-model="row.orderNo" class="cell-input" type="text" />
        </template>
        <template #cell-cartonNo="{ row }">
          <input v-model="row.cartonNo" class="cell-input" type="text" />
        </template>
        <template #cell-partNo="{ row }">
          <ReceivingCnPartNoSelect v-model="row.partNo" />
        </template>
        <template #cell-dateCode="{ row }">
          <input v-model="row.dateCode" class="cell-input" type="number" inputmode="numeric" />
        </template>
        <template #cell-qty="{ row }">
          <input v-model="row.qty" class="cell-input" type="number" inputmode="numeric" min="1" step="1" />
        </template>
        <template #cell-weight="{ row }">
          <input v-model="row.weight" class="cell-input" type="text" inputmode="decimal" />
        </template>
        <template #cell-office="{ row }">
          <input v-model="row.office" class="cell-input" type="text" />
        </template>
        <template #cell-poNo="{ row }">
          <input v-model="row.poNo" class="cell-input" type="text" />
        </template>
        <template #cell-remark="{ row }">
          <input v-model="row.remark" class="cell-input" type="text" />
        </template>
        <template #cell-actions="{ row }">
          <button class="btn btn-small btn-danger" @click="removeItem(row)">{{ $t("admin.common.delete") }}</button>
        </template>
      </DataTable>

      <div class="totals-row">
        <span class="dt">Σ {{ $t("admin.pages.receivingCn.fields.cartonNo") }}:</span> {{ itemTotals.carton }}
        · <span class="dt">Σ {{ $t("admin.pages.receivingCn.fields.qty") }}:</span> {{ itemTotals.qty }}
        · <span class="dt">{{ $t("admin.pages.receivingCn.sheetTotals") }}:</span> {{ sheetTotalsLabel }}
      </div>

      <div class="wizard-actions">
        <button class="btn" @click="backToPick">{{ $t("admin.common.back") }}</button>
        <button class="btn btn-primary" :disabled="submitting || items.length === 0 || !file" @click="submit">
          {{ submitting ? $t("admin.pages.receivingCn.submitting") : $t("admin.pages.receivingCn.submit") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 0.625rem;
}
.steps {
  display: flex;
  gap: 1rem;
  margin-bottom: 0.75rem;
  font-size: 0.875rem;
}
.step {
  color: #9aa5b1;
}
.step.active {
  color: #0b5cab;
  font-weight: 600;
}
.panel {
  display: grid;
  gap: 0.75rem;
  justify-items: start;
  width: 100%;
  overflow: auto;
}
.hint {
  color: #52606d;
  margin: 0;
}
.dropzone {
  display: grid;
  gap: 0.5rem;
  justify-items: center;
  width: 100%;
  padding: 2.5rem 1rem;
  border: 2px dashed #b6c2cd;
  border-radius: var(--radius);
  background: #fff;
  cursor: pointer;
  text-align: center;
  box-sizing: border-box;
}
.dropzone:hover,
.dropzone.over {
  border-color: var(--brand-teal);
  background: #f4fafb;
}
.dropzone:focus-visible {
  outline: 2px solid var(--brand-teal);
  outline-offset: 2px;
}
.drop-hint {
  margin: 0;
  font-size: 0.8125rem;
  color: #7d8a97;
}
.parse-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  font-size: 0.875rem;
}
.parse-summary .dt,
.totals-row .dt {
  font-weight: 600;
}
.header-form {
  border: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.5rem 1rem;
  width: 100%;
}
.table-actions {
  display: flex;
  gap: 0.5rem;
}
.cell-input {
  width: 100%;
  min-width: 0;
  padding: 0.25rem 0.375rem;
  border: 1px solid transparent;
  border-radius: 0.25rem;
  background: transparent;
  font-size: 0.8125rem;
  box-sizing: border-box;
}
.cell-input:hover {
  border-color: #b6c2cd;
}
.cell-input:focus {
  border-color: var(--brand-teal);
  background: #fff;
  outline: none;
}
.totals-row {
  font-size: 0.875rem;
}
.wizard-actions {
  display: flex;
  gap: 0.625rem;
}
.btn-danger {
  color: #fff;
}
</style>
