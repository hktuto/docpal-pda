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

      <AppListRow
        :expandable="isExpandable(group)"
        :expanded="expandedItems.has(group.key)"
        :title="groupTitle(group)"
        :meta="[fieldsMeta(group), progressMeta(group)]"
        @toggle="toggleExpand(group.key)"
      >
        <DetailRow
          v-for="field in detailConfig.expandedFields"
          :key="field"
          :label="$t(`viewConfig.fields.${field}`)"
          :value="putAwayGroupFieldValue(field, group)"
        />
        <div v-for="line in group.items" :key="line.id" class="line-detail">
          <div v-if="group.items.length > 1" class="member-line">
            <span class="member-line__part">{{ line.partNo }}</span>
            <span>{{ $t('viewConfig.fields.remaining_qty') }}: {{ line.remainingQty }}</span>
            <span class="member-line__batch">
              {{ putAwayItemFieldValue('date_code', line) }} / {{ putAwayItemFieldValue('lot_code', line) }} / {{ putAwayItemFieldValue('coo', line) }} / {{ putAwayItemFieldValue('cow', line) }}
            </span>
          </div>
          <div v-if="!scansByItem[line.id]?.length && group.items.length === 1" class="empty">
            {{ $t('putAway.lotsPanel.noScans') }}
          </div>
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
            </div>
            <div class="scan-actions">
              <button
                class="btn btn--small"
                :disabled="!shelfCode || addingScan[scan.id] || removingScan[scan.id]"
                @click="emit('add-to-shelf', scan.id)"
              >
                <template v-if="addingScan[scan.id]">
                  <InlineSpinner /> {{ $t('putAway.pendingPanel.addingToShelf') }}
                </template>
                <template v-else>
                  {{ $t('putAway.pendingPanel.addToShelf') }}
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
      </AppListRow>

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
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppListRow from "~/components/AppListRow.vue";
import InlineSpinner from "~/components/InlineSpinner.vue";
import { IDENTITY_DETAIL_FIELDS, putAwayItemFieldValue } from "~/utils/viewConfig";
import {
  putAwayGroupFieldValue,
  putAwayGroupSuggestion,
  type PutAwayItemGroup,
} from "~/utils/putAwayGroups";
import type { PutAwayScan } from "~/services/types";

interface Props {
  groups: PutAwayItemGroup[];
  /** Pending (not yet shelved) scans — listed inside each item's expanded
   *  detail, under the matching invoice line. */
  scans: PutAwayScan[];
  /** Selected shelf: enables the per-scan "Add to shelf" action. */
  shelfCode: string | null;
  scanning: boolean;
  addingScan: Record<string, boolean>;
  removingScan: Record<string, boolean>;
  expandedItems: Set<string>;
  armedItemId: string | null;
}

const props = defineProps<Props>();

// The card follows the same pdaViewConfig-driven design as the receiving /
// picking detail rows (spec 2026-10-04): the identity field is the title,
// the collapsed meta line renders the configured itemFields ("Label: value"
// segments, empty values omitted — `suggested_shelf` renders the group
// suggestion) + a Total/Scanned/Put-away progress line, the expanded block
// renders the configured expandedFields, the member lines of multi-line
// part groups, and the group's pending scans. Cards are part GROUPS
// (spec 2026-10-05): qty fields sum, batch fields join.
const { t } = useI18n();
const { viewConfig } = useViewConfig();
const detailConfig = computed(() => viewConfig.value.putAwayDetail);

const emit = defineEmits<{
  scan: [group: PutAwayItemGroup];
  "arm-scan": [group: PutAwayItemGroup];
  "add-to-shelf": [scanId: string];
  "remove-scan": [scanId: string];
  "update:expandedItems": [value: Set<string>];
}>();

const scansByItem = computed(() => {
  const map: Record<string, PutAwayScan[]> = {};
  for (const scan of props.scans) {
    if (!scan.receivingInvoiceItemId) continue;
    if (!map[scan.receivingInvoiceItemId]) map[scan.receivingInvoiceItemId] = [];
    map[scan.receivingInvoiceItemId].push(scan);
  }
  return map;
});

function isExpandable(group: PutAwayItemGroup): boolean {
  return (
    detailConfig.value.expandedFields.length > 0 ||
    group.items.length > 1 ||
    group.stagedQty > 0
  );
}

function groupTitle(group: PutAwayItemGroup): string {
  const fields = detailConfig.value.itemFields;
  if (fields.includes("part_no") && !fields.includes("wcl_item_no")) return group.partNo;
  return (group.wclItemNo ?? group.partNo) || t("common.noData");
}

// Collapsed meta line 1: the configured item fields. suggested_shelf gets
// the dedicated group suggestion (distinct shelves, single box appended).
function fieldsMeta(group: PutAwayItemGroup): string {
  const segments: string[] = [];
  for (const field of detailConfig.value.itemFields) {
    if (IDENTITY_DETAIL_FIELDS.has(field)) continue;
    if (field === "suggested_shelf") {
      const suggestion = putAwayGroupSuggestion(group);
      if (suggestion) segments.push(`${t("viewConfig.fields.suggested_shelf")}: ${suggestion}`);
      continue;
    }
    const value = putAwayGroupFieldValue(field, group);
    if (value === "—") continue;
    segments.push(`${t(`viewConfig.fields.${field}`)}: ${value}`);
  }
  return segments.join(" · ");
}

// Collapsed meta line 2: the put-away progress triplet.
function progressMeta(group: PutAwayItemGroup): string {
  return [
    `${t("putAway.lotsPanel.totalQty")}: ${group.lineQty ?? "—"}`,
    `${t("putAway.lotsPanel.scannedQty")}: ${group.putAwayQty + group.stagedQty}`,
    `${t("putAway.lotsPanel.boxedQty")}: ${group.putAwayQty}`,
  ].join(" · ");
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

.line-detail {
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border);
}

.line-detail:first-of-type {
  margin-top: 0;
  padding-top: 0;
  border-top: none;
}

.member-line {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.375rem 0;
  font-size: 0.875rem;
  font-weight: 600;
}

.member-line__part {
  font-weight: 600;
}

.member-line__batch {
  color: var(--muted);
  font-weight: 400;
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

.scan-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}

.empty {
  margin: 0.25rem 0;
  font-size: 0.875rem;
}
</style>
