<template>
  <div
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="pick-from-box-title"
    @click.self="emit('close')"
    @keydown.esc="emit('close')"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="pick-from-box-title">{{ $t('picking.scanSession.boxPickTitle', { box: boxId }) }}</h3>
        <button type="button" class="modal__close" :aria-label="$t('actions.close')" @click="emit('close')">×</button>
      </div>

      <div class="modal__body">
        <p class="subtitle">{{ $t('picking.scanSession.boxPickHint') }}</p>

        <table class="box-pick__table">
          <thead>
            <tr>
              <th>{{ $t('picking.scanSession.colPart') }}</th>
              <th>{{ $t('picking.scanSession.colLot') }}</th>
              <th>{{ $t('picking.scanSession.colQty') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in entries" :key="entry.allocationId">
              <td>
                <span class="box-pick__line">L{{ entry.lineNumber ?? '—' }}/S{{ entry.shipmentNumber ?? '—' }}</span>
                {{ entry.partNo }}
              </td>
              <td>{{ entry.lotCode || $t('common.stateNone') }} / {{ entry.dateCode || $t('common.stateNone') }}</td>
              <td>{{ entry.queued }} / {{ entry.required }}</td>
              <td>
                <span v-if="entry.queued >= entry.required" class="box-pick__done">✓</span>
              </td>
            </tr>
          </tbody>
        </table>

        <p v-if="allDone" class="box-pick__all-done">{{ $t('picking.scanSession.boxPickAllDone') }}</p>

        <div class="actions">
          <button type="button" class="btn btn--secondary" @click="emit('close')">
            {{ $t('actions.close') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
export interface PickFromBoxEntry {
  itemId: string;
  allocationId: string;
  lineNumber: number | null;
  shipmentNumber: number | null;
  partNo: string;
  lotCode: string | null;
  dateCode: string | null;
  required: number;
  queued: number;
}

const props = defineProps<{
  boxId: string;
  entries: PickFromBoxEntry[];
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const allDone = computed(
  () => props.entries.length > 0 && props.entries.every((e) => e.queued >= e.required)
);
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
  font-size: 1rem;
  word-break: break-all;
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

.box-pick__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.box-pick__table th,
.box-pick__table td {
  text-align: left;
  padding: 0.5rem;
  border-bottom: 1px solid var(--border, #e5e7eb);
}

.box-pick__line {
  color: var(--muted);
  font-weight: 400;
  margin-right: 0.25rem;
}

.box-pick__done {
  color: #059669;
  font-weight: 700;
}

.box-pick__all-done {
  color: #059669;
  font-size: 0.875rem;
  margin: 0.75rem 0 0;
}

.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}

.actions .btn {
  flex: 1;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font-size: 0.9375rem;
  cursor: pointer;
}
</style>
