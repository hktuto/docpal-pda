<template>
  <h2 class="section-title">{{ $t('picking.itemsSection.title') }}</h2>
  <div
    v-for="item in items"
    :key="item.id"
    class="card item-card"
    :class="{ 'card--done': item.pickedQty >= item.qty }"
  >
    <DetailRow :label="$t('picking.itemsSection.part')">
      <span class="card__title">{{ item.part?.partNo || $t('common.noData') }}</span>
    </DetailRow>
    <DetailRow :label="$t('picking.itemsSection.requiredQty')" :value="item.qty" />
    <DetailRow :label="$t('picking.itemsSection.scannedQty')" :value="scannedQty(item)" />
    <DetailRow :label="$t('picking.itemsSection.boxedQty')" :value="item.pickedQty" />
    <DetailRow :label="$t('picking.itemsSection.requiredDateCode')" :value="item.requiredDateCode || $t('common.noData')" />
    <DetailRow :label="$t('picking.itemsSection.status')">
      <span
        class="badge"
        :class="badgeClass(item.pickedQty >= item.qty ? 'finished' : 'picking')"
      >
        {{ item.pickedQty >= item.qty ? statusLabel.picking('finished') : statusLabel.picking('picking') }}
      </span>
    </DetailRow>

    <div v-if="activeAllocations(item).length && actionable && item.pickedQty < item.qty" class="allocations">
      <h3 class="subsection-title">{{ $t('picking.itemsSection.allocations') }}</h3>
      <div
        v-for="allocation in activeAllocations(item)"
        :key="allocation.id"
        class="lot"
      >
        <template v-if="allocation.inventoryLot">
          <DetailRow :label="$t('picking.itemsSection.location')">
            <span v-if="allocation.inventoryLot.shelfCode && allocation.inventoryLot.boxId">
              {{ allocation.inventoryLot.shelfCode }} / {{ allocation.inventoryLot.boxId }}
            </span>
            <span v-else-if="allocation.inventoryLot.shelfCode">{{ allocation.inventoryLot.shelfCode }}</span>
            <span v-else-if="allocation.inventoryLot.boxId">{{ allocation.inventoryLot.boxId }}</span>
            <span v-else>{{ $t('picking.itemsSection.receivingArea') }}</span>
          </DetailRow>
          <DetailRow :label="$t('picking.itemsSection.dateLotCooCow')">
            {{ formatLotFields(allocation.inventoryLot) }}
          </DetailRow>
          <DetailRow :label="$t('picking.itemsSection.allocatedQty')" :value="allocation.qty" />
          <div class="allocation-actions">
            <button class="btn btn--small" :disabled="scanning" @click="emit('scan', allocation)">
              <template v-if="scanning">
                <InlineSpinner /> {{ $t('picking.itemsSection.scan') }}
              </template>
              <template v-else>
                {{ $t('picking.itemsSection.scan') }}
              </template>
            </button>
          </div>
        </template>

        <template v-else-if="allocation.receivingInvoiceItem">
          <DetailRow :label="$t('picking.itemsSection.source')">
            {{ $t('picking.itemsSection.receivingArea') }}
            <span v-if="allocation.receivingInvoiceItem.invoice?.receivingOrder?.refNo">
              ({{ allocation.receivingInvoiceItem.invoice.receivingOrder.refNo }})
            </span>
          </DetailRow>
          <DetailRow :label="$t('picking.itemsSection.allocatedQty')" :value="allocation.qty" />
          <div class="allocation-actions">
            <button class="btn btn--small" :disabled="scanning" @click="emit('scan', allocation)">
              <template v-if="scanning">
                <InlineSpinner /> {{ $t('picking.itemsSection.scan') }}
              </template>
              <template v-else>
                {{ $t('picking.itemsSection.scan') }}
              </template>
            </button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="unboxedPackages(item).length && actionable" class="unboxed-packages">
      <h3 class="subsection-title">{{ $t('picking.itemsSection.unboxedPackages') }}</h3>
      <div
        v-for="pkg in unboxedPackages(item)"
        :key="pkg.id"
        class="lot package-row"
      >
        <span class="package-info">
          {{ pkg.qty }} {{ $t('common.pcs') }} · {{ formatLotFields(pkg) }}
        </span>
        <div class="package-actions">
          <select :value="boxSelections[pkg.id]" :disabled="adding[pkg.id]" class="box-select" @change="updateBoxSelection(pkg.id, ($event.target as HTMLSelectElement).value)">
            <option value="">{{ $t('picking.itemsSection.selectBox') }}</option>
            <option v-for="box in openBoxes" :key="box.id" :value="box.id">{{ box.id }}</option>
          </select>
          <button
            class="btn btn--small"
            :disabled="adding[pkg.id] || !boxSelections[pkg.id]"
            @click="emit('add-to-box', pkg.id)"
          >
            <template v-if="adding[pkg.id]">
              <InlineSpinner /> {{ $t('picking.itemsSection.adding') }}
            </template>
            <template v-else>
              {{ $t('picking.itemsSection.addToBox') }}
            </template>
          </button>
        </div>
      </div>
    </div>

    <div v-if="boxedPackages(item).length && actionable" class="boxed-packages">
      <h3 class="boxed-title">{{ $t('picking.itemsSection.boxedPackages') }}</h3>
      <div
        v-for="pkg in boxedPackages(item)"
        :key="pkg.id"
        class="lot package-row"
      >
        <span class="package-info">
          {{ pkg.qty }} {{ $t('common.pcs') }} · {{ pkg.shippingBoxId }}
        </span>
        <button
          v-if="openBoxById[pkg.shippingBoxId!]?.status === 'open'"
          class="btn btn--small"
          :disabled="removing[pkg.id]"
          @click="emit('remove-from-box', pkg.id)"
        >
          <template v-if="removing[pkg.id]">
            <InlineSpinner /> {{ $t('picking.itemsSection.removing') }}
          </template>
          <template v-else>
            {{ $t('picking.itemsSection.remove') }}
          </template>
        </button>
      </div>
    </div>

    <div class="logs-toggle">
      <button class="btn btn--small btn--ghost" @click="toggleExpand(item.id)">
        {{ expandedItems.has(item.id) ? $t('picking.itemsSection.hideLogs') : $t('picking.itemsSection.showLogs') }}
        ({{ (transitionLogs[item.id] || []).length }})
      </button>

      <div v-if="expandedItems.has(item.id)" class="logs-list">
        <p v-if="!(transitionLogs[item.id] || []).length" class="card__meta">{{ $t('picking.itemsSection.noLogs') }}</p>
        <ul v-else>
          <li v-for="log in transitionLogs[item.id]" :key="log.id">
            {{ new Date(log.createdAt).toLocaleString() }}
            · {{ log.actorName || $t('picking.itemsSection.actorSystem') }}
            · {{ logStateLabel(log.fromState) }} → {{ logStateLabel(log.toState) }}
            <span v-if="log.metadata">
              · {{ logMetadataText(log.metadata) }}
            </span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PickingOrderDetail, PickingItemTransitionLog } from "~/services/types";
