<template>
  <div class="section-title boxes-header">
    <h2 class="boxes-title">{{ $t('picking.boxesSection.title', { count: boxes?.length ?? 0 }) }}</h2>
    <div class="boxes-actions">
      <button
        v-if="actionable"
        class="btn btn--small"
        :disabled="creatingBox"
        @click="$emit('create-box')"
      >
        <template v-if="creatingBox">
          <InlineSpinner /> {{ $t('actions.creating') }}
        </template>
        <template v-else>
          {{ $t('picking.boxesSection.newBox') }}
        </template>
      </button>
      <button
        class="btn btn--small btn--ghost"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? $t('actions.hide') : $t('actions.show') }}
      </button>
    </div>
  </div>

  <div v-if="expanded" class="boxes-list">
    <p v-if="!boxes?.length" class="empty">{{ $t('common.noBoxes') }}</p>

    <div
      v-for="box in boxes"
      :key="box.id"
      class="card box-card"
      :class="{ 'card--done': box.status !== 'open' }"
    >
      <DetailRow :label="$t('picking.boxesSection.boxId')">
        <span class="card__title">{{ box.id }}</span>
      </DetailRow>
      <DetailRow :label="$t('picking.boxesSection.status')">
        <span class="badge" :class="badgeClass(box.status)">{{ statusLabel.box(box.status) }}</span>
      </DetailRow>
      <DetailRow :label="$t('picking.boxesSection.packages')" :value="box.packages?.length ?? 0" />
      <DetailRow :label="$t('picking.boxesSection.qty')" :value="boxTotalQty(box.packages ?? [])" />
      <div v-if="box.status === 'open' && (box.packages?.length ?? 0) === 0" class="box-cancel">
        <button
          class="btn btn--small btn--danger"
          :disabled="cancellingBox[box.id]"
          @click="$emit('cancel-box', box.id)"
        >
          {{ cancellingBox[box.id] ? $t('actions.canceling') : $t('picking.boxesSection.cancelBox') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PickingOrderDetail } from "~/services/types";
import { badgeClass } from "~/composables/useStatusBadge";
import { boxTotalQty } from "~/utils/box";

const statusLabel = useStatusLabel();

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
