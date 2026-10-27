<template>
  <div
    v-if="open"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="label-print-title"
    @click.self="close"
    @keydown.esc="close"
  >
    <div class="modal">
      <div class="modal__header">
        <div>
          <h3 id="label-print-title">{{ $t('picking.printLabels.title') }}</h3>
          <p class="modal__subtitle">{{ $t('picking.printLabels.subtitle', { orderNo: order.orderNo }) }}</p>
        </div>
        <button class="modal__close" :aria-label="$t('common.close')" @click="close">×</button>
      </div>

      <div class="modal__body">
        <LabelPrintRulesPanel ref="panel" :order="order" :matches="matches" />

        <div class="modal__footer">
          <button class="btn btn--secondary" @click="close">{{ $t('picking.printLabels.skip') }}</button>
          <button class="btn" :disabled="panel?.printingAll || panel?.allPrinted" @click="panel?.printAll()">
            <template v-if="panel?.printingAll"><InlineSpinner /> {{ $t('picking.printLabels.printing') }}</template>
            <template v-else>{{ $t('picking.printLabels.printAll') }}</template>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Post-finish label-print prompt (spec 2026-10-27): overlay + header/footer
// around the shared LabelPrintRulesPanel, which owns the per-rule rows and
// all print logic (also embedded by the labeling detail page, spec
// 2026-10-28).
import InlineSpinner from "~/components/InlineSpinner.vue";
import LabelPrintRulesPanel from "~/components/picking/LabelPrintRulesPanel.vue";
import type { LabelPrintRuleMatch, PickingOrderDetail } from "~/services/types";

const props = defineProps<{
  open: boolean;
  order: PickingOrderDetail;
  matches: LabelPrintRuleMatch[];
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
}>();

const panel = ref<InstanceType<typeof LabelPrintRulesPanel> | null>(null);

watch(
  () => props.open,
  (open) => {
    if (open) panel.value?.reset();
  }
);

function close() {
  // Closing mid-print is fine — any in-flight jobs finish in the background.
  emit("update:open", false);
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
  align-items: flex-start;
  padding: 1rem;
  border-bottom: 1px solid var(--border);
}

.modal__header h3 {
  margin: 0;
}

.modal__subtitle {
  margin: 0.25rem 0 0;
  color: var(--muted);
  font-size: 0.8125rem;
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

.modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1rem;
}
</style>
