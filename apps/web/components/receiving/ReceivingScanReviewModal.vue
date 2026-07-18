<template>
  <div
    v-if="modelValue"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="scan-review-title"
    @click.self="!applying && close()"
    @keydown.esc="!applying && close()"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="scan-review-title">{{ title }}</h3>
        <button type="button" class="modal__close" :aria-label="$t('receiving.scanReview.close')" :disabled="applying" @click="close">×</button>
      </div>

      <div class="modal__body">
        <p class="subtitle">{{ subtitle }}</p>

        <label class="field">
          <span>{{ $t('receiving.scanReview.qty') }}</span>
          <input v-model.number="qty" type="number" min="1" step="1" inputmode="numeric" :disabled="applying" />
        </label>

        <div class="options">
          <button
            v-for="candidate in candidates"
            :key="candidate.id"
            type="button"
            class="option"
            :disabled="applying || !qtyValid"
            @click="emit('pick', { candidate, qty: qty as number })"
          >
            <div class="letter">
              <template v-if="applying"><InlineSpinner /></template>
              <template v-else>📦</template>
            </div>
            <div class="content">
              <p class="option__title">{{ candidate.partNo }}</p>
              <p v-if="candidate.wclItemNo" class="option__meta">{{ candidate.wclItemNo }}</p>
              <p class="option__meta">
                {{ $t('receiving.scanReview.progress', { received: candidate.receivedQty, expected: candidate.qty }) }}
              </p>
            </div>
          </button>
        </div>

        <div class="actions">
          <button type="button" class="btn btn--secondary" :disabled="applying" @click="close">
            {{ $t('receiving.scanReview.cancel') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ReceivingScanCandidate } from "~/services/types";

const { t } = useI18n();

const props = defineProps<{
  modelValue: boolean;
  message: "no_match" | "multiple_matches";
  candidates: ReceivingScanCandidate[];
  initialQty: number | null;
  applying: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "pick", payload: { candidate: ReceivingScanCandidate; qty: number }): void;
}>();

const qty = ref<number | null>(props.initialQty);

watch(
  () => props.initialQty,
  (v) => {
    qty.value = v;
  }
);

const title = computed(() =>
  props.message === "multiple_matches"
    ? t("receiving.scanReview.titleMultiple")
    : t("receiving.scanReview.titleNoMatch")
);

const subtitle = computed(() =>
  props.message === "multiple_matches"
    ? t("receiving.scanReview.subtitleMultiple")
    : t("receiving.scanReview.subtitleNoMatch")
);

const qtyValid = computed(
  () => typeof qty.value === "number" && Number.isInteger(qty.value) && qty.value > 0
);

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

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.875rem;
  margin-bottom: 1rem;
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

.options {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.option {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  width: 100%;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 1rem;
  text-align: left;
  cursor: pointer;
}

.option:hover:not(:disabled) {
  border-color: var(--primary);
}

.option:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.option .letter {
  font-size: 1.25rem;
}

.option__title {
  margin: 0;
  font-weight: 700;
}

.option__meta {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  color: var(--muted);
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
