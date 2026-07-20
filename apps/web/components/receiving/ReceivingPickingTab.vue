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
      <NuxtLink :to="`/picking/${po.id}`" class="card__title">{{ po.refNo }}</NuxtLink>
    </DetailRow>
    <DetailRow :label="$t('receiving.pickingTab.status')">
      <span class="badge" :class="badgeClass(po.status)">{{ statusLabel.picking(po.status) }}</span>
    </DetailRow>

    <div v-if="po.status !== 'finished'" style="margin-top: 0.75rem; display: flex; gap: 0.5rem;">
      <button class="btn btn--small" @click="emit('scan', po.id)">
        {{ $t('receiving.pickingTab.scan') }}
      </button>
      <button class="btn btn--small" :disabled="creatingBox[po.id]" @click="emit('create-box', po.id)">
        <template v-if="creatingBox[po.id]">
          <InlineSpinner /> {{ $t('receiving.pickingTab.creating') }}
        </template>
        <template v-else>
          {{ $t('receiving.pickingTab.createBox') }}
        </template>
      </button>
    </div>

    <div v-if="po.boxes.length" style="margin-top: 0.75rem;">
      <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">{{ $t('receiving.pickingTab.boxes') }}</h3>
      <div
        v-for="box in po.boxes"
        :key="box.id"
        class="lot"
        style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap;"
      >
        <span style="font-size: 0.875rem; font-weight: 600;">{{ box.id }}</span>
        <button class="btn btn--small" @click="emit('print-box', box.id)">
          {{ $t('receiving.pickingTab.print') }}
        </button>
        <button
          v-if="box.status === 'open'"
          class="btn btn--small"
          :disabled="anyAddingAll || addingAll[box.id] || !(unboxedCountByOrderId[po.id] > 0)"
          @click="emit('add-all-to-box', box.id)"
        >
          <template v-if="addingAll[box.id]">
            <InlineSpinner /> {{ $t('receiving.pickingTab.addAll') }}
          </template>
          <template v-else>
            {{ $t('receiving.pickingTab.addAll') }}
          </template>
        </button>
      </div>
    </div>

    <div v-for="pi in po.items" :key="pi.id" class="lot" style="margin-top: 0.75rem;">
      <DetailRow :label="$t('receiving.itemsTab.part')" :value="pi.partNo" />
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
          <div v-if="!pkg.shippingBoxId" style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
            <select
              :value="boxSelections[pkg.id]"
              :disabled="addingPackage[pkg.id] || removingPackage[pkg.id]"
              style="min-width: 8rem;"
              @change="updateBoxSelection(pkg.id, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">{{ $t('receiving.pickingTab.selectBox') }}</option>
              <option v-for="box in openBoxesForOrder(po.id)" :key="box.id" :value="box.id">{{ box.id }}</option>
            </select>
            <button
              class="btn btn--small"
              :disabled="addingPackage[pkg.id] || removingPackage[pkg.id] || !boxSelections[pkg.id]"
              @click="emit('add-to-box', pkg.id)"
            >
              <template v-if="addingPackage[pkg.id]">
                <InlineSpinner /> {{ $t('receiving.pickingTab.adding') }}
              </template>
              <template v-else>
                {{ $t('receiving.pickingTab.addToBox') }}
              </template>
            </button>
            <button
              class="btn btn--small btn--secondary"
              :disabled="addingPackage[pkg.id] || removingPackage[pkg.id]"
              @click="emit('remove-scanned-package', pkg.id)"
            >
              <template v-if="removingPackage[pkg.id]">
                <InlineSpinner /> {{ $t('receiving.pickingTab.removingScanned') }}
              </template>
              <template v-else>
                {{ $t('receiving.pickingTab.removeScanned') }}
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
        <button class="btn btn--small" @click="toggleExpand(pi.id)">
          {{ expandedItems.has(pi.id) ? $t('receiving.pickingTab.hideLogs') : $t('receiving.pickingTab.showLogs') }}
          ({{ pi.transitionLogs.length }})
        </button>

        <div v-if="expandedItems.has(pi.id)" style="width: 100%; margin-top: 0.5rem;">
          <p v-if="!pi.transitionLogs.length" class="card__meta">{{ $t('receiving.pickingTab.noLogs') }}</p>
          <ul v-else style="margin: 0; padding-left: 1.25rem; font-size: 0.875rem; color: var(--muted);">
            <li v-for="(log, idx) in pi.transitionLogs" :key="idx" style="margin-bottom: 0.35rem;">
              {{ new Date(log.createdAt).toLocaleString() }}
              · {{ log.actorId || $t('common.actorSystem') }}
              · {{ logStateLabel(log.fromState) }} → {{ logStateLabel(log.toState) }}
            </li>
          </ul>
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

const { t } = useI18n();
const statusLabel = useStatusLabel();
const logStateLabel = (code: string | null | undefined) =>
  code ? t(`logStates.${code}`) : t("common.stateNone");

const props = defineProps<{
  pickingOrders: ReceivingPickingOrder[];
  boxSelections: Record<string, string>;
  creatingBox: Record<string, boolean>;
  addingPackage: Record<string, boolean>;
  removingPackage: Record<string, boolean>;
  addingAll: Record<string, boolean>;
  anyAddingAll: boolean;
  expandedItems: Set<string>;
  searchQuery: string;
}>();

const emit = defineEmits<{
  "update:searchQuery": [value: string];
  "update:expandedItems": [value: Set<string>];
  "update:boxSelections": [value: Record<string, string>];
  "create-box": [pickingOrderId: string];
  scan: [pickingOrderId: string];
  "print-box": [boxId: string];
  "add-all-to-box": [boxId: string];
  "add-to-box": [packageId: string];
  "remove-from-box": [packageId: string];
  "remove-scanned-package": [packageId: string];
}>();

const unboxedCountByOrderId = computed(() => {
  const counts: Record<string, number> = {};
  for (const po of props.pickingOrders) {
    let count = 0;
    for (const item of po.items) {
      count += item.packages.filter((p) => !p.shippingBoxId).length;
    }
    counts[po.id] = count;
  }
  return counts;
});

function scannedQty(item: ReceivingPickingItem): number {
  return item.packages.reduce((sum, p) => sum + p.qty, 0);
}

function boxedQty(item: ReceivingPickingItem): number {
  return item.packages.filter((p) => p.shippingBoxId).reduce((sum, p) => sum + p.qty, 0);
}

function allocatedLocations(item: ReceivingPickingItem): ReceivingPickingAllocation[] {
  return item.allocations.filter((a) => a.qty > 0);
}

function openBoxesForOrder(pickingOrderId: string) {
  const po = props.pickingOrders.find((o) => o.id === pickingOrderId);
  return (po?.boxes ?? []).filter((b) => b.status === "open");
}

function boxById(boxId: string | null | undefined) {
  if (!boxId) return undefined;
  for (const po of props.pickingOrders) {
    const box = po.boxes.find((b) => b.id === boxId);
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
</script>
