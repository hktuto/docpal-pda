<template>
  <div
    v-if="modelValue && box"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="cn-box-title"
    @click.self="close"
    @keydown.esc="close"
  >
    <div class="modal">
      <div class="modal__header">
        <div>
          <h3 id="cn-box-title">{{ $t('putAway.cn.box.title', { ctnNo: box.ctnNo }) }}</h3>
          <p class="modal__subtitle">
            {{ $t('putAway.cn.box.subtitle', { invoiceNo: box.invoiceNo, boxSeq: box.boxSeq, totalBoxes: box.totalBoxes }) }}
          </p>
        </div>
        <button type="button" class="modal__close" :aria-label="$t('common.close')" @click="close">×</button>
      </div>

      <div class="modal__body">
        <ul class="box-lines">
          <li v-for="line in lines" :key="line.item.id">
            <button
              type="button"
              class="box-line"
              :class="{ 'box-line--selected': line.item.id === selectedItemId, 'box-line--done': line.remaining <= 0 }"
              :disabled="line.remaining <= 0"
              @click="$emit('select', line.item.id)"
            >
              <span class="box-line__main">
                <span class="box-line__part">{{ line.item.partNo }}</span>
                <span v-if="line.item.wclItemNo && line.item.wclItemNo !== line.item.partNo" class="box-line__wcl">
                  {{ line.item.wclItemNo }}
                </span>
              </span>
              <span class="box-line__meta">
                <span v-if="line.item.suggestedShelfCode" class="box-line__shelf">
                  {{ line.item.suggestedShelfCode }}
                </span>
                <span class="box-line__qty">
                  <template v-if="line.remaining <= 0">{{ $t('putAway.cn.box.done') }}</template>
                  <template v-else>{{ $t('putAway.cn.box.qty', { remaining: line.remaining, line: line.item.lineQty ?? '?' }) }}</template>
                </span>
              </span>
            </button>
          </li>
        </ul>
        <p class="box-hint">{{ $t('putAway.cn.box.hint') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PutAwayExpectedItem } from "~/services/types";

useI18n();

export interface CnBoxDialogLine {
  item: PutAwayExpectedItem;
  /** Pieces staged this session for this line (scans[] may already hold some). */
  staged: number;
  /** remainingQty net of staged — what is still physically in the box. */
  remaining: number;
}

defineProps<{
  modelValue: boolean;
  box: { invoiceNo: string; ctnNo: string; boxSeq: number; totalBoxes: number } | null;
  lines: CnBoxDialogLine[];
  selectedItemId: string | null;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "select", itemId: string): void;
}>();

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
  max-width: 26rem;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.modal__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 1rem;
  border-bottom: 1px solid var(--border);
}

.modal__header h3 {
  margin: 0;
  font-size: 1.0625rem;
}

.modal__subtitle {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  color: var(--muted);
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
  padding: 0.5rem 1rem 1rem;
  overflow-y: auto;
}

.box-lines {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.box-line {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.box-line--selected {
  border-color: var(--primary);
  outline: 2px solid var(--primary);
}

.box-line--done {
  opacity: 0.55;
  text-decoration: line-through;
  cursor: default;
}

.box-line__main {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.box-line__part {
  font-weight: 600;
  font-size: 0.9375rem;
  word-break: break-word;
}

.box-line__wcl {
  font-size: 0.75rem;
  color: var(--muted);
  word-break: break-word;
}

.box-line__meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.2rem;
  flex-shrink: 0;
}

.box-line__shelf {
  font-size: 0.75rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
}

.box-line__qty {
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
}

.box-hint {
  margin: 0.75rem 0 0;
  font-size: 0.8125rem;
  color: var(--muted);
}
</style>
