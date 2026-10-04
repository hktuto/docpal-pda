<template>
  <div
    v-if="modelValue"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="picking-multi-scan-title"
    @click.self="close()"
    @keydown.esc="close()"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="picking-multi-scan-title">{{ $t('scanReview.multiTitle') }}</h3>
        <button type="button" class="modal__close" :aria-label="$t('labelScanReviewModal.close')" @click="close">×</button>
      </div>

      <div class="modal__body">
        <p class="subtitle">{{ $t('scanReview.multiSubtitle') }}</p>

        <table class="rows">
          <thead>
            <tr>
              <th class="col-no">#</th>
              <th>{{ $t('labelScanReviewModal.partNo') }}</th>
              <th class="col-qty">{{ $t('labelScanReviewModal.qty') }}</th>
              <th class="col-status"></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in editableRows"
              :key="index"
              :class="{ 'row--done': statusOf(index)?.ok, 'row--failed': statusOf(index) && !statusOf(index)?.ok }"
            >
              <td class="col-no">{{ index + 1 }}</td>
              <td>
                <select v-model="row.partNo" :disabled="statusOf(index)?.ok">
                  <option v-for="partNo of partNos" :key="partNo" :value="partNo">
                    {{ partNo }}
                  </option>
                </select>
              </td>
              <td class="col-qty">
                <input
                  v-model.number="row.qty"
                  type="number"
                  min="1"
                  step="1"
                  inputmode="numeric"
                  :disabled="statusOf(index)?.ok"
                />
              </td>
              <td class="col-status">
                <span v-if="statusOf(index)?.ok" class="status-ok">✓</span>
                <span v-else-if="statusOf(index)" class="status-failed" :title="statusOf(index)?.message">✗</span>
                <button
                  v-else
                  type="button"
                  class="row-remove"
                  :aria-label="$t('scanReview.multiRemove')"
                  @click="removeRow(index)"
                >×</button>
              </td>
            </tr>
          </tbody>
        </table>

        <p v-if="firstError" class="error">{{ firstError }}</p>

        <div class="actions">
          <button type="button" class="btn btn--secondary" @click="close">
            {{ $t('labelScanReviewModal.cancel') }}
          </button>
          <button type="button" class="btn" :disabled="pendingRows.length === 0" @click="apply">
            {{ $t('scanReview.multiAdd', { count: pendingRows.length }) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ScanMultiRow, ScanMultiRowResult } from "~/utils/parseOcrScan";

const props = defineProps<{
  modelValue: boolean;
  rows: ScanMultiRow[];
  /** Part numbers the operator can pick per row (select options). */
  partNos: string[];
  /** Results of the last apply run; rows marked ok are locked. */
  results: ScanMultiRowResult[] | null;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "apply", rows: { row: ScanMultiRow; index: number }[]): void;
  (e: "remove", index: number): void;
}>();

const editableRows = ref<ScanMultiRow[]>(props.rows.map((r) => ({ ...r })));

watch(
  () => props.rows,
  (v) => {
    editableRows.value = v.map((r) => ({ ...r }));
  }
);

function statusOf(index: number): ScanMultiRowResult | undefined {
  return props.results?.find((r) => r.index === index);
}

const pendingRows = computed(() =>
  editableRows.value
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row, index }) =>
        !statusOf(index)?.ok &&
        row.partNo &&
        typeof row.qty === "number" &&
        Number.isInteger(row.qty) &&
        row.qty > 0
    )
);

const firstError = computed(() => props.results?.find((r) => !r.ok)?.message ?? null);

function removeRow(index: number) {
  editableRows.value.splice(index, 1);
  emit("remove", index);
}

function apply() {
  emit(
    "apply",
    pendingRows.value.map(({ row, index }) => ({ row: { ...row }, index }))
  );
}

function close() {
  emit("update:modelValue", false);
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
  max-width: calc(100vw - 2rem);
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

.modal__close {
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

.rows {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9375rem;
}

.rows th {
  text-align: left;
  font-size: 0.8125rem;
  font-weight: normal;
  color: var(--muted);
  padding: 0.25rem 0.5rem;
}

.rows td {
  border-top: 1px solid var(--border);
  padding: 0.4rem 0.5rem;
  vertical-align: middle;
}

.col-no {
  width: 2rem;
  color: var(--muted);
}

.col-qty {
  width: 7rem;
}

.col-status {
  width: 2.5rem;
  text-align: center;
}

.rows select,
.rows input {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 0.9375rem;
}

.row--done td {
  background: rgba(22, 163, 74, 0.08);
}

.row--failed td {
  background: rgba(220, 38, 38, 0.08);
}

.status-ok {
  color: #16a34a;
  font-weight: 700;
}

.status-failed {
  color: #dc2626;
  font-weight: 700;
}

.row-remove {
  background: transparent;
  border: none;
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  color: var(--muted);
}

.error {
  color: var(--danger);
  font-size: 0.875rem;
  margin: 0.75rem 0 0;
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

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn--secondary {
  background: var(--surface);
  color: var(--text);
  border-color: var(--border);
}
</style>
