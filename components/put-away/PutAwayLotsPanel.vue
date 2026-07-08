<template>
  <div class="lots-panel">
    <h2 class="section-title">{{ $t('putAway.lotsPanel.title') }}</h2>
    <p v-if="lots.length === 0" class="empty">{{ $t('common.noLots') }}</p>

    <div
      v-for="lot in lots"
      :key="lot.receivingInvoiceItemId"
      class="card"
    >
      <DetailRow :label="$t('putAway.lotsPanel.part')">
        <span class="card__title">{{ lot.partNo || $t('common.noData') }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.dateLot')">
        <span>{{ lot.dateCode || $t('common.noData') }} / {{ lot.lotCode || $t('common.noData') }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.cooCow')">
        <span>{{ lot.coo || $t('common.noData') }} / {{ lot.cow || $t('common.noData') }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.totalQty')">
        <span>{{ lot.totalQty }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.scannedQty')">
        <span>{{ lot.scannedQty }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.boxedQty')">
        <span>{{ lot.boxedQty }}</span>
      </DetailRow>

      <div class="lot-actions">
        <button
          class="btn btn--small"
          :disabled="scanning"
          @click="emit('scan', lot)"
        >
          {{ $t('putAway.lotsPanel.scan') }}
        </button>
        <button
          class="btn btn--small btn--ghost"
          @click="toggleExpand(lot.receivingInvoiceItemId)"
        >
          {{ expandedItems.has(lot.receivingInvoiceItemId) ? $t('putAway.lotsPanel.collapseScans') : $t('putAway.lotsPanel.expandScans') }}
        </button>
      </div>

      <div v-if="expandedItems.has(lot.receivingInvoiceItemId)" class="scans-list">
        <p v-if="!scansByItem[lot.receivingInvoiceItemId]?.length" class="empty">
          {{ $t('putAway.lotsPanel.noScans') }}
        </p>
        <div
          v-for="scan in scansByItem[lot.receivingInvoiceItemId]"
          :key="scan.id"
          class="scan-row"
        >
          <div class="scan-info">
            <span>{{ scan.qty }} {{ $t('common.pcs') }}</span>
            <span class="scan-meta">
              {{ scan.dateCode || $t('common.stateNone') }} / {{ scan.lotCode || $t('common.stateNone') }} / {{ scan.coo || $t('common.stateNone') }} / {{ scan.cow || $t('common.stateNone') }}
            </span>
            <span v-if="scan.shelfBoxId" class="scan-box">
              {{ $t('common.inBox', { id: scan.shelfBoxId }) }}
            </span>
            <span v-else class="scan-box scan-box--unboxed">{{ $t('common.unboxed') }}</span>
          </div>
          <div class="scan-actions">
            <template v-if="!scan.shelfBoxId">
              <select
                :value="boxSelections[scan.id]"
                :disabled="addingScan[scan.id] || removingScan[scan.id]"
                @change="updateBoxSelection(scan.id, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">{{ $t('putAway.lotsPanel.selectBox') }}</option>
                <option v-for="box in openBoxes" :key="box.id" :value="box.id">
                  {{ box.id }} · {{ box.shelfCode || $t('common.noData') }}
                </option>
              </select>
              <button
                class="btn btn--small"
                :disabled="addingScan[scan.id] || removingScan[scan.id] || !boxSelections[scan.id]"
                @click="emit('add-to-box', scan.id)"
              >
                <template v-if="addingScan[scan.id]">
                  <InlineSpinner /> {{ $t('putAway.lotsPanel.addingToBox') }}
                </template>
                <template v-else>
                  {{ $t('putAway.lotsPanel.addToBox') }}
                </template>
              </button>
              <button
                class="btn btn--small btn--secondary"
                :disabled="addingScan[scan.id] || removingScan[scan.id]"
                @click="emit('remove-scan', scan.id)"
              >
                <template v-if="removingScan[scan.id]">
                  <InlineSpinner /> {{ $t('putAway.lotsPanel.removingScan') }}
                </template>
                <template v-else>
                  {{ $t('putAway.lotsPanel.removeScan') }}
                </template>
              </button>
            </template>
            <button
              v-else-if="boxById(scan.shelfBoxId)?.status === 'open'"
              class="btn btn--small"
              :disabled="removingScan[scan.id]"
              @click="emit('remove-from-box', scan.id)"
            >
              <template v-if="removingScan[scan.id]">
                <InlineSpinner /> {{ $t('putAway.lotsPanel.removingFromBox') }}
              </template>
              <template v-else>
                {{ $t('putAway.lotsPanel.removeFromBox') }}
              </template>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import InlineSpinner from "~/components/InlineSpinner.vue";
import type { PutAwayLot, PutAwayScan, ShelfBox } from "~/services/types";

interface Props {
  lots: PutAwayLot[];
  scans: PutAwayScan[];
  boxes: ShelfBox[];
  scanning: boolean;
  addingScan: Record<string, boolean>;
  removingScan: Record<string, boolean>;
  boxSelections: Record<string, string>;
  expandedItems: Set<string>;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  scan: [lot: PutAwayLot];
  "add-to-box": [scanId: string];
  "remove-from-box": [scanId: string];
  "remove-scan": [scanId: string];
  "update:boxSelections": [value: Record<string, string>];
  "update:expandedItems": [value: Set<string>];
}>();

const openBoxes = computed(() => props.boxes.filter((b) => b.status === "open"));

const scansByItem = computed(() => {
  const map: Record<string, PutAwayScan[]> = {};
  for (const scan of props.scans) {
    if (!map[scan.receivingInvoiceItemId]) map[scan.receivingInvoiceItemId] = [];
    map[scan.receivingInvoiceItemId].push(scan);
  }
  return map;
});

function boxById(boxId: string | null) {
  return props.boxes.find((b) => b.id === boxId);
}

function updateBoxSelection(scanId: string, value: string) {
  emit("update:boxSelections", { ...props.boxSelections, [scanId]: value });
}

function toggleExpand(itemId: string) {
  const next = new Set(props.expandedItems);
  if (next.has(itemId)) {
    next.delete(itemId);
  } else {
    next.add(itemId);
  }
  emit("update:expandedItems", next);
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
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.scans-list {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}

.scan-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border);
}

.scan-row:last-child {
  border-bottom: none;
}

.scan-info {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  font-size: 0.875rem;
  align-items: center;
}

.scan-meta {
  color: var(--muted);
}

.scan-box {
  font-size: 0.75rem;
  color: var(--muted);
}

.scan-box--unboxed {
  color: var(--warning);
}

.scan-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}

.scan-actions select {
  min-width: 8rem;
}
</style>
