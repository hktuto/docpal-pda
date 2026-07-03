<template>
  <div class="lots-panel">
    <h2 class="section-title">Available receiving-area lots</h2>
    <p v-if="lots.length === 0" class="empty">No lots available for put-away.</p>

    <div
      v-for="lot in lots"
      :key="lot.receiving_invoice_item_id"
      class="card"
    >
      <DetailRow label="Part">
        <span class="card__title">{{ lot.part_no || "—" }}</span>
      </DetailRow>
      <DetailRow label="Available qty">
        <span>{{ lot.available_qty }}</span>
      </DetailRow>
      <DetailRow label="Date / Lot">
        <span>{{ lot.date_code || "—" }} / {{ lot.lot_code || "—" }}</span>
      </DetailRow>
      <DetailRow label="COO / COW">
        <span>{{ lot.coo || "—" }} / {{ lot.cow || "—" }}</span>
      </DetailRow>

      <div class="lot-actions">
        <select
          class="target-box-select"
          :value="targetBoxSelections[lot.receiving_invoice_item_id]"
          :disabled="scanning"
          @change="onBoxChange(lot.receiving_invoice_item_id, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">Select target box</option>
          <option v-for="box in openBoxes" :key="box.id" :value="box.id">
            {{ box.id }} — {{ box.shelfCode || "—" }}
          </option>
        </select>
        <button
          class="btn btn--small"
          :disabled="!hasOpenBox || scanning || !targetBoxSelections[lot.receiving_invoice_item_id]"
          @click="emit('scan', lot)"
        >
          Scan
        </button>
        <p v-if="!hasOpenBox" class="helper-text">
          Create an open box first.
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
