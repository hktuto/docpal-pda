<template>
  <div
    v-if="modelValue"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="picking-scan-review-title"
    @click.self="close()"
    @keydown.esc="close()"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="picking-scan-review-title">{{ $t('picking.scanSession.reviewTitle') }}</h3>
        <button type="button" class="modal__close" :aria-label="$t('labelScanReviewModal.close')" :disabled="applying" @click="close">×</button>
      </div>

      <div class="modal__body">
        <p class="subtitle">{{ $t('picking.scanSession.reviewSubtitle') }}</p>

        <div class="items">
          <section
            v-for="(row, index) in editableRows"
            :key="row.id"
            class="item-card"
            :class="{ 'item-card--done': statusOf(index)?.ok, 'item-card--failed': statusOf(index) && !statusOf(index)?.ok }"
          >
            <div class="item-card__header">
              <strong>{{ index + 1 }}</strong>
              <span v-if="statusOf(index)?.ok" class="status-ok">✓</span>
              <button
                v-else
                type="button"
                class="row-remove"
                :aria-label="$t('scanReview.multiRemove')"
                :disabled="applying"
                @click="removeRow(index)"
              >×</button>
            </div>

            <fieldset class="item-fields" :disabled="statusOf(index)?.ok || applying">
              <label class="field">
                <span>{{ $t('labelScanReviewModal.partNo') }}</span>
                <select v-model="row.parsed.partNo">
                  <option value="">{{ $t('labelScanReviewModal.placeholderPartNo') }}</option>
                  <option v-for="opt in partNoOptions(row)" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
              </label>
              <label class="field">
                <span>{{ $t('labelScanReviewModal.qty') }}</span>
                <input v-model.number="row.parsed.qty" type="number" min="1" step="1" inputmode="numeric" :placeholder="$t('labelScanReviewModal.placeholderQty')" @focus="selectAll" />
                <CandidateChips
                  show-single
                  :model-value="String(row.parsed.qty)"
                  :candidates="row.options.qtys.map(String)"
                  :label="$t('labelScanReviewModal.qty')"
                  @update:model-value="setQty(row, $event)"
                />
              </label>
              <label class="field">
                <span>{{ $t('labelScanReviewModal.dateCode') }}</span>
                <input v-model="row.parsed.dateCode" type="text" :placeholder="$t('labelScanReviewModal.placeholderDateCode')" @focus="selectAll" />
                <CandidateChips
                  show-single
                  v-model="row.parsed.dateCode"
                  :candidates="row.options.dateCodes"
                  :label="$t('labelScanReviewModal.dateCode')"
                />
              </label>
              <label class="field">
                <span>{{ $t('labelScanReviewModal.lotCode') }}</span>
                <input v-model="row.parsed.lotCode" type="text" :placeholder="$t('labelScanReviewModal.placeholderLotCode')" @focus="selectAll" />
                <CandidateChips
                  show-single
                  v-model="row.parsed.lotCode"
                  :candidates="row.options.lotCodes"
                  :label="$t('labelScanReviewModal.lotCode')"
                />
              </label>
              <label class="field">
                <span>{{ $t('labelScanReviewModal.coo') }}</span>
                <CountrySelect v-model="row.parsed.coo" :candidates="row.options.coos" :placeholder="$t('labelScanReviewModal.placeholderCoo')" :empty-label="$t('labelScanReviewModal.noCoo')" />
              </label>
              <label class="field">
                <span>{{ $t('labelScanReviewModal.cow') }}</span>
                <CountrySelect v-model="row.parsed.cow" :candidates="row.options.cows" :placeholder="$t('labelScanReviewModal.placeholderCow')" :empty-label="$t('labelScanReviewModal.noCow')" />
              </label>
            </fieldset>
            <p v-if="statusOf(index) && !statusOf(index)?.ok" class="error">{{ statusOf(index)?.message }}</p>
          </section>
        </div>

        <button type="button" class="btn btn--secondary add-item" :disabled="applying" @click="addRow">
          {{ $t('scanReview.addItem') }}
        </button>

        <div class="actions">
          <button type="button" class="btn btn--secondary" :disabled="applying" @click="emit('retake')">
            {{ $t('labelScanReviewModal.retake') }}
          </button>
          <button type="button" class="btn btn--secondary" :disabled="applying" @click="close">
            {{ $t('labelScanReviewModal.cancel') }}
          </button>
          <button type="button" class="btn" :disabled="!canApply" @click="apply">
            {{ pendingRows.length === 1 ? $t('picking.scanSession.addToQueue') : $t('scanReview.multiAdd', { count: pendingRows.length }) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import CandidateChips from "~/components/CandidateChips.vue";
import CountrySelect from "~/components/CountrySelect.vue";
import type { OcrInput } from "~/utils/ocrNormalize";
import type { CandidateOptions, ScanMultiRowResult } from "~/utils/parseOcrScan";

type ReviewRow = { parsed: OcrInput; options: CandidateOptions };
type EditableReviewRow = ReviewRow & { id: number };

const props = defineProps<{
  modelValue: boolean;
  rows: ReviewRow[];
  partNos: string[];
  results: ScanMultiRowResult[] | null;
  applying: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "apply", rows: { row: OcrInput; index: number; rowId: number }[]): void;
  (e: "remove", index: number): void;
  (e: "retake"): void;
}>();

let nextRowId = 0;

function cloneRows(rows: ReviewRow[]): EditableReviewRow[] {
  return rows.map((row) => ({
    id: nextRowId++,
    parsed: { ...row.parsed, coo: "", cow: "" },
    options: row.options,
  }));
}

const editableRows = ref<EditableReviewRow[]>(cloneRows(props.rows));

watch(
  () => props.rows,
  (rows) => {
    editableRows.value = cloneRows(rows);
  }
);

function statusOf(index: number): ScanMultiRowResult | undefined {
  return props.results?.find((result) => result.index === index);
}

function partNoOptions(row: ReviewRow) {
  const values = [...new Set(props.partNos.filter(Boolean))];
  const extras = [...new Set(
    [row.parsed.partNo, ...row.options.itemIds]
      .map((value) => (value == null ? "" : String(value).trim()))
      .filter((value) => value !== "" && !values.includes(value))
  )];
  return [...values, ...extras].map((value) => ({ value, label: value }));
}

function setQty(row: ReviewRow, value: string) {
  if (value === "") {
    row.parsed.qty = "";
    return;
  }
  const qty = Number(value);
  row.parsed.qty = Number.isNaN(qty) ? "" : qty;
}

function validRow(row: ReviewRow): boolean {
  return row.parsed.partNo.trim().length > 0 &&
    typeof row.parsed.qty === "number" &&
    Number.isInteger(row.parsed.qty) &&
    row.parsed.qty > 0;
}

const pendingRows = computed(() =>
  editableRows.value
    .map((row, index) => ({ row, index }))
    .filter(({ index }) => !statusOf(index)?.ok)
);

const canApply = computed(() =>
  !props.applying && pendingRows.value.length > 0 && pendingRows.value.every(({ row }) => validRow(row))
);

function emptyOptions(): CandidateOptions {
  return { itemIds: [], qtys: [], coos: [], dateCodes: [], lotCodes: [], cows: [] };
}

function addRow() {
  editableRows.value.push({
    id: nextRowId++,
    parsed: { partNo: "", qty: "", dateCode: "", lotCode: "", coo: "", cow: "" },
    options: emptyOptions(),
  });
}

function removeRow(index: number) {
  editableRows.value.splice(index, 1);
  emit("remove", index);
}

function apply() {
  if (!canApply.value) return;
  emit(
    "apply",
    pendingRows.value.map(({ row, index }) => ({
      row: { ...row.parsed },
      index,
      rowId: row.id,
    }))
  );
}

function close() {
  if (!props.applying) emit("update:modelValue", false);
}

function selectAll(event: FocusEvent) {
  const target = event.target as HTMLInputElement;
  target.select();
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 100;
}

.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  width: 100%;
  max-width: min(38rem, calc(100vw - 2rem));
  max-height: 90vh;
  overflow-y: auto;
}

