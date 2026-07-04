<template>
  <div
    v-if="modelValue"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="issue-title"
    @click.self="!saving && close()"
    @keydown.esc="!saving && close()"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="issue-title">{{ $t('picking.issueModal.title') }}</h3>
        <button type="button" class="modal__close" :aria-label="$t('actions.close')" :disabled="saving" @click="close">×</button>
      </div>

      <div class="modal__body">
        <form class="form" @submit.prevent="submit">
          <label class="field">
            <span>{{ $t('picking.issueModal.issueReason') }}</span>
            <select v-model="reason" :disabled="saving">
              <option v-for="r in pickingIssueReasons" :key="r" :value="r">{{ $t(`picking.issueReasons.${r}`) }}</option>
            </select>
          </label>

          <label v-if="reason === 'insufficient_stock'" class="field">
            <span>{{ $t('picking.issueModal.actualQtyAvailable') }}</span>
            <input
              v-model.number="qty"
              type="number"
              min="0"
              step="1"
              :placeholder="$t('picking.issueModal.actualQtyPlaceholder')"
              :disabled="saving"
            />
            <span v-if="errors.qty" class="error">{{ errors.qty }}</span>
          </label>

          <label v-if="reason === 'cannot_divide'" class="field">
            <span>{{ $t('picking.issueModal.packSize') }}</span>
            <input
              v-model.number="packSize"
              type="number"
              min="1"
              step="1"
              :placeholder="$t('picking.issueModal.packSizePlaceholder')"
              :disabled="saving"
            />
            <span v-if="errors.packSize" class="error">{{ errors.packSize }}</span>
          </label>

          <div class="field">
            <span>{{ $t('picking.issueModal.perOrderRemarks') }}</span>
            <div v-for="o in orders" :key="o.id" class="remark-row">
              <div class="remark-header">
                <strong>{{ o.ref_no }}</strong>
                <span v-if="reason === 'cannot_divide'" class="muted">{{ $t('picking.issueModal.requested', { qty: o.totalQty }) }}</span>
              </div>
              <input
                v-model="remarks[o.id]"
                type="text"
                :placeholder="$t('picking.issueModal.remarkPlaceholder')"
                :aria-label="$t('picking.issueModal.remarkAriaLabel', { ref: o.ref_no })"
                :disabled="saving"
              />
            </div>
          </div>

          <label class="field">
            <span>{{ $t('picking.issueModal.commonNote') }}</span>
            <textarea
              v-model="note"
              rows="2"
              :placeholder="$t('picking.issueModal.commonNotePlaceholder')"
              :disabled="saving"
            />
          </label>

          <div v-if="errors.reason" class="error">{{ errors.reason }}</div>

          <div class="actions">
            <button type="button" class="btn btn--secondary" :disabled="saving" @click="close">{{ $t('actions.cancel') }}</button>
            <button type="submit" class="btn" :disabled="saving">
              {{ saving ? $t('actions.saving') : $t('actions.saveIssue') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { pickingIssueReasons, type PickingIssueReason } from "~/db/schema";

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

const { t } = useI18n();

const reason = ref<PickingIssueReason>("insufficient_stock");
const qty = ref<number | "" | null>("");
const packSize = ref<number | "" | null>("");
const note = ref("");
const remarks = ref<Record<string, string>>({});
const errors = ref<Record<string, string>>({});

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      reason.value = "insufficient_stock";
      qty.value = "";
      packSize.value = "";
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
  if (props.saving) return;
  emit("update:modelValue", false);
  emit("cancelled");
}

function validate(): boolean {
  errors.value = {};
  if (reason.value === "merge" && props.orders.length < 2) {
    errors.value.reason = t('picking.issueModal.validation.mergeMinOrders');
  }
  if (reason.value === "insufficient_stock") {
    if (
      qty.value === "" ||
      qty.value == null ||
      qty.value < 0 ||
      !Number.isInteger(qty.value)
    ) {
      errors.value.qty = t('picking.issueModal.validation.validAvailableQty');
    }
  }
  if (reason.value === "cannot_divide") {
    if (
      packSize.value === "" ||
      packSize.value == null ||
      packSize.value <= 0 ||
      !Number.isInteger(packSize.value)
    ) {
      errors.value.packSize = t('picking.issueModal.validation.validPackSize');
    }
  }
  if (
    reason.value === "other" &&
    !note.value.trim() &&
    !Object.values(remarks.value).some((r) => r.trim())
  ) {
    errors.value.reason = t('picking.issueModal.validation.noteOrRemark');
  }
  return Object.keys(errors.value).length === 0;
}

function submit() {
  if (!validate()) return;

  const trimmedRemarks: Record<string, string> = {};
  for (const [id, value] of Object.entries(remarks.value)) {
    const trimmed = value.trim();
    if (trimmed) trimmedRemarks[id] = trimmed;
  }

  emit("saved", {
    reason: reason.value,
    qty: reason.value === "insufficient_stock" ? (qty.value === "" ? null : qty.value) : null,
    packSize: reason.value === "cannot_divide" ? (packSize.value === "" ? null : packSize.value) : null,
    note: note.value.trim() || null,
    remarks: trimmedRemarks,
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

.field > span:first-child {
  color: var(--muted);
}

.field input,
.field select,
.field textarea {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 0.9375rem;
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
