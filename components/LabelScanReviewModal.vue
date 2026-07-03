<template>
  <div
    v-if="modelValue"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="review-title"
    @click.self="!applying && !matching && close()"
    @keydown.esc="!applying && !matching && close()"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="review-title">Review scan</h3>
        <button type="button" class="modal__close" aria-label="Close" :disabled="applying || matching" @click="close">×</button>
      </div>

      <div class="modal__body">
        <div class="preview">
          <img v-if="imageSrc" :src="imageSrc" alt="Captured label" />
          <div v-else class="placeholder">No image</div>
        </div>

        <label class="field field--raw">
          <span>OCR raw text</span>
          <textarea :value="rawText" readonly rows="5" class="raw-text" />
        </label>

        <p class="subtitle">Edit OCR fields and find a matching record.</p>

        <form class="form" @submit.prevent="findMatch">
          <label class="field">
            <span>Part No.</span>
            <input v-model="editable.partNo" type="text" placeholder="e.g. IC-LM358DR" />
          </label>
          <label class="field">
            <span>Date Code</span>
            <input v-model="editable.dateCode" type="text" placeholder="e.g. 2406" />
          </label>
          <label class="field">
            <span>Lot Code</span>
            <input v-model="editable.lotCode" type="text" placeholder="e.g. L240603" />
          </label>
          <label class="field">
            <span>COO</span>
            <input v-model="editable.coo" type="text" placeholder="e.g. MY" />
          </label>
          <label class="field">
            <span>COW</span>
            <input v-model="editable.cow" type="text" placeholder="e.g. USA" />
          </label>
          <label class="field">
            <span>Qty</span>
            <input v-model.number="editable.qty" type="number" min="1" placeholder="e.g. 400" />
          </label>
        </form>

        <div class="match-section">
          <template v-if="localMatchResult.type === 'single'">
            <div class="card card--success">
              <p><strong>1 match found</strong></p>
            </div>
            <button
              type="button"
              class="btn btn--full"
              :disabled="applying"
              @click="applyRecord(localMatchResult.apply)"
            >
              {{ applying ? "Applying…" : "Apply" }}
            </button>
          </template>

          <template v-else-if="localMatchResult.type === 'multiple'">
            <p class="subtitle">Multiple matches found. Choose one.</p>
            <div class="options">
              <button
                v-for="(record, index) in localMatchResult.records"
                :key="index"
                type="button"
                class="option"
                :disabled="applying || matching"
                @click="applyRecord(record.apply)"
              >
                <div class="letter">📦</div>
                <div class="content">
                  <h3>Match {{ index + 1 }}</h3>
                  <p>{{ formatRecord(record.record) }}</p>
                </div>
              </button>
            </div>
          </template>

          <template v-else-if="localMatchResult.type === 'none'">
            <div class="card card--danger">
              <p><strong>No match found</strong></p>
            </div>
          </template>

          <template v-else-if="localMatchResult.type === 'error'">
            <div class="card card--danger">
              <p><strong>Error</strong></p>
              <p class="subtitle">{{ localMatchResult.message }}</p>
            </div>
          </template>
        </div>

        <p v-if="applyError" class="error">{{ applyError }}</p>

        <div class="actions">
          <button type="button" class="btn btn--secondary" :disabled="applying || matching" @click="emit('retake')">Retake</button>
          <button type="button" class="btn btn--secondary" :disabled="applying || matching" @click="close">Cancel</button>
          <button type="button" class="btn" :disabled="applying || matching" @click="findMatch">
            {{ matching ? "Matching…" : "Find match" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Capacitor } from '@capacitor/core';
import type { OcrInput } from '~/composables/useMockOcr';
import { runScanMatcher, type ScanMatchResult, type ScanTaskContext } from '~/composables/useScanMatchers';

const props = defineProps<{
  modelValue: boolean;
  imagePath: string;
  text: string;
  barcodes: string;
  parsed: OcrInput;
  matchResult: ScanMatchResult;
  context: ScanTaskContext;
}>();

const rawText = computed(() => {
  const lines: string[] = [];
  if (props.text) {
    lines.push(props.text);
  }
  if (props.barcodes && props.barcodes !== '[]') {
    try {
      const parsed = JSON.parse(props.barcodes) as Array<{ value?: string; format?: string }>;
      const barcodeLines = parsed
        .map((b) => `[${b.format ?? 'BARCODE'}] ${b.value ?? ''}`)
        .filter(Boolean);
      if (barcodeLines.length > 0) {
        lines.push('', 'Barcodes:', ...barcodeLines);
      }
    } catch {
      lines.push('', 'Barcodes:', props.barcodes);
    }
  }
  return lines.join('\n');
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'applied'): void;
  (e: 'retake'): void;
}>();

const localMatchResult = ref<ScanMatchResult>(props.matchResult);
const editable = ref<OcrInput>({ ...props.parsed });
const applying = ref(false);
const matching = ref(false);
const applyError = ref<string | null>(null);

const imageSrc = computed(() => {
  if (!props.imagePath) return '';
  return Capacitor.convertFileSrc(props.imagePath);
});

watch(() => props.matchResult, (v) => { localMatchResult.value = v; });
watch(() => props.parsed, (v) => { editable.value = { ...v }; });

async function findMatch() {
  matching.value = true;
  applyError.value = null;
  try {
    const result = await runScanMatcher(props.context, editable.value);
    localMatchResult.value = result;
  } catch (e: any) {
    localMatchResult.value = { type: 'error', message: e?.message ?? 'Match failed' };
  } finally {
    matching.value = false;
  }
}

async function applyRecord(apply: () => Promise<void>) {
  applying.value = true;
  applyError.value = null;
  try {
    await apply();
    emit('applied');
  } catch (e: any) {
    applyError.value = e?.message ?? 'Apply failed';
  } finally {
    applying.value = false;
  }
}

function close() {
  emit('update:modelValue', false);
}

function formatRecord(record: unknown): string {
  if (record == null) return '—';
  if (typeof record === 'object') {
    const obj = record as Record<string, unknown>;
    if (typeof obj.picking === 'object' && obj.picking !== null) {
      const picking = obj.picking as Record<string, unknown>;
      if (typeof picking.pickingOrderRefNo === 'string') return picking.pickingOrderRefNo;
      return 'Picking order';
    }
    if (typeof obj.pickingOrderRefNo === 'string') return obj.pickingOrderRefNo;
    if (typeof obj.partNo === 'string') return obj.partNo;
    if (typeof obj.id === 'string') return obj.id;
  }
  return String(record);
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

.preview {
  margin-bottom: 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg);
}

.preview img {
  width: 100%;
  display: block;
}

.placeholder {
  padding: 2rem;
  text-align: center;
  color: var(--muted);
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

.field input,
.field textarea {
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 0.9375rem;
}

.field textarea {
  resize: vertical;
  min-height: 4rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.raw-text[readonly] {
  background: var(--bg);
  cursor: text;
}

.error {
  color: var(--danger);
  font-size: 0.875rem;
  margin: 0.75rem 0 0;
}

.match-section {
  margin-top: 1rem;
}

.card {
  padding: 0.75rem;
  background: var(--bg);
  border-radius: var(--radius);
}

.card p {
  margin: 0;
}

.card--success {
  border-left: 4px solid #16a34a;
}

.card--danger {
  border-left: 4px solid #dc2626;
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

.option .content h3 {
  margin: 0;
  font-size: 0.9375rem;
}

.option .content p {
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

.btn--full {
  width: 100%;
  margin-top: 1rem;
}
</style>
