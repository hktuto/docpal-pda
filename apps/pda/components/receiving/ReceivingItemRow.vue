<template>
  <AppListRow
    expandable
    :expanded="expanded"
    :danger="Boolean(item.mismatch)"
    :title="rowTitle"
    :meta="rowMeta"
    :chip-text="locked ? $t('common.locked') : undefined"
    chip-class="badge--danger"
    @toggle="expanded = !expanded"
  >
    <DetailRow
      v-for="field in detailConfig.expandedFields"
      :key="field"
      :label="$t(`viewConfig.fields.${field}`)"
      :value="receivingItemFieldValue(field, item)"
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
import {
  IDENTITY_DETAIL_FIELDS,
  receivingItemFieldValue,
} from "~/utils/viewConfig";

// One receiving item row (single-column AppListRow, expandable to the full
// detail + mismatch actions). The collapsed meta line and the expanded field
// rows are driven by pdaViewConfig.receivingDetail (spec 2026-10-04) —
// config order/presence controls display; the expanded state is row-local.
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
const { viewConfig } = useViewConfig();

const expanded = ref(false);

const detailConfig = computed(() => viewConfig.value.receivingDetail);

// The identity field (wcl_item_no preferred, else part_no) is the title; the
// remaining item fields form the collapsed meta line.
const rowTitle = computed(() => {
  const fields = detailConfig.value.itemFields;
  if (fields.includes("part_no") && !fields.includes("wcl_item_no")) return props.item.partNo;
  return props.item.wclItemNo ?? props.item.partNo;
});

const rowMeta = computed(() => {
  const line = detailConfig.value.itemFields
    .filter((f) => !IDENTITY_DETAIL_FIELDS.has(f))
    .map((f) => `${t(`viewConfig.fields.${f}`)}: ${receivingItemFieldValue(f, props.item)}`)
    .join(" · ");
  return line ? [line] : [];
});

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
