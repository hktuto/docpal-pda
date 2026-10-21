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

// Wizard: 1 = pick the Excel file, 2 = verify/edit the decoded payload,
// 3 = submit (multipart file + verified JSON to the DocPal workflow).
const step = ref<1 | 2 | 3>(1);
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

  parsing.value = true;
  error.value = "";
  try {
    const XLSX = await import("xlsx");
    const buf = await picked.arrayBuffer();
    const wb = XLSX.read(buf);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error(t("admin.pages.receivingCn.noSheet"));
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    // Merged cells (e.g. the poNo 发货项 column spanning an item group) carry
    // their value only in the top-left cell — fill the range before parsing.
    const merged = fillMergedCells(aoa as unknown[][], (ws["!merges"] as AoaMergeRange[] | undefined) ?? []);
    const result = parseCnReceivingAoa(merged);
    if (result.items.length === 0) {
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
  { key: "orderNo", label: t("admin.pages.receivingCn.fields.orderNo"), size: 130 },
  { key: "cartonNo", label: t("admin.pages.receivingCn.fields.cartonNo"), size: 80 },
  { key: "partNo", label: t("admin.pages.receivingCn.fields.partNo"), size: 200 },
  { key: "dateCode", label: t("admin.pages.receivingCn.fields.dateCode"), size: 90 },
  { key: "qty", label: t("admin.pages.receivingCn.fields.qty"), size: 90 },
  { key: "weight", label: t("admin.pages.receivingCn.fields.weight"), size: 90 },
  { key: "office", label: t("admin.pages.receivingCn.fields.office"), size: 100 },
  { key: "poNo", label: t("admin.pages.receivingCn.fields.poNo"), size: 120 },
  { key: "remark", label: t("admin.pages.receivingCn.fields.remark"), size: 140 },
]);

const { table, resetColumnState } = useAdminTable<DraftItem>({
  tableId: "receiving-cn-new-items",
  columns: columnDefs,
  rows: items,
  getRowId: (r) => String(r.uid),
  // One page holds the whole sheet — the wizard has no pager.
  defaultPageSize: 500,
});

const editTarget = ref<DraftItem | null>(null);

function openEdit(row: DraftItem) {
  editTarget.value = row;
}

function onSaveItem(saved: CnReceivingItem) {
  const target = editTarget.value;
  if (!target) return;
  const { uid } = target;
  const idx = items.value.findIndex((i) => i.uid === uid);
  if (idx >= 0) items.value[idx] = { ...saved, uid };
  editTarget.value = null;
}

function removeItem(row: DraftItem) {
  items.value = items.value.filter((i) => i.uid !== row.uid);
}

function addItem() {
  items.value.push({
    uid: nextUid++,
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
// Σ captured at parse time). Warning-level only — submit stays allowed.
const totalsMismatch = computed(() => {
  const sheet = parsed.value?.sheetTotals ?? parsed.value?.totals;
  if (!sheet) return false;
  const carton = items.value.reduce((s, i) => s + num(i.cartonNo), 0);
  const qty = items.value.reduce((s, i) => s + num(i.qty), 0);
  return carton !== sheet.carton || qty !== sheet.qty;
});

const itemTotals = computed(() => ({
  carton: items.value.reduce((s, i) => s + num(i.cartonNo), 0),
  qty: items.value.reduce((s, i) => s + num(i.qty), 0),
}));

const sheetTotalsLabel = computed(() => {
  const sheet = parsed.value?.sheetTotals ?? parsed.value?.totals;
  return sheet ? `${sheet.carton} / ${sheet.qty}` : "—";
});

function backToPick() {
  step.value = 1;
}

function toSubmit() {
  error.value = "";
  step.value = 3;
}

function backToEdit() {
  step.value = 2;
}

// ---- step 3: submit ----

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
      items: items.value.map(({ uid: _uid, orderNo, poNo, ...rest }) => ({ ...rest, orderNo: poNo, poNo: orderNo })),
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
      <span :class="['step', { active: step === 3 }]">3. {{ $t("admin.pages.receivingCn.stepSubmit") }}</span>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <!-- Step 1: pick the Excel -->
    <div v-if="step === 1" class="panel">
      <p class="hint">{{ $t("admin.pages.receivingCn.uploadHint") }}</p>
      <button class="btn btn-primary" :disabled="parsing" @click="triggerPick">
        {{ parsing ? $t("admin.common.loading") : $t("admin.pages.receivingCn.pickFile") }}
      </button>
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
        <template #cell-orderNo="{ row }">{{ row.orderNo }}</template>
        <template #cell-cartonNo="{ row }">{{ row.cartonNo }}</template>
        <template #cell-partNo="{ row }">{{ row.partNo }}</template>
        <template #cell-dateCode="{ row }">{{ row.dateCode }}</template>
        <template #cell-qty="{ row }">{{ row.qty }}</template>
        <template #cell-weight="{ row }">{{ row.weight }}</template>
        <template #cell-office="{ row }">{{ row.office }}</template>
        <template #cell-poNo="{ row }">{{ row.poNo }}</template>
        <template #cell-remark="{ row }">{{ row.remark }}</template>
        <template #actions="{ row }">
          <button class="btn btn-small" @click="openEdit(row)">{{ $t("admin.common.edit") }}</button>
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
        <button class="btn btn-primary" :disabled="items.length === 0" @click="toSubmit">
          {{ $t("admin.pages.receivingCn.proceedToSubmit") }}
        </button>
      </div>
    </div>

    <!-- Step 3: submit -->
    <div v-else class="panel">
      <p class="hint">
        {{
          $t("admin.pages.receivingCn.submitHint", {
            filename: file?.name ?? "",
            count: items.length,
          })
        }}
      </p>
      <div class="wizard-actions">
        <button class="btn" @click="backToEdit">{{ $t("admin.common.back") }}</button>
        <button class="btn btn-primary" :disabled="submitting || !file" @click="submit">
          {{ submitting ? $t("admin.pages.receivingCn.submitting") : $t("admin.pages.receivingCn.submit") }}
        </button>
      </div>
    </div>

    <CnItemEditModal v-if="editTarget" :item="editTarget" :saving="false" @close="editTarget = null" @save="onSaveItem" />
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
}
.hint {
  color: #52606d;
  margin: 0;
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
.totals-row {
  font-size: 0.875rem;
}
.wizard-actions {
  display: flex;
  gap: 0.625rem;
}
.btn-danger {
  color: #b91c1c;
}
</style>
