<template>
  <h2 class="section-title">{{ $t('receiving.pickingTab.title') }}</h2>
  <input
    :value="searchQuery"
    type="text"
    :placeholder="$t('common.searchPickingOrdersOrParts')"
    style="width: 100%; margin-bottom: 1rem;"
    @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
  />
  <p v-if="pickingOrders.length === 0" class="empty">
    {{ $t('common.noPickingOrdersLinked') }}
  </p>

  <div v-for="po in pickingOrders" :key="po.id" class="card" style="margin-bottom: 1.5rem;">
    <DetailRow :label="$t('receiving.pickingTab.pickingOrder')">
      <NuxtLink :to="`/picking/${po.id}`" class="card__title">{{ po.orderNo }}</NuxtLink>
    </DetailRow>
    <DetailRow :label="$t('receiving.pickingTab.status')">
      <span class="badge" :class="badgeClass(po.status)">{{ statusLabel.picking(po.status) }}</span>
    </DetailRow>

    <div v-if="po.boxes.length" style="margin-top: 0.75rem;">
      <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">{{ $t('receiving.pickingTab.boxes') }}</h3>
      <div
        v-for="box in po.boxes"
        :key="box.id"
        class="lot"
        style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap;"
      >
        <span style="font-size: 0.875rem; font-weight: 600;">{{ box.id }}</span>
        <span class="badge" :class="badgeClass(box.status)">{{ statusLabel.box(box.status) }}</span>
      </div>
    </div>

    <div v-for="pi in po.items" :key="pi.id" class="lot" style="margin-top: 0.75rem;">
      <DetailRow :label="$t('receiving.itemsTab.part')" :value="pi.wclItemNo ?? pi.partNo" />
      <DetailRow :label="$t('receiving.pickingTab.requiredScannedBoxed')" :value="`${pi.qty} / ${scannedQty(pi)} / ${boxedQty(pi)}`" />
      <DetailRow :label="$t('receiving.pickingTab.status')">
        <span
          class="badge"
          :class="badgeClass(boxedQty(pi) >= pi.qty ? 'finished' : 'picking')"
        >
          {{ boxedQty(pi) >= pi.qty ? statusLabel.picking('finished') : statusLabel.picking('picking') }}
        </span>
      </DetailRow>
      <div v-if="allocatedLocations(pi).length" class="detail-row">
        <span class="detail-label">{{ $t('receiving.pickingTab.allocatedLots') }}</span>
      </div>
      <ul v-if="allocatedLocations(pi).length" style="margin: 0; padding-left: 1.25rem; font-size: 0.875rem; color: var(--muted);">
        <li v-for="loc in allocatedLocations(pi)" :key="loc.id">
          {{ loc.lot?.shelfCode || (loc.lot?.boxId ? $t('common.inBox', { id: loc.lot.boxId }) : $t('receiving.pickingTab.receivingArea')) }}
          <span
            v-if="loc.lot?.shelfWarning"
            style="cursor: help;"
            :title="loc.lot.shelfWarning"
            role="img"
            :aria-label="loc.lot.shelfWarning"
          >⚠️</span>
          · {{ loc.lot?.dateCode || $t('common.stateNone') }} / {{ loc.lot?.lotCode || $t('common.stateNone') }} / {{ loc.lot?.coo || $t('common.stateNone') }} / {{ loc.lot?.cow || $t('common.stateNone') }}
          · {{ loc.qty }} {{ $t('common.pcs') }}
        </li>
      </ul>

      <div v-if="pi.packages.length" style="margin-top: 0.75rem;">
        <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">{{ $t('receiving.pickingTab.packages') }}</h3>
        <div
          v-for="pkg in pi.packages"
          :key="pkg.id"
          class="lot"
          style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; justify-content: space-between;"
        >
          <div style="display: flex; flex-direction: column; gap: 0.25rem;">
            <span style="font-size: 0.875rem;">
              {{ pkg.qty }} {{ $t('common.pcs') }} · {{ pkg.dateCode || $t('common.stateNone') }} / {{ pkg.lotCode || $t('common.stateNone') }}
            </span>
            <span style="font-size: 0.75rem; color: var(--muted);">
              <template v-if="pkg.shippingBoxId">{{ $t('common.inBox', { id: pkg.shippingBoxId }) }}</template>
              <template v-else>{{ $t('common.unboxed') }}</template>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type {
  ReceivingPickingAllocation,
  ReceivingPickingItem,
  ReceivingPickingOrder,
} from "~/services/types";
import { badgeClass } from "~/composables/useStatusBadge";

const statusLabel = useStatusLabel();

defineProps<{
  pickingOrders: ReceivingPickingOrder[];
  searchQuery: string;
}>();

const emit = defineEmits<{
  "update:searchQuery": [value: string];
}>();

function scannedQty(item: ReceivingPickingItem): number {
  return item.packages.reduce((sum, p) => sum + p.qty, 0);
}

function boxedQty(item: ReceivingPickingItem): number {
  return item.packages.filter((p) => p.shippingBoxId).reduce((sum, p) => sum + p.qty, 0);
}

function allocatedLocations(item: ReceivingPickingItem): ReceivingPickingAllocation[] {
  return item.allocations.filter((a) => a.qty > 0);
}
</script>
