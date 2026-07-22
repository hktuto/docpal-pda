<template>
  <div
    v-if="modelValue"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="scan-box-title"
    @click.self="close"
    @keydown.esc="close"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="scan-box-title">{{ $t('scanBoxDialog.title') }}</h3>
        <button type="button" class="modal__close" :aria-label="$t('scanBoxDialog.close')" @click="close">×</button>
      </div>

      <div class="modal__body">
        <label class="field">
          <span>{{ $t('scanBoxDialog.boxId') }}</span>
          <input
            type="text"
            :value="boxId"
            :placeholder="$t('scanBoxDialog.boxIdPlaceholder')"
            @input="emit('update:boxId', ($event.target as HTMLInputElement).value)"
          />
        </label>

        <label class="field">
          <span>{{ $t('scanBoxDialog.shelf') }}</span>
          <select v-model="selectedShelf">
            <option value="">{{ $t('scanBoxDialog.defaultOption') }}</option>
            <option v-for="shelf in shelves" :key="shelf.code" :value="shelf.code">
              {{ shelf.zone ? $t('common.shelfFormat', { code: shelf.code, zone: shelf.zone }) : shelf.code }}
            </option>
          </select>
        </label>

        <div class="actions">
          <button type="button" class="btn btn--secondary" @click="close">{{ $t('scanBoxDialog.cancel') }}</button>
          <button type="button" class="btn" :disabled="!boxId.trim() || !selectedShelf || creating" @click="confirm">
            {{ creating ? $t('scanBoxDialog.creating') : $t('scanBoxDialog.confirm') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Shelf } from "~/services/types";

useI18n();

const props = defineProps<{
  modelValue: boolean;
  boxId: string;
  shelves: Shelf[];
  creating?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "update:boxId", value: string): void;
  (e: "confirm", boxId: string, shelfCode: string): void;
}>();

const selectedShelf = ref("");

watch(
  () => props.modelValue,
  (open) => {
    if (open) selectedShelf.value = "";
  },
  { immediate: true }
);

function close() {
  emit("update:modelValue", false);
}

function confirm() {
  const boxId = props.boxId.trim();
  if (!boxId || !selectedShelf.value) return;
  emit("confirm", boxId, selectedShelf.value);
  close();
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
  max-width: 360px;
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

.field > span {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
}

.field select,
.field input {
  width: 100%;
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 1rem;
  background: var(--surface);
}

.actions {
  display: flex;
  gap: 0.5rem;
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
