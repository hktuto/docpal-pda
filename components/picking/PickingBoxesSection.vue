<template>
  <div class="section-title" style="display: flex; justify-content: space-between; align-items: center;">
    <h2 style="margin: 0;">Boxes({{ boxes?.length ?? 0 }})</h2>
    <div style="display: flex; gap: 0.5rem; align-items: center;">
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

  <div v-if="expanded" style="margin-bottom: 1.5rem;">
    <p v-if="!boxes?.length" class="empty">No boxes yet.</p>

    <div
      v-for="box in boxes"
      :key="box.id"
      class="card"
      style="margin-bottom: 1rem;"
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
      <div v-if="box.status === 'open' && (box.packages?.length ?? 0) === 0" style="margin-top: 1rem;">
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
const props = defineProps<{
  boxes: any[];
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

function boxTotalQty(box: any) {
  return (box.packages ?? []).reduce((sum: number, p: any) => sum + p.qty, 0);
}
</script>
