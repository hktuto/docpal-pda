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
        <button type="button" class="modal__close" :aria-label="$t('labelScanReviewModal.close')" @click="close">×</button>
      </div>

      <div class="modal__body">
        <p class="subtitle">{{ $t('picking.scanSession.reviewSubtitle') }}</p>

        <form class="form" @submit.prevent="confirm">
          <label class="field">
            <span>{{ $t('labelScanReviewModal.partNo') }}</span>
            <input @focus="selectAll" v-model="editable.partNo" type="text" :placeholder="$t('labelScanReviewModal.placeholderPartNo')" />
            <CandidateChips
              v-model="editable.partNo"
              :candidates="options.itemIds"
              :label="$t('labelScanReviewModal.partNo')"
            />
          </label>
          <label class="field">
            <span>{{ $t('labelScanReviewModal.qty') }}</span>
            <input @focus="selectAll" v-model.number="editable.qty" type="number" min="1" step="1" inputmode="numeric" :placeholder="$t('labelScanReviewModal.placeholderQty')" />
            <CandidateChips
              v-model="qtyChipValue"
              :candidates="options.qtys.map(String)"
              :label="$t('labelScanReviewModal.qty')"
            />
          </label>
          <label class="field">
            <span>{{ $t('labelScanReviewModal.dateCode') }}</span>
            <input @focus="selectAll" v-model="editable.dateCode" type="text" :placeholder="$t('labelScanReviewModal.placeholderDateCode')" />
            <CandidateChips
              v-model="editable.dateCode"
              :candidates="options.dateCodes"
              :label="$t('labelScanReviewModal.dateCode')"
            />
          </label>
          <label class="field">
            <span>{{ $t('labelScanReviewModal.lotCode') }}</span>
            <input @focus="selectAll" v-model="editable.lotCode" type="text" :placeholder="$t('labelScanReviewModal.placeholderLotCode')" />
            <CandidateChips
              v-model="editable.lotCode"
              :candidates="options.lotCodes"
              :label="$t('labelScanReviewModal.lotCode')"
            />
          </label>
          <label class="field">
            <span>{{ $t('labelScanReviewModal.coo') }}</span>
            <input @focus="selectAll" v-model="editable.coo" type="text" :placeholder="$t('labelScanReviewModal.placeholderCoo')" />
            <CandidateChips
              v-model="editable.coo"
              :candidates="options.coos"
              :label="$t('labelScanReviewModal.coo')"
            />
          </label>
          <label class="field">
            <span>{{ $t('labelScanReviewModal.cow') }}</span>
            <input @focus="selectAll" v-model="editable.cow" type="text" :placeholder="$t('labelScanReviewModal.placeholderCow')" />
            <CandidateChips
              v-model="editable.cow"
              :candidates="options.cows"
              :label="$t('labelScanReviewModal.cow')"
            />
          </label>
        </form>

        <div class="actions">
          <button type="button" class="btn btn--secondary" @click="emit('retake')">
            {{ $t('labelScanReviewModal.retake') }}
          </button>
          <button type="button" class="btn btn--secondary" @click="close">
            {{ $t('labelScanReviewModal.cancel') }}
          </button>
          <button type="button" class="btn" :disabled="!valid" @click="confirm">
            {{ $t('picking.scanSession.addToQueue') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import CandidateChips from "~/components/CandidateChips.vue";
import type { OcrInput } from "~/composables/useMockOcr";
import type { CandidateOptions } from "~/utils/parseOcrScan";

const props = defineProps<{
  modelValue: boolean;
  parsed: OcrInput;
  options: CandidateOptions;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "confirm", parsed: OcrInput): void;
  (e: "retake"): void;
}>();

const editable = ref<OcrInput>({ ...props.parsed });

watch(
  () => props.parsed,
  (v) => {
    editable.value = { ...v };
  }
);

const qtyChipValue = computed({
  get: () => String(editable.value.qty),
  set: (v) => {
    if (v === "") {
      editable.value.qty = "";
    } else {
      const n = Number(v);
      editable.value.qty = Number.isNaN(n) ? "" : n;
    }
  },
});

const valid = computed(
  () =>
    editable.value.partNo.trim().length > 0 &&
    typeof editable.value.qty === "number" &&
    Number.isInteger(editable.value.qty) &&
    editable.value.qty > 0
);

function confirm() {
  if (!valid.value) return;
  emit("confirm", { ...editable.value });
}

function close() {
  emit("update:modelValue", false);
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

.field input {
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 0.9375rem;
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
