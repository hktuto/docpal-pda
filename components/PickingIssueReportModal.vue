<template>
  <div
    v-if="modelValue"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="issue-title"
    @click.self="close"
    @keydown.esc="close"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="issue-title">Report picking issue</h3>
        <button type="button" class="modal__close" aria-label="Close" @click="close">×</button>
      </div>

      <div class="modal__body">
        <form @submit.prevent="submit">
          <label class="field">
            <span>Issue reason</span>
            <select v-model="reason">
              <option value="insufficient_stock">Insufficient stock</option>
              <option value="cannot_divide">Cannot divide quantity</option>
              <option value="merge">Merge orders</option>
              <option value="other">Other</option>
            </select>
          </label>

          <label v-if="reason === 'insufficient_stock'" class="field">
            <span>Actual qty available</span>
            <input v-model.number="qty" type="number" min="0" step="1" placeholder="e.g. 5" />
            <span v-if="errors.qty" class="error">{{ errors.qty }}</span>
          </label>

          <label v-if="reason === 'cannot_divide'" class="field">
            <span>Pack size</span>
            <input v-model.number="packSize" type="number" min="1" step="1" placeholder="e.g. 20000" />
            <span v-if="errors.packSize" class="error">{{ errors.packSize }}</span>
          </label>

          <div class="field">
            <span>Per-order remarks</span>
            <div v-for="o in orders" :key="o.id" class="remark-row">
              <div class="remark-header">
                <strong>{{ o.ref_no }}</strong>
                <span v-if="reason === 'cannot_divide'" class="muted">Requested: {{ o.totalQty }}</span>
              </div>
              <input v-model="remarks[o.id]" type="text" placeholder="Remark for this order" />
            </div>
          </div>

          <label class="field">
            <span>Common note</span>
            <textarea v-model="note" rows="2" placeholder="Note applied to all selected orders" />
          </label>

          <div v-if="errors.reason" class="error">{{ errors.reason }}</div>

          <div class="actions">
            <button type="button" class="btn btn--secondary" @click="close">Cancel</button>
            <button type="submit" class="btn" :disabled="saving">
              {{ saving ? "Saving…" : "Save issue" }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PickingIssueReason } from "~/db/schema";

interface OrderOption {
  id: string;
  ref_no: string;
  totalQty: number;
}

const props = defineProps<{
  modelValue: boolean;
  orders: OrderOption[];
  saving?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "saved", payload: {
    reason: PickingIssueReason;
    qty: number | null;
    packSize: number | null;
    note: string | null;
    remarks: Record<string, string>;
  }): void;
  (e: "cancelled"): void;
}>();

const reason = ref<PickingIssueReason>("insufficient_stock");
const qty = ref<number | null>(null);
const packSize = ref<number | null>(null);
const note = ref("");
const remarks = ref<Record<string, string>>({});
const errors = ref<Record<string, string>>({});

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      reason.value = "insufficient_stock";
      qty.value = null;
      packSize.value = null;
      note.value = "";
      errors.value = {};
      const next: Record<string, string> = {};
      for (const o of props.orders) {
        next[o.id] = "";
      }
      remarks.value = next;
    }
  },
  { immediate: true }
);

function close() {
  emit("update:modelValue", false);
  emit("cancelled");
}

function validate(): boolean {
  errors.value = {};
  if (reason.value === "merge" && props.orders.length < 2) {
    errors.value.reason = "Select at least two orders to request a merge";
  }
  if (reason.value === "insufficient_stock") {
    if (qty.value == null || qty.value < 0) {
      errors.value.qty = "Enter a valid available quantity";
    }
  }
  if (reason.value === "cannot_divide") {
    if (packSize.value == null || packSize.value <= 0) {
      errors.value.packSize = "Enter a valid pack size";
    }
  }
  if (
    reason.value === "other" &&
    !note.value.trim() &&
    !Object.values(remarks.value).some((r) => r.trim())
  ) {
    errors.value.reason = "Enter a note or at least one remark";
  }
  return Object.keys(errors.value).length === 0;
}

function submit() {
  if (!validate()) return;
  emit("saved", {
    reason: reason.value,
    qty: reason.value === "insufficient_stock" ? qty.value : null,
    packSize: reason.value === "cannot_divide" ? packSize.value : null,
    note: note.value.trim() || null,
    remarks: remarks.value,
  });
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
  max-width: 480px;
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
  font-size: 1.0625rem;
}

.modal__close {
  background: transparent;
  border: none;
  font-size: 1.5rem;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
}

.modal__body {
  padding: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-bottom: 1rem;
}

.field > span:first-child {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
}

.field input,
.field select,
.field textarea {
  width: 100%;
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 1rem;
  background: var(--surface);
}

.remark-row {
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 0.5rem;
}

.remark-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.35rem;
  font-size: 0.875rem;
}

.muted {
  color: var(--muted);
  font-size: 0.8125rem;
}

.error {
  color: var(--danger);
  font-size: 0.8125rem;
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
  font-weight: 600;
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
