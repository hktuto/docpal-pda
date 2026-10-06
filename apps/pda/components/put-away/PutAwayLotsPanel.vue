<template>
  <div class="lots-panel">
    <h2 class="section-title">{{ $t('putAway.lotsPanel.title') }}</h2>
    <p v-if="groups.length === 0" class="empty">{{ $t('common.noLots') }}</p>

    <div
      v-for="group in groups"
      :key="group.key"
      :data-item-id="group.key"
      class="card"
      :class="{ 'card--armed': armedItemId === group.key }"
    >
      <div v-if="armedItemId === group.key" class="armed-banner">
        <span class="armed-badge">{{ $t('putAway.lotsPanel.armedBadge') }}</span>
        <span class="armed-hint">{{ $t('putAway.lotsPanel.armedHint') }}</span>
      </div>
      <DetailRow :label="$t('putAway.lotsPanel.part')">
        <span class="card__title">{{ (group.wclItemNo ?? group.partNo) || $t('common.noData') }}</span>
      </DetailRow>
      <DetailRow
        v-for="field in visibleItemFields"
        :key="field"
        :label="$t(`viewConfig.fields.${field}`)"
        :value="putAwayGroupFieldValue(field, group)"
      />
      <DetailRow :label="$t('putAway.lotsPanel.totalQty') +' / '+ $t('putAway.lotsPanel.scannedQty')  +' / '+ $t('putAway.lotsPanel.boxedQty')">
        <span>{{ group.lineQty ?? '—' }}</span> / <span>{{ group.putAwayQty + group.stagedQty }}</span> / <span>{{ group.putAwayQty }}</span>
      </DetailRow>
      <template v-if="expandedItems.has(group.key)">
        <DetailRow
          v-for="field in detailConfig.expandedFields"
          :key="field"
          :label="$t(`viewConfig.fields.${field}`)"
          :value="putAwayGroupFieldValue(field, group)"
        />
      </template>

      <div class="lot-actions">
        <button
          class="btn btn--small"
          :disabled="scanning"
          @click="emit('scan', group)"
        >
          {{ $t('putAway.lotsPanel.scan') }}
        </button>
        <button
          class="btn btn--small"
          :class="armedItemId === group.key ? '' : 'btn--ghost'"
          :disabled="scanning"
          @click="emit('arm-scan', group)"
        >
          {{ armedItemId === group.key ? $t('putAway.lotsPanel.gunScanDisarm') : $t('putAway.lotsPanel.gunScan') }}
        </button>
        <button
          class="btn btn--small btn--ghost"
          @click="toggleExpand(group.key)"
        >
          {{ expandedItems.has(group.key) ? $t('putAway.lotsPanel.collapseScans') : $t('putAway.lotsPanel.expandScans') }}
        </button>
      </div>

      <div v-if="expandedItems.has(group.key)" class="scans-list">
        <template v-for="line in group.items" :key="line.id">
          <div v-if="group.items.length > 1" class="member-line">
            <span class="member-line__part">{{ line.partNo }}</span>
            <span>{{ $t('viewConfig.fields.remaining_qty') }}: {{ line.remainingQty }}</span>
            <span class="member-line__batch">
              {{ putAwayItemFieldValue('date_code', line) }} / {{ putAwayItemFieldValue('lot_code', line) }} / {{ putAwayItemFieldValue('coo', line) }} / {{ putAwayItemFieldValue('cow', line) }}
            </span>
          </div>
          <p v-if="!scansByItem[line.id]?.length" class="empty">
            {{ $t('putAway.lotsPanel.noScans') }}
          </p>
          <div
            v-for="scan in scansByItem[line.id]"
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
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import InlineSpinner from "~/components/InlineSpinner.vue";
import type { PutAwayScan, PutAwayBox } from "~/services/types";
import {
  IDENTITY_DETAIL_FIELDS,
  putAwayItemFieldValue,
} from "~/utils/viewConfig";
import {
  putAwayGroupFieldValue,
  type PutAwayItemGroup,
} from "~/utils/putAwayGroups";

interface Props {
  groups: PutAwayItemGroup[];
  scans: PutAwayScan[];
  boxes: PutAwayBox[];
  scanning: boolean;
  addingScan: Record<string, boolean>;
  removingScan: Record<string, boolean>;
  boxSelections: Record<string, string>;
  expandedItems: Set<string>;
  armedItemId: string | null;
}

const props = defineProps<Props>();

// Card body rows + expanded-only rows are driven by pdaViewConfig.putAwayDetail
// (spec 2026-10-04): itemFields render in the card body (identity fields stay
// in the title row), expandedFields appear when the item is expanded. Cards
// are part GROUPS (spec 2026-10-05): qty fields sum, batch fields join.
const { viewConfig } = useViewConfig();
const detailConfig = computed(() => viewConfig.value.putAwayDetail);
const visibleItemFields = computed(() =>
  detailConfig.value.itemFields.filter((f) => !IDENTITY_DETAIL_FIELDS.has(f))
);

const emit = defineEmits<{
  scan: [group: PutAwayItemGroup];
  "arm-scan": [group: PutAwayItemGroup];
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

function updateBoxSelection(scanId: string, value: string) {
  emit("update:boxSelections", { ...props.boxSelections, [scanId]: value });
}

function toggleExpand(groupKey: string) {
  const next = new Set(props.expandedItems);
  if (next.has(groupKey)) {
    next.delete(groupKey);
  } else {
    next.add(groupKey);
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

.card--armed {
  border: 2px solid var(--primary);
}

.armed-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}

.armed-badge {
  font-size: 0.75rem;
  font-weight: 600;
  color: #fff;
  background: var(--primary);
  border-radius: 0.25rem;
  padding: 0.125rem 0.375rem;
}

.armed-hint {
  font-size: 0.8rem;
  color: var(--muted);
}

.member-line {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.375rem 0;
  font-size: 0.875rem;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}

.member-line__part {
  font-weight: 600;
}

.member-line__batch {
  color: var(--muted);
  font-weight: 400;
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
