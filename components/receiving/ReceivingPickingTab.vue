<template>
  <h2 class="section-title">{{ $t('receiving.pickingTab.title') }}</h2>
  <input
    :value="searchQuery"
    type="text"
    :placeholder="$t('common.searchPickingOrdersOrParts')"
    style="width: 100%; margin-bottom: 1rem;"
    @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
  />
  <p v-if="filteredGroupedPickingOrders.length === 0" class="empty">
    {{ $t('common.noPickingOrdersLinked') }}
  </p>

  <div v-for="po in filteredGroupedPickingOrders" :key="po.id" class="card" style="margin-bottom: 1.5rem;">
    <DetailRow :label="$t('receiving.pickingTab.pickingOrder')">
      <NuxtLink :to="`/picking/${po.id}`" class="card__title">{{ po.ref_no }}</NuxtLink>
    </DetailRow>
    <DetailRow :label="$t('receiving.pickingTab.status')">
      <StatusBadge :status="po.status">{{ statusLabel.picking(po.status) }}</StatusBadge>
    </DetailRow>

    <div v-if="po.status !== 'finished'" style="margin-top: 0.75rem;">
      <button class="btn btn--small" :disabled="creatingBox[po.id]" @click="emit('create-box', po.id)">
        <template v-if="creatingBox[po.id]">
          <InlineSpinner /> {{ $t('receiving.pickingTab.creating') }}
        </template>
        <template v-else>
          {{ $t('receiving.pickingTab.createBox') }}
        </template>
      </button>
    </div>

    <div v-if="(boxesByOrder[po.id] || []).length" style="margin-top: 0.75rem;">
      <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">{{ $t('receiving.pickingTab.boxes') }}</h3>
      <div
        v-for="box in boxesByOrder[po.id]"
        :key="box.id"
        class="lot"
        style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap;"
      >
        <span style="font-size: 0.875rem; font-weight: 600;">{{ box.id }}</span>
        <StatusBadge :status="box.status">{{ statusLabel.box(box.status) }}</StatusBadge>
      </div>
    </div>

    <div v-for="pi in po.items" :key="pi.id" class="lot" style="margin-top: 0.75rem;">
      <DetailRow :label="$t('receiving.itemsTab.part')" :value="pi.part_no" />
      <DetailRow :label="$t('receiving.pickingTab.requiredScannedBoxed')" :value="`${pi.required_qty} / ${pi.scanned_qty} / ${pi.boxed_qty}`" />
      <DetailRow :label="$t('receiving.pickingTab.status')">
        <StatusBadge :status="pi.boxed_qty >= pi.required_qty ? 'finished' : 'picking'">
          {{ pi.boxed_qty >= pi.required_qty ? statusLabel.picking('finished') : statusLabel.picking('picking') }}
        </StatusBadge>
      </DetailRow>
      <div v-if="allocatedLocations(pi).length" class="detail-row">
        <span class="detail-label">{{ $t('receiving.pickingTab.allocatedLots') }}</span>
      </div>
      <ul v-if="allocatedLocations(pi).length" style="margin: 0; padding-left: 1.25rem; font-size: 0.875rem; color: var(--muted);">
        <li v-for="(loc, idx) in allocatedLocations(pi)" :key="idx">
          {{ loc.shelf_code || (loc.box_id ? $t('common.inBox', { id: loc.box_id }) : $t('receiving.pickingTab.receivingArea')) }}
          · {{ loc.date_code || $t('common.stateNone') }} / {{ loc.lot_code || $t('common.stateNone') }} / {{ loc.coo || $t('common.stateNone') }} / {{ loc.cow || $t('common.stateNone') }}
          · {{ loc.allocated_qty }} {{ $t('common.pcs') }}
        </li>
      </ul>

      <div v-if="packagesByItem[pi.id]?.length" style="margin-top: 0.75rem;">
        <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">{{ $t('receiving.pickingTab.packages') }}</h3>
        <div
          v-for="pkg in packagesByItem[pi.id]"
          :key="pkg.id"
          class="lot"
          style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; justify-content: space-between;"
        >
          <div style="display: flex; flex-direction: column; gap: 0.25rem;">
            <span style="font-size: 0.875rem;">
              {{ pkg.qty }} {{ $t('common.pcs') }} · {{ pkg.dateCode || $t('common.stateNone') }} / {{ pkg.lotCode || $t('common.stateNone') }} / {{ pkg.coo || $t('common.stateNone') }} / {{ pkg.cow || $t('common.stateNone') }}
            </span>
            <span style="font-size: 0.75rem; color: var(--muted);">
              <template v-if="pkg.shippingBoxId">{{ $t('common.inBox', { id: pkg.shippingBoxId }) }}</template>
              <template v-else>{{ $t('common.unboxed') }}</template>
            </span>
          </div>
          <div v-if="!pkg.shippingBoxId" style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
            <select
              :value="boxSelections[pkg.id]"
              :disabled="addingPackage[pkg.id]"
              style="min-width: 8rem;"
              @change="updateBoxSelection(pkg.id, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">{{ $t('receiving.pickingTab.selectBox') }}</option>
              <option v-for="box in openBoxesForOrder(po.id)" :key="box.id" :value="box.id">{{ box.id }}</option>
            </select>
            <button
              class="btn btn--small"
              :disabled="addingPackage[pkg.id] || !boxSelections[pkg.id]"
              @click="emit('add-to-box', pkg.id)"
            >
              <template v-if="addingPackage[pkg.id]">
                <InlineSpinner /> {{ $t('receiving.pickingTab.adding') }}
              </template>
              <template v-else>
                {{ $t('receiving.pickingTab.addToBox') }}
              </template>
            </button>
          </div>
          <button
            v-else-if="boxById(pkg.shippingBoxId)?.status === 'open'"
            class="btn btn--small"
            :disabled="removingPackage[pkg.id]"
            @click="emit('remove-from-box', pkg.id)"
          >
            <template v-if="removingPackage[pkg.id]">
              <InlineSpinner /> {{ $t('receiving.pickingTab.removing') }}
            </template>
            <template v-else>
              {{ $t('receiving.pickingTab.removeFromBox') }}
            </template>
          </button>
        </div>
      </div>

      <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem; flex-wrap: wrap;">
        <button class="btn btn--small" :disabled="scanning" @click="emit('scan', pi.id)">{{ $t('receiving.pickingTab.scan') }}</button>
        <button class="btn btn--small" @click="toggleExpand(pi.id)">
          {{ expandedItems.has(pi.id) ? $t('receiving.pickingTab.hideLogs') : $t('receiving.pickingTab.showLogs') }}
          ({{ (transitionLogs[pi.id] || []).length }})
        </button>

        <div v-if="expandedItems.has(pi.id)" style="width: 100%; margin-top: 0.5rem;">
          <p v-if="!(transitionLogs[pi.id] || []).length" class="card__meta">{{ $t('receiving.pickingTab.noLogs') }}</p>
          <ul v-else style="margin: 0; padding-left: 1.25rem; font-size: 0.875rem; color: var(--muted);">
            <li v-for="log in transitionLogs[pi.id]" :key="log.id" style="margin-bottom: 0.35rem;">
              {{ new Date(log.createdAt).toLocaleString() }}
              · {{ log.actorName || $t('common.actorSystem') }}
              · {{ logStateLabel(log.fromState) }} → {{ logStateLabel(log.toState) }}
              <span v-if="log.metadata">
                · {{ logMetadataText(log.metadata) }}
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { GroupedItem, GroupedOrder, TransitionLog, DisplayBox, DisplayPackage } from "./types";
import { useLogStateLabel } from "~/composables/useLogStateLabel";

