<template>
  <div
    v-if="open"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="choose-box-title"
    @click.self="close"
    @keydown.esc="close"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="choose-box-title">{{ $t('picking.chooseBoxDialog.title') }}</h3>
        <button class="modal__close" :aria-label="$t('actions.close')" @click="close">×</button>
      </div>

      <div class="modal__body">
        <p v-if="boxes === null" class="muted">{{ $t('picking.chooseBoxDialog.loading') }}</p>
        <p v-else-if="boxes.length === 0" class="muted">{{ $t('picking.chooseBoxDialog.empty') }}</p>
        <div v-else class="box-list">
          <button
            v-for="box in boxes"
            :key="box.id"
            type="button"
            class="box-row"
            @click="emit('select', box.id)"
          >
            <span class="box-row__main">
              <span class="box-row__id">{{ box.id }}</span>
              <span v-if="box.orderId === currentOrderId" class="box-row__chip">
                {{ $t('picking.chooseBoxDialog.thisOrder') }}
              </span>
              <span v-else-if="box.orderNo" class="box-row__order">{{ box.orderNo }}</span>
            </span>
            <span class="box-row__meta">
              {{ $t('picking.chooseBoxDialog.packages', { count: box.packageCount }) }}<template v-if="box.destinationCountry"> · {{ box.destinationCountry }}</template><template v-if="box.boxSize"> · {{ box.boxSize }}</template>
            </span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { OpenShippingBox } from "~/services/types";

defineProps<{
  open: boolean;
  /** null = still loading. */
  boxes: OpenShippingBox[] | null;
  currentOrderId: string;
}>();

const emit = defineEmits<{
  select: [boxId: string];
  close: [];
}>();

function close() {
  emit("close");
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
  max-width: 26.25rem;
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

.muted {
  color: var(--muted);
  margin: 0;
}

.box-list {
  display: flex;
  flex-direction: column;
}

.box-row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-bottom: 1px dashed var(--muted-light, #e5e7eb);
  padding: 0.6rem 0.25rem;
  cursor: pointer;
  color: inherit;
  font: inherit;
}

.box-row:last-child {
  border-bottom: none;
}

.box-row__main {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.box-row__id {
  font-weight: 700;
}

.box-row__chip {
  background: #dbeafe;
  color: #1e40af;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.1rem 0.5rem;
}

.box-row__order {
  color: var(--muted);
  font-size: 0.8125rem;
}

.box-row__meta {
  color: var(--muted);
  font-size: 0.8125rem;
}
</style>
