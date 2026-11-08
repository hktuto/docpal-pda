<script setup lang="ts">
import type { AdminColumnDef } from "~/composables/useAdminTable";
import type { CnReceivingDraft, CnReceivingDraftItem } from "~/utils/cnReceivingExcel";

/**
 * One locally decoded Excel receiving confirmation (收貨確認) with inline
 * verify/edit, per spec
 * docs/superpowers/specs/2026-11-08-receiving-cn-excel-local-upload-design.md.
 * Lifted from the retired upload wizard (f9eab952^) step 2; the draft object
 * is mutated in place (the page keeps the array).
 */
const props = defineProps<{ draft: CnReceivingDraft }>();
const emit = defineEmits<{ remove: [] }>();

const { t } = useI18n();

const columnDefs = computed<AdminColumnDef<CnReceivingDraftItem>[]>(() => [
  { key: "index", label: t("admin.pages.receivingCn.fields.index"), size: 56 },
  { key: "orderNo", label: t("admin.pages.receivingCn.fields.orderNo"), size: 130 },
  { key: "ctnNo", label: t("admin.pages.receivingCn.fields.ctnNo"), size: 90 },
  { key: "cartonNo", label: t("admin.pages.receivingCn.fields.cartonNo"), size: 80 },
  { key: "partNo", label: t("admin.pages.receivingCn.fields.partNo"), size: 220 },
  { key: "dateCode", label: t("admin.pages.receivingCn.fields.dateCode"), size: 90 },
  { key: "qty", label: t("admin.pages.receivingCn.fields.qty"), size: 90 },
  { key: "weight", label: t("admin.pages.receivingCn.fields.weight"), size: 90 },
  { key: "office", label: t("admin.pages.receivingCn.fields.office"), size: 100 },
  { key: "poNo", label: t("admin.pages.receivingCn.fields.poNo"), size: 120 },
  { key: "remark", label: t("admin.pages.receivingCn.fields.remark"), size: 140 },
  { key: "actions", label: t("admin.common.actions"), size: 120 },
]);

let nextUid = 1;

const { table, resetColumnState } = useAdminTable<CnReceivingDraftItem>({
  // Shared column state across the per-file instances on one page.
  tableId: "receiving-cn-new-items",
  columns: columnDefs,
  rows: toRef(props.draft, "items"),
  getRowId: (r) => String(r.uid),
  // One section holds the whole sheet — the wizard has no pager.
  defaultPageSize: 500,
});

function removeItem(row: CnReceivingDraftItem) {
  props.draft.items = props.draft.items.filter((i) => i.uid !== row.uid);
}

function nextIndex(): number {
  return props.draft.items.reduce((max, i) => Math.max(max, i.index), 0) + 1;
}

function addItem() {
  props.draft.items.push({
    uid: -nextUid--,
    index: nextIndex(),
    orderNo: "",
    ctnNo: "",
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
// Σ captured at parse time). Warning-level only — submit stays allowed. Merge
// -filled carton cells count once (same rule as the parse-time totals).
const itemTotals = computed(() => ({
  carton: props.draft.items.reduce((s, i) => s + (i.cartonMerged ? 0 : num(i.cartonNo)), 0),
  qty: props.draft.items.reduce((s, i) => s + num(i.qty), 0),
}));

const sheetTotals = computed(() => props.draft.sheetTotals ?? props.draft.totals);

const totalsMismatch = computed(() => {
  const sheet = sheetTotals.value;
  return itemTotals.value.carton !== sheet.carton || itemTotals.value.qty !== sheet.qty;
});

const sheetTotalsLabel = computed(() => `${sheetTotals.value.carton} / ${sheetTotals.value.qty}`);
</script>

<template>
  <div class="draft">
    <div class="draft-head">
      <div class="parse-summary">
        <div>
          <span class="dt">{{ $t("admin.pages.receivingCn.filename") }}:</span>
          {{ draft.filename }}
        </div>
        <div>
          <span class="dt">{{ $t("admin.pages.receivingCn.supplier") }}:</span>
          {{ draft.header.supplier || "—" }}
        </div>
        <div>
          <span class="dt">{{ $t("admin.pages.receivingCn.invoiceNo") }}:</span>
          {{ draft.header.invoiceNo || "—" }}
        </div>
        <div>
          <span class="dt">{{ $t("admin.pages.receivingCn.itemCount") }}:</span>
          {{ draft.items.length }}
        </div>
      </div>
      <button class="btn btn-small btn-danger" @click="emit('remove')">
        {{ $t("admin.common.delete") }}
      </button>
    </div>

    <fieldset class="header-form">
      <div class="form-row">
        <label :for="`cn-brand-${draft.uid}`">{{ $t("admin.pages.receivingCn.fields.brand") }}</label>
        <input :id="`cn-brand-${draft.uid}`" v-model="draft.brand" type="text" :placeholder="$t('admin.pages.receivingCn.brandAuto')" />
      </div>
      <div class="form-row">
        <label :for="`cn-receivedOffice-${draft.uid}`">{{ $t("admin.pages.receivingCn.fields.receivedOffice") }}</label>
        <input :id="`cn-receivedOffice-${draft.uid}`" v-model="draft.header.receivedOffice" type="text" />
      </div>
      <div class="form-row">
        <label :for="`cn-supplier-${draft.uid}`">{{ $t("admin.pages.receivingCn.fields.supplier") }}</label>
        <input :id="`cn-supplier-${draft.uid}`" v-model="draft.header.supplier" type="text" />
      </div>
      <div class="form-row">
        <label :for="`cn-invoiceNo-${draft.uid}`">{{ $t("admin.pages.receivingCn.fields.invoiceNo") }}</label>
        <input :id="`cn-invoiceNo-${draft.uid}`" v-model="draft.header.invoiceNo" type="text" />
      </div>
      <div class="form-row">
        <label :for="`cn-receiptNo-${draft.uid}`">{{ $t("admin.pages.receivingCn.fields.receiptNo") }}</label>
        <input :id="`cn-receiptNo-${draft.uid}`" v-model="draft.header.receiptNo" type="text" />
      </div>
      <div class="form-row">
        <label :for="`cn-receivedDate-${draft.uid}`">{{ $t("admin.pages.receivingCn.fields.receivedDate") }}</label>
        <input :id="`cn-receivedDate-${draft.uid}`" v-model="draft.header.receivedDate" type="date" />
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
      <template #cell-ctnNo="{ row }">
        <input v-model="row.ctnNo" class="cell-input" type="text" />
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
        <button class="btn btn-small btn-danger" @click="removeItem(row)">
          {{ $t("admin.common.delete") }}
        </button>
      </template>
    </DataTable>

    <div class="totals-row">
      <span class="dt">Σ {{ $t("admin.pages.receivingCn.fields.cartonNo") }}:</span> {{ itemTotals.carton }}
      · <span class="dt">Σ {{ $t("admin.pages.receivingCn.fields.qty") }}:</span> {{ itemTotals.qty }}
      · <span class="dt">{{ $t("admin.pages.receivingCn.sheetTotals") }}:</span> {{ sheetTotalsLabel }}
    </div>
  </div>
</template>

<style scoped>
.draft {
  display: grid;
  gap: 0.75rem;
  justify-items: start;
  width: 100%;
}
.draft-head {
  display: flex;
  align-items: center;
  gap: 1rem;
  width: 100%;
}
.draft-head .parse-summary {
  flex: 1;
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
.form-row {
  display: grid;
  gap: 0.25rem;
}
.form-row label {
  font-size: 0.75rem;
  color: #52606d;
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
.btn-danger {
  color: #fff;
}
</style>
