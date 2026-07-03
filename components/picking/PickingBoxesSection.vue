<template>
  <div class="section-title boxes-header">
    <h2 class="boxes-title">Boxes ({{ boxes?.length ?? 0 }})</h2>
    <div class="boxes-actions">
      <button
        v-if="actionable"
        class="btn btn--small"
        :disabled="creatingBox"
        @click="$emit('create-box')"
      >
        {{ creatingBox ? "Creating…" : "New box" }}
      </button>
      <button
        class="btn btn--small btn--ghost"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? "Hide" : "Show" }}
      </button>
    </div>
  </div>

  <div v-if="expanded" class="boxes-list">
    <p v-if="!boxes?.length" class="empty">No boxes yet.</p>

    <div
      v-for="box in boxes"
      :key="box.id"
      class="card box-card"
      :class="{ 'card--done': box.status !== 'open' }"
    >
      <DetailRow label="Box ID">
        <span class="card__title">{{ box.id }}</span>
      </DetailRow>
      <DetailRow label="Status">
        <StatusBadge :status="box.status" />
      </DetailRow>
      <DetailRow label="Packages" :value="box.packages?.length ?? 0" />
      <DetailRow label="Qty" :value="boxTotalQty(box)" />
      <div v-if="box.status === 'open' && (box.packages?.length ?? 0) === 0" class="box-cancel">
        <button
          class="btn btn--small btn--danger"
          :disabled="cancellingBox[box.id]"
          @click="$emit('cancel-box', box.id)"
        >
          {{ cancellingBox[box.id] ? "Canceling…" : "Cancel box" }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { type PickingOrderDetail } from "~/db/picking";

const props = defineProps<{
  boxes: PickingOrderDetail["shippingBoxes"];
  actionable: boolean;
  creatingBox: boolean;
  cancellingBox: Record<string, boolean>;
  expanded: boolean;
}>();

const emit = defineEmits<{
  "create-box": [];
  "cancel-box": [boxId: string];
  "update:expanded": [value: boolean];
}>();

const expanded = computed({
  get: () => props.expanded,
  set: (value) => emit("update:expanded", value),
});

function boxTotalQty(box: PickingOrderDetail["shippingBoxes"][number]) {
  return (box.packages ?? []).reduce((sum, p) => sum + p.qty, 0);
}
</script>

<style scoped>
.boxes-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.boxes-title {
  margin: 0;
}

.boxes-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.boxes-list {
  margin-bottom: 1.5rem;
}

.box-card {
  margin-bottom: 1rem;
}

.box-cancel {
  margin-top: 1rem;
}
</style>
