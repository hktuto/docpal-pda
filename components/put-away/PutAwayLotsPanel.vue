<template>
  <div class="lots-panel">
    <h2 class="section-title">{{ $t('putAway.lotsPanel.title') }}</h2>
    <p v-if="lots.length === 0" class="empty">{{ $t('common.noLots') }}</p>

    <div
      v-for="lot in lots"
      :key="lot.receiving_invoice_item_id"
      class="card"
    >
      <DetailRow :label="$t('putAway.lotsPanel.part')">
        <span class="card__title">{{ lot.part_no || $t('common.noData') }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.availableQty')">
        <span>{{ lot.available_qty }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.dateLot')">
        <span>{{ lot.date_code || $t('common.noData') }} / {{ lot.lot_code || $t('common.noData') }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.cooCow')">
        <span>{{ lot.coo || $t('common.noData') }} / {{ lot.cow || $t('common.noData') }}</span>
      </DetailRow>

      <div class="lot-actions">
        <select
          class="target-box-select"
          :value="targetBoxSelections[lot.receiving_invoice_item_id]"
          :disabled="scanning"
          @change="onBoxChange(lot.receiving_invoice_item_id, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">{{ $t('putAway.lotsPanel.selectTargetBox') }}</option>
          <option v-for="box in openBoxes" :key="box.id" :value="box.id">
            {{ $t('common.boxFormat', { box: box.id, shelf: box.shelfCode || $t('common.noData') }) }}
          </option>
        </select>
        <button
          class="btn btn--small"
          :disabled="!hasOpenBox || scanning || !targetBoxSelections[lot.receiving_invoice_item_id]"
          @click="emit('scan', lot)"
        >
          {{ $t('actions.scan') }}
        </button>
        <p v-if="!hasOpenBox" class="helper-text">
          {{ $t('common.createOpenBoxFirst') }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PutAwayLot, ShelfBox } from "~/db/putAway";

interface Props {
  lots: PutAwayLot[];
  boxes: ShelfBox[];
  targetBoxSelections: Record<string, string>;
  scanning: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  "update:targetBoxSelections": [value: Record<string, string>];
  scan: [lot: PutAwayLot];
}>();

const openBoxes = computed(() => props.boxes.filter((b) => b.status === "open"));
const hasOpenBox = computed(() => openBoxes.value.length > 0);

function onBoxChange(itemId: string, value: string) {
  emit("update:targetBoxSelections", { ...props.targetBoxSelections, [itemId]: value });
}
</script>

<style scoped>
.lots-panel {
  margin-top: 1.5rem;
}

.section-title {
  margin: 0 0 1rem;
  font-size: 1rem;
}

.lot-actions {
  margin-top: 0.75rem;
}

.target-box-select {
  min-width: 10rem;
  margin-right: 0.5rem;
}

.helper-text {
  margin: 0.5rem 0 0;
  font-size: 0.8125rem;
  color: var(--muted);
}
</style>