const statusLabel = useStatusLabel();
const logStateLabel = useLogStateLabel();

const props = defineProps<{
  filteredGroupedPickingOrders: GroupedOrder[];
  boxesByOrder: Record<string, DisplayBox[]>;
  packagesByItem: Record<string, DisplayPackage[]>;
  transitionLogs: Record<string, TransitionLog[]>;
  boxSelections: Record<string, string>;
  creatingBox: Record<string, boolean>;
  addingPackage: Record<string, boolean>;
  removingPackage: Record<string, boolean>;
  scanning: boolean;
  expandedItems: Set<string>;
  searchQuery: string;
}>();

const emit = defineEmits<{
  "update:searchQuery": [value: string];
  "update:expandedItems": [value: Set<string>];
  "update:boxSelections": [value: Record<string, string>];
  "create-box": [pickingOrderId: string];
  "add-to-box": [packageId: string];
  "remove-from-box": [packageId: string];
  scan: [pickingItemId?: string];
}>();

function openBoxesForOrder(pickingOrderId: string) {
  return (props.boxesByOrder[pickingOrderId] ?? []).filter((b) => b.status === "open");
}

function boxById(boxId: string | null | undefined) {
  if (!boxId) return undefined;
  for (const boxes of Object.values(props.boxesByOrder)) {
    const box = boxes.find((b) => b.id === boxId);
    if (box) return box;
  }
  return undefined;
}

function updateBoxSelection(packageId: string, value: string) {
  emit("update:boxSelections", { ...props.boxSelections, [packageId]: value });
}

function toggleExpand(itemId: string) {
  const next = new Set(props.expandedItems);
  if (next.has(itemId)) next.delete(itemId);
  else next.add(itemId);
  emit("update:expandedItems", next);
}

function allocatedLocations(item: GroupedItem) {
  return item.locations.filter((l) => l.allocated_qty > 0);
}

function logMetadataText(metadata: string | null): string | number | undefined {
  if (!metadata) return undefined;
  const parsed = JSON.parse(metadata);
  return parsed.qty ?? parsed.note;
}
</script>
