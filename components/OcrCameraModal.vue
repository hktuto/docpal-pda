<template>
  <div
    v-if="modelValue"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="ocr-camera-title"
    @click.self="!isScanning && close()"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="ocr-camera-title">Camera OCR</h3>
        <button class="modal__close" aria-label="Close" :disabled="isScanning" @click="close">×</button>
      </div>

      <div class="modal__body">
        <p class="subtitle">Take a photo of a label or document to extract text.</p>

        <div v-if="previewUrl" class="preview">
          <img :src="previewUrl" alt="Captured photo" />
        </div>

        <div v-if="error" class="error">{{ error }}</div>

        <div v-if="result" class="result">
          <h4>Recognized text</h4>
          <pre>{{ result.text }}</pre>
        </div>

        <button
          class="btn"
          style="width: 100%; margin-top: 1rem;"
          :disabled="isScanning"
          @click="onTakePhoto"
        >
          {{ isScanning ? 'Scanning…' : (result ? 'Scan again' : 'Take photo') }}
        </button>

        <button
          v-if="result"
          class="btn btn--secondary"
          style="width: 100%; margin-top: 0.5rem;"
          @click="useResult"
        >
          Use this text
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TextDetectionResult } from '@pantrist/capacitor-plugin-ml-kit-text-recognition';

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'result', value: TextDetectionResult): void;
}>();

const { scanText, isScanning, previewUrl, clearPreview } = useCameraOcr();
const result = ref<TextDetectionResult | null>(null);
const error = ref<string | null>(null);

watch(
  () => props.modelValue,
  (open) => {
    if (!open) {
      result.value = null;
      error.value = null;
      clearPreview();
    }
  },
);

async function onTakePhoto() {
  error.value = null;
  result.value = null;
  clearPreview();

  try {
    result.value = await scanText();
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to capture or recognize text.';
  }
}

function useResult() {
  if (!result.value) return;
  emit('result', result.value);
  close();
}

function close() {
  emit('update:modelValue', false);
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

.subtitle {
  color: var(--muted);
  font-size: 0.875rem;
  margin: 0 0 1rem;
}

.preview {
  margin-bottom: 1rem;
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--border);
}

.preview img {
  display: block;
  width: 100%;
  height: auto;
}

.error {
  color: var(--danger);
  font-size: 0.875rem;
  margin-bottom: 1rem;
}

.result {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem;
  margin-bottom: 1rem;
}

.result h4 {
  margin: 0 0 0.5rem;
  font-size: 0.875rem;
  color: var(--muted);
}

.result pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.937rem;
}

.btn--secondary {
  background: var(--surface);
  color: var(--primary);
  border-color: var(--primary);
}
</style>
