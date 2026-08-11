<template>
  <div class="lots-panel">
    <h2 class="section-title">{{ $t('putAway.lotsPanel.title') }}</h2>
    <p v-if="items.length === 0" class="empty">{{ $t('common.noLots') }}</p>

    <div
      v-for="item in items"
      :key="item.id"
      :data-item-id="item.id"
      class="card"
    >
      <DetailRow :label="$t('putAway.lotsPanel.part')">
        <span class="card__title">{{ item.partNo || $t('common.noData') }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.dateLot')">
        <span>{{ item.dateCode || $t('common.noData') }} / {{ item.lotCode || $t('common.noData') }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.cooCow')">
        <span>{{ item.coo || $t('common.noData') }} / {{ item.cow || $t('common.noData') }}</span>
      </DetailRow>
      <DetailRow :label="$t('putAway.lotsPanel.totalQty') +' / '+ $t('putAway.lotsPanel.scannedQty')  +' / '+ $t('putAway.lotsPanel.boxedQty')">
        <span>{{ item.lineQty }}</span> / <span>{{ scannedQty(item) || 0 }}</span> / <span>{{ item.putAwayQty }}</span>
      </DetailRow>
      <DetailRow v-if="item.suggestedShelfCode" :label="$t('putAway.lotsPanel.suggestedShelf')">
        <span class="shelf-hint">→ {{ item.suggestedShelfCode }}</span>
      </DetailRow>

      <div class="lot-actions">
        <button
          class="btn btn--small"
          :disabled="scanning"
          @click="emit('scan', item)"
        >
          {{ $t('putAway.lotsPanel.scan') }}
        </button>
        <button
          class="btn btn--small btn--ghost"
          @click="toggleExpand(item.id)"
        >
          {{ expandedItems.has(item.id) ? $t('putAway.lotsPanel.collapseScans') : $t('putAway.lotsPanel.expandScans') }}
        </button>
      </div>

      <div v-if="expandedItems.has(item.id)" class="scans-list">
        <p v-if="!scansByItem[item.id]?.length" class="empty">
          {{ $t('putAway.lotsPanel.noScans') }}
        </p>
        <div
          v-for="scan in scansByItem[item.id]"
          :key="scan.id"
          class="scan-row"
        >
          <div class="scan-info">
            <span>{{ scan.qty }} {{ $t('common.pcs') }}</span>
            <span class="scan-meta">
              {{ scan.dateCode || $t('common.stateNone') }} / {{ scan.lotCode || $t('common.stateNone') }} / {{ scan.coo || $t('common.stateNone') }} / {{ scan.cow || $t('common.stateNone') }}
            </span>
            <span class="scan-box scan-box--unboxed">{{ $t('common.unboxed') }}</span>
          </div>
          <div class="scan-actions">
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
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import InlineSpinner from "~/components/InlineSpinner.vue";
import type { PutAwayExpectedItem, PutAwayScan, PutAwayBox } from "~/services/types";

interface Props {
  items: PutAwayExpectedItem[];
  stagedQtyByItem: Record<string, number>;
  scans: PutAwayScan[];
  boxes: PutAwayBox[];
  scanning: boolean;
  addingScan: Record<string, boolean>;
  removingScan: Record<string, boolean>;
  boxSelections: Record<string, string>;
  expandedItems: Set<string>;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  scan: [item: PutAwayExpectedItem];
  "add-to-box": [scanId: string];
  "remove-scan": [scanId: string];
  "update:boxSelections": [value: Record<string, string>];
  "update:expandedItems": [value: Set<string>];
}>();

const openBoxes = computed(() => props.boxes.filter((b) => b.status === "open"));

const scansByItem = computed(() => {
  const map: Record<string, PutAwayScan[]> = {};
  for (const scan of props.scans) {
    if (!scan.receivingInvoiceItemId) continue;
    if (!map[scan.receivingInvoiceItemId]) map[scan.receivingInvoiceItemId] = [];
    map[scan.receivingInvoiceItemId].push(scan);
  }
  return map;
});

// Total scanned for the item = already boxed (putAwayQty) + still staged.
function scannedQty(item: PutAwayExpectedItem): number {
  return item.putAwayQty + (props.stagedQtyByItem[item.id] ?? 0);
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

.shelf-hint {
  font-weight: 600;
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
