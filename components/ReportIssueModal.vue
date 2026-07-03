<template>
  <div
    v-if="modelValue"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="report-issue-title"
    @click.self="!isBusy && onCancel()"
    @keydown.esc="!isBusy && onCancel()"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="report-issue-title">{{ title }}</h3>
        <button type="button" class="modal__close" aria-label="Close" :disabled="isBusy" @click="onCancel">×</button>
      </div>

      <div class="modal__body">
        <form class="form" @submit.prevent="onConfirm">
          <label class="field">
            <span>Reason</span>
            <select v-model="reason" :disabled="isBusy">
              <option value="">—</option>
              <option v-for="r in mismatchReasons" :key="r" :value="r">{{ formatReason(r) }}</option>
            </select>
          </label>

          <label v-if="showMismatchQty(reason)" class="field">
            <span>{{ qtyLabel(reason) }}</span>
            <input
              v-model.number="mismatchQty"
              type="number"
              min="0"
              step="1"
              inputmode="numeric"
              :placeholder="qtyPlaceholder(reason)"
              :disabled="isBusy"
            />
          </label>

          <label v-if="reason === 'wrong_part'" class="field">
            <span>Wrong part number</span>
            <input v-model="wrongPartNo" type="text" placeholder="Scan or type" :disabled="isBusy" />
          </label>

          <label class="field">
            <span>Note</span>
            <input v-model="note" type="text" placeholder="Mismatch note" :disabled="isBusy" />
          </label>

          <p v-if="validationError" class="error">{{ validationError }}</p>

          <div class="actions">
            <button type="button" class="btn btn--secondary" :disabled="isBusy" @click="onCancel">Cancel</button>
            <button type="submit" class="btn" :disabled="isBusy">
              {{ isBusy ? "Saving…" : "Confirm" }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { validateMismatchInputs } from "~/db/receiving";
import { mismatchReasons, type MismatchReason } from "~/db/schema";
import * as schema from "~/db/schema";

type DisplayReceivingItem = typeof schema.receivingInvoiceItems.$inferSelect;

const props = defineProps<{
  modelValue: boolean;
  item: DisplayReceivingItem | null;
  saving?: boolean;
}>();

const emit = defineEmits<{
  (e: "confirm", payload: {
    reason: MismatchReason | null;
    mismatchQty: number | null;
    wrongPartNo: string | null;
    note: string;
  }): void;
  (e: "update:modelValue", value: boolean): void;
}>();

const reason = ref<MismatchReason | "">("");
const mismatchQty = ref<number | "" | null>(null);
const wrongPartNo = ref("");
const note = ref("");
const validationError = ref<string | null>(null);
const openedForEdit = ref(false);

const isBusy = computed(() => props.saving);
const title = computed(() => openedForEdit.value ? "Edit issue" : "Report issue");

function resetForm() {
  openedForEdit.value = !!props.item?.reportedMismatch;
  validationError.value = null;
  if (props.item) {
    reason.value = props.item.mismatchReason || "";
    mismatchQty.value = props.item.mismatchQty ?? null;
    wrongPartNo.value = props.item.wrongPartNo || "";
    note.value = props.item.mismatchNote || "";
  } else {
    reason.value = "";
    mismatchQty.value = null;
    wrongPartNo.value = "";
    note.value = "";
  }
}

watch(() => props.modelValue, (open) => {
  if (open) resetForm();
}, { immediate: true });

const reasonLabels: Record<MismatchReason, string> = {
  not_found: "Not found",
  damaged: "Damaged",
  qty_mismatch: "Quantity mismatch",
  wrong_part: "Wrong part shipped",
  over_shipment: "Over shipment",
  quality_rejection: "Quality rejection",
};

function formatReason(reason: MismatchReason): string {
  return reasonLabels[reason];
}

function showMismatchQty(reason: MismatchReason | ""): boolean {
  if (!reason) return false;
  return reason !== "not_found";
}

const mismatchQtyLabels: Record<MismatchReason, { label: string; placeholder: string }> = {
  not_found: { label: "Qty", placeholder: "Qty" },
  damaged: { label: "Damaged qty", placeholder: "Damaged qty" },
  qty_mismatch: { label: "Actual received qty", placeholder: "Actual received qty" },
  wrong_part: { label: "Wrong part qty", placeholder: "Wrong part qty" },
  over_shipment: { label: "Extra qty", placeholder: "Extra qty" },
  quality_rejection: { label: "Rejected qty", placeholder: "Rejected qty" },
};

function qtyPlaceholder(reason: MismatchReason | ""): string {
  return reason ? mismatchQtyLabels[reason].placeholder : "Qty";
}

function qtyLabel(reason: MismatchReason | ""): string {
  return reason ? mismatchQtyLabels[reason].label : "Qty";
}

function toNumberOrNull(v: unknown): number | null {
  if (v === "" || v === null || v === undefined || Number.isNaN(Number(v))) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function onCancel() {
  emit("update:modelValue", false);
}

function onConfirm() {
  if (!props.item) return;
  validationError.value = null;

  try {
    const selectedReason = reason.value || null;
    const qty = selectedReason && selectedReason !== "not_found"
      ? toNumberOrNull(mismatchQty.value)
      : null;
    const partNo = selectedReason === "wrong_part" ? wrongPartNo.value.trim() || null : null;

    validateMismatchInputs(props.item.qty, selectedReason, qty, partNo);

    emit("confirm", {
      reason: selectedReason,
      mismatchQty: qty,
      wrongPartNo: partNo,
      note: note.value.trim(),
    });
  } catch (e: any) {
    validationError.value = e?.message ?? String(e);
  }
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
  max-width: 420px;
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

.form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
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

.error {
  color: var(--danger);
  font-size: 0.875rem;
  margin: 0.75rem 0 0;
}

.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
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