.modal__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  border-bottom: 1px solid var(--border);
}

.modal__header h3 {
  margin: 0;
}

.modal__close,
.row-remove {
  background: transparent;
  border: none;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  color: var(--muted);
}

.modal__body {
  padding: 1rem;
}

.subtitle {
  color: var(--muted);
  font-size: 0.875rem;
  margin: 0 0 1rem;
}

.items {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.item-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem;
}

.item-card--done {
  background: rgba(22, 163, 74, 0.08);
  border-color: #16a34a;
}

.item-card--failed {
  background: rgba(220, 38, 38, 0.08);
  border-color: #dc2626;
}

.item-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 1.5rem;
  margin-bottom: 0.5rem;
}

.item-fields {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.875rem;
}

.field span {
  color: var(--muted);
}

.field input,
.field select {
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 0.9375rem;
}

.status-ok {
  color: #16a34a;
  font-weight: 700;
}

.error {
  color: var(--danger);
  font-size: 0.875rem;
  margin: 0.75rem 0 0;
}

.add-item {
  width: 100%;
  margin-top: 0.75rem;
}

.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}

.actions .btn {
  flex: 1;
}

.btn {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--primary);
  border-radius: var(--radius);
  background: var(--primary);
  color: #fff;
  font-size: 0.9375rem;
  cursor: pointer;
}

.btn:disabled,
.modal__close:disabled,
.row-remove:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn--secondary {
  background: var(--surface);
  color: var(--text);
  border-color: var(--border);
}
</style>
