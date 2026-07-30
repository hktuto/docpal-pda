<template>
  <div
    v-if="modelValue"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="filter-title"
    @click.self="cancel"
    @keydown.esc="cancel"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="filter-title">{{ $t('picking.filter.title') }}</h3>
        <button type="button" class="modal__close" :aria-label="$t('actions.close')" @click="cancel">×</button>
      </div>

      <div class="modal__body">
        <div class="field">
          <span>{{ $t('picking.filter.status') }}</span>
          <label v-for="s in pickingStatuses" :key="s" class="check-row">
            <input type="checkbox" :checked="draftStatuses.has(s)" @change="toggleStatus(s)" />
            <span class="badge" :class="badgeClass(s)">{{ $t(`status.picking.${s}`) }}</span>
          </label>
        </div>

        <div class="field">
          <span>{{ $t('picking.filter.allocationStatus') }}</span>
          <label v-for="s in allocationStatuses" :key="s" class="check-row">
            <input type="checkbox" :checked="draftAllocation.has(s)" @change="toggleAllocation(s)" />
            <span class="badge" :class="badgeClass(s)">{{ $t(`status.allocation.${s}`) }}</span>
          </label>
        </div>
        <p class="muted hint">{{ $t('picking.filter.hint') }}</p>

        <div class="actions">
          <button type="button" class="btn btn--secondary" @click="reset">{{ $t('picking.filter.reset') }}</button>
          <button type="button" class="btn" @click="apply">{{ $t('picking.filter.apply') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { badgeClass } from "~/composables/useStatusBadge";

const props = defineProps<{
  modelValue: boolean;
  /** Currently applied filters; an empty array means "no filter". */
  statuses: string[];
  allocation: string[];
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "apply", payload: { statuses: string[]; allocation: string[] }): void;
}>();

const pickingStatuses = ["pending", "picking", "issue", "finished", "shipped"];
const allocationStatuses = ["allocated", "partial", "unallocated"];

const draftStatuses = ref<Set<string>>(new Set());
const draftAllocation = ref<Set<string>>(new Set());

// Sync the drafts from the applied filters each time the dialog opens.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    draftStatuses.value = new Set(props.statuses);
    draftAllocation.value = new Set(props.allocation);
  },
  { immediate: true }
);

function toggleStatus(s: string) {
  const next = new Set(draftStatuses.value);
  next.has(s) ? next.delete(s) : next.add(s);
  draftStatuses.value = next;
}

function toggleAllocation(s: string) {
  const next = new Set(draftAllocation.value);
  next.has(s) ? next.delete(s) : next.add(s);
  draftAllocation.value = next;
}

function cancel() {
  emit("update:modelValue", false);
}

function reset() {
  draftStatuses.value = new Set();
  draftAllocation.value = new Set();
}

function apply() {
  emit("apply", {
    statuses: [...draftStatuses.value],
    allocation: [...draftAllocation.value],
  });
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

.btn--secondary {
  background: var(--surface);
  color: var(--text);
  border-color: var(--border);
}

.check-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0;
}

.hint {
  font-size: 0.8125rem;
  margin: 0.25rem 0 0;
}
</style>