import { badgeClass } from "~/composables/useStatusBadge";
import { logMetadataText } from "~/utils/log";

type PickingItem = PickingOrderDetail["items"][number];
type Allocation = PickingItem["allocations"][number];
type Package = PickingItem["packages"][number];
type ShippingBox = PickingOrderDetail["shippingBoxes"][number];

const props = defineProps<{
  items: PickingOrderDetail["items"];
  actionable: boolean;
  transitionLogs: Record<string, PickingItemTransitionLog[]>;
  expandedItems: Set<string>;
  boxSelections: Record<string, string>;
  adding: Record<string, boolean>;
  removing: Record<string, boolean>;
  scanning: boolean;
  openBoxes: PickingOrderDetail["shippingBoxes"];
}>();

const emit = defineEmits<{
  "update:expandedItems": [value: Set<string>];
  "update:boxSelections": [value: Record<string, string>];
  scan: [allocation: Allocation];
  "add-to-box": [packageId: string];
  "remove-from-box": [packageId: string];
}>();

const { t } = useI18n();
const statusLabel = useStatusLabel();
const logStateLabel = (code: string | null | undefined) =>
  code ? t(`logStates.${code}`) : t("common.stateNone");

const openBoxById = computed(() => {
  const map: Record<string, ShippingBox> = {};
  for (const box of props.openBoxes) {
    map[box.id] = box;
  }
  return map;
});

function scannedQty(item: PickingItem) {
  return (item.packages ?? []).reduce((sum, p) => sum + p.qty, 0);
}

function activeAllocations(item: PickingItem) {
  return (item.allocations ?? []).filter((a) => a.qty > 0);
}

function unboxedPackages(item: PickingItem) {
  return (item.packages ?? []).filter((p) => !p.shippingBoxId);
}

function boxedPackages(item: PickingItem) {
  return (item.packages ?? []).filter((p) => p.shippingBoxId);
}

function toggleExpand(itemId: string) {
  const next = new Set(props.expandedItems);
  if (next.has(itemId)) next.delete(itemId);
  else next.add(itemId);
  emit("update:expandedItems", next);
}

function updateBoxSelection(packageId: string, value: string) {
  emit("update:boxSelections", { ...props.boxSelections, [packageId]: value });
}

function formatLotFields(source: { dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null }): string {
  return `${source.dateCode || t('common.noData')} / ${source.lotCode || t('common.noData')} / ${source.coo || t('common.noData')} / ${source.cow || t('common.noData')}`;
}

</script>

<style scoped>
.allocations,
.unboxed-packages,
.boxed-packages,
.logs-toggle {
  margin-top: 0.75rem;
}

.package-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
}

.package-info {
  font-size: 0.875rem;
}

.package-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}

.allocation-actions {
  margin-top: 0.5rem;
}

.boxed-title {
  margin: 0 0 0.5rem;
  font-size: 0.875rem;
  color: var(--muted);
}

.logs-list {
  margin-top: 0.5rem;
}

.logs-list ul {
  margin: 0;
  padding-left: 1.25rem;
  font-size: 0.875rem;
  color: var(--muted);
}

.logs-list li {
  margin-bottom: 0.35rem;
}

.item-card {
  margin-bottom: 1.5rem;
}

.box-select {
  min-width: 8rem;
}
</style>
