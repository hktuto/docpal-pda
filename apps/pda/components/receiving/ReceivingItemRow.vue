<template>
  <AppListRow
    expandable
    :expanded="expanded"
    :danger="Boolean(item.mismatch)"
    :title="item.wclItemNo ?? item.partNo"
    :meta="[`${$t('receiving.itemsTab.expected')}: ${item.lineQty ?? '—'} · ${item.poNo ?? '—'}/${item.poLine ?? '—'}`]"
    :chip-text="locked ? $t('common.locked') : undefined"
    chip-class="badge--danger"
    @toggle="expanded = !expanded"
  >
    <DetailRow :label="$t('receiving.itemsTab.expected')" :value="item.lineQty ?? '—'" />
    <DetailRow :label="$t('receiving.itemsTab.boxId')" :value="item.ctnNo" />
    <DetailRow :label="$t('receiving.itemsTab.poLine')" :value="`${item.poNo} / ${item.poLine}`" />
    <DetailRow :label="$t('receiving.itemsTab.reserved')" :value="item.allocatedQty" />
    <DetailRow :label="$t('receiving.itemsTab.picked')" :value="item.pickedQty" />
    <DetailRow :label="$t('receiving.itemsTab.putAway')" :value="item.putAwayQty" />
    <DetailRow
      :label="$t('receiving.itemsTab.available')"
      :value="item.receivedQty - item.pickedQty - item.putAwayQty - item.allocatedQty"
    />
    <DetailRow
      :label="$t('receiving.itemsTab.dateLotCooCow')"
      :value="`${item.dateCode} / ${item.lotCode} / ${item.coo} / ${item.cow}`"
    />

    <div v-if="orderStatus !== 'clear'" style="margin-top: 0.75rem;">
      <template v-if="locked">
        <p class="mismatch-locked">{{ $t('common.locked') }}</p>
      </template>

      <template v-else-if="item.mismatch">
        <div class="mismatch-summary">
          <span class="mismatch-badge">{{ mismatchSummary }}</span>
          <span v-if="item.mismatch.note" class="mismatch-note">{{ item.mismatch.note }}</span>

          <button class="btn btn--small" :disabled="saving[item.id]" @click="emit('report-issue', item)">
            <template v-if="saving[item.id]">
              <InlineSpinner /> {{ $t('actions.saving') }}
            </template>
            <template v-else>
              {{ $t('receiving.itemsTab.editIssue') }}
            </template>
          </button>
          <button
            class="btn btn--small"
            :disabled="saving[item.id]"
            @click="emit('confirm-mismatch', item.id)"
          >
            <template v-if="saving[item.id]">
              <InlineSpinner /> {{ $t('actions.saving') }}
            </template>
            <template v-else>
              {{ $t('receiving.itemsTab.confirmMismatch') }}
            </template>
          </button>
          <button
            class="btn btn--small btn--danger"
            :disabled="saving[item.id]"
            @click="emit('cancel-mismatch', item.id)"
          >
            <template v-if="saving[item.id]">
              <InlineSpinner /> {{ $t('actions.saving') }}
            </template>
            <template v-else>
              {{ $t('receiving.itemsTab.cancelMismatch') }}
            </template>
          </button>
        </div>
      </template>

      <template v-else>
        <button class="btn btn--small btn--danger" :disabled="saving[item.id]" @click="emit('report-issue', item)">
          <template v-if="saving[item.id]">
            <InlineSpinner /> {{ $t('actions.saving') }}
          </template>
          <template v-else>
            {{ $t('receiving.itemsTab.reportIssue') }}
          </template>
        </button>
      </template>
    </div>
  </AppListRow>
</template>

<script setup lang="ts">
import { DisplayReceivingItem } from "./types";

// One receiving item row (single-column AppListRow, expandable to the full
// detail + mismatch actions). Extracted from ReceivingItemsTab so every
// grouping mode renders the same row; the expanded state is row-local.
const props = defineProps<{
  item: DisplayReceivingItem;
  orderStatus: string;
  saving: Record<string, boolean>;
}>();

const emit = defineEmits<{
  "report-issue": [item: DisplayReceivingItem];
  "confirm-mismatch": [itemId: string];
  "cancel-mismatch": [itemId: string];
}>();

const { t } = useI18n();

const expanded = ref(false);

const locked = computed(() => props.item.pickedQty > 0 || props.item.putAwayQty > 0);

const mismatchSummary = computed(() => {
  const mismatch = props.item.mismatch;
  if (!mismatch?.reason) return "";
  switch (mismatch.reason) {
    case "not_found":
      return t("receiving.itemsTab.mismatch.not_found");
    case "damaged":
      return t("receiving.itemsTab.mismatch.damaged", { qty: mismatch.mismatchQty ?? 0 });
    case "quality_rejection":
      return t("receiving.itemsTab.mismatch.quality_rejection", { qty: mismatch.mismatchQty ?? 0 });
    case "qty_mismatch":
      return t("receiving.itemsTab.mismatch.qty_mismatch", { qty: mismatch.mismatchQty ?? 0 });
    case "over_shipment":
      return t("receiving.itemsTab.mismatch.over_shipment", { qty: mismatch.mismatchQty ?? 0 });
    case "wrong_part":
      return t("receiving.itemsTab.mismatch.wrong_part", { part: mismatch.wrongPartNo ?? "" });
    default:
      return t("receiving.itemsTab.mismatch.reported");
  }
});
</script>

<style scoped>
.mismatch-badge {
  display: inline-block;
  padding: 0.25rem 0.625rem;
  font-size: 0.75rem;
  font-weight: 600;
  border-radius: 9999px;
  background: var(--danger-soft);
  color: var(--danger);
}

.mismatch-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.mismatch-note {
  font-size: 0.875rem;
  color: var(--muted);
  flex: 1;
}

.mismatch-locked {
  font-size: 0.75rem;
  color: var(--danger);
  margin: 0;
}
</style>
