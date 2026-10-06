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
        <div v-if="group.items.length > 1" class="member-lines">
          <div v-for="line in group.items" :key="line.id" class="member-line">
            <span class="member-line__part">{{ line.partNo }}</span>
            <span>{{ $t('viewConfig.fields.remaining_qty') }}: {{ line.remainingQty }}</span>
            <span class="member-line__batch">
              {{ putAwayItemFieldValue('date_code', line) }} / {{ putAwayItemFieldValue('lot_code', line) }} / {{ putAwayItemFieldValue('coo', line) }} / {{ putAwayItemFieldValue('cow', line) }}
            </span>
          </div>
        </div>
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
          v-if="group.items.length > 1 || detailConfig.expandedFields.length"
          class="btn btn--small btn--ghost"
          @click="toggleExpand(group.key)"
        >
          {{ expandedItems.has(group.key) ? $t('putAway.lotsPanel.collapseScans') : $t('putAway.lotsPanel.expandScans') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { IDENTITY_DETAIL_FIELDS, putAwayItemFieldValue } from "~/utils/viewConfig";
import {
  putAwayGroupFieldValue,
  type PutAwayItemGroup,
} from "~/utils/putAwayGroups";

interface Props {
  groups: PutAwayItemGroup[];
  scanning: boolean;
  expandedItems: Set<string>;
  armedItemId: string | null;
}

const props = defineProps<Props>();

// Card body rows + expanded-only rows are driven by pdaViewConfig.putAwayDetail
// (spec 2026-10-04): itemFields render in the card body (identity fields stay
// in the title row), expandedFields appear when the card is expanded. Cards
// are part GROUPS (spec 2026-10-05): qty fields sum, batch fields join.
// Pending scans live in PutAwayPendingPanel (spec 2026-10-06) — not here.
const { viewConfig } = useViewConfig();
const detailConfig = computed(() => viewConfig.value.putAwayDetail);
const visibleItemFields = computed(() =>
  detailConfig.value.itemFields.filter((f) => !IDENTITY_DETAIL_FIELDS.has(f))
);

const emit = defineEmits<{
  scan: [group: PutAwayItemGroup];
  "arm-scan": [group: PutAwayItemGroup];
  "update:expandedItems": [value: Set<string>];
}>();

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

.member-lines {
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border);
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

.member-line:last-child {
  border-bottom: none;
}

.member-line__part {
  font-weight: 600;
}

.member-line__batch {
  color: var(--muted);
  font-weight: 400;
}
</style>
