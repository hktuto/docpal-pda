<template>
  <h2 class="section-title">{{ $t('receiving.itemsTab.title') }}</h2>
  <div v-for="invoice in order.invoices" :key="invoice.id" style="margin-bottom: 1.5rem;">
    <h3 style="margin-bottom: 0.5rem; color: var(--muted);">
      {{ $t('common.invoiceTitle', { no: invoice.invoiceNo }) }}
    </h3>

    <div
      v-for="item in invoice.items"
      :key="item.id"
      class="card"
      :class="{ 'card--mismatch': item.reportedMismatch }"
    >
      <DetailRow :label="$t('receiving.itemsTab.part')">
        <span class="card__title">{{ item.part?.partNo }}</span>
      </DetailRow>
      <DetailRow :label="$t('receiving.itemsTab.poLine')" :value="`${item.poNo} / ${item.poLine}`" />
      <DetailRow :label="$t('receiving.itemsTab.expected')" :value="item.qty" />
      <DetailRow :label="$t('receiving.itemsTab.reserved')" :value="allocatedByItem[item.id] || 0" />
      <DetailRow :label="$t('receiving.itemsTab.picked')" :value="item.pickedQty" />
      <DetailRow :label="$t('receiving.itemsTab.putAway')" :value="item.putAwayQty" />
      <DetailRow
        :label="$t('receiving.itemsTab.available')"
        :value="item.receivedQty - item.pickedQty - item.putAwayQty - (allocatedByItem[item.id] || 0)"
      />
      <DetailRow
        :label="$t('receiving.itemsTab.dateLotCooCow')"
        :value="`${item.dateCode} / ${item.lotCode} / ${item.coo} / ${item.cow}`"
      />

      <div v-if="order.status === 'pending' || order.status === 'in_hand'" style="margin-top: 0.75rem;">
        <template v-if="item.pickedQty > 0 || item.putAwayQty > 0">
          <p class="mismatch-locked">{{ $t('common.locked') }}</p>
        </template>

        <template v-else-if="item.reportedMismatch">
          <div class="mismatch-summary">
            <span class="mismatch-badge">{{ formatMismatchSummary(item) }}</span>
            <span v-if="item.mismatchNote" class="mismatch-note">{{ item.mismatchNote }}</span>
            <button class="btn btn--small btn--danger" :disabled="saving[item.id]" @click="emit('report-issue', item)">{{ $t('receiving.itemsTab.editIssue') }}</button>
          </div>
        </template>

        <template v-else>
          <button class="btn btn--small btn--danger" :disabled="saving[item.id]" @click="emit('report-issue', item)">{{ $t('receiving.itemsTab.reportIssue') }}</button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { DisplayReceivingItem, DisplayReceivingOrder } from "./types";

const { t } = useI18n();

defineProps<{
  order: DisplayReceivingOrder;
  allocatedByItem: Record<string, number>;
  saving: Record<string, boolean>;
}>();

const emit = defineEmits<{
  "report-issue": [item: DisplayReceivingItem];
}>();

function formatMismatchSummary(item: DisplayReceivingItem): string {
  switch (item.mismatchReason) {
    case "not_found":
      return t("receiving.itemsTab.mismatch.not_found");
    case "damaged":
      return t("receiving.itemsTab.mismatch.damaged", { qty: item.mismatchQty ?? 0 });
    case "quality_rejection":
      return t("receiving.itemsTab.mismatch.quality_rejection", { qty: item.mismatchQty ?? 0 });
    case "qty_mismatch":
      return t("receiving.itemsTab.mismatch.qty_mismatch", { qty: item.mismatchQty ?? 0 });
    case "over_shipment":
      return t("receiving.itemsTab.mismatch.over_shipment", { qty: item.mismatchQty ?? 0 });
    case "wrong_part":
      return t("receiving.itemsTab.mismatch.wrong_part", { part: item.wrongPartNo ?? "" });
    default:
      return t("receiving.itemsTab.mismatch.reported");
  }
}
</script>

<style scoped>
.card--mismatch {
  border-left: 4px solid var(--danger);
}

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
  font-size: 0.875rem;
  color: var(--danger);
  margin: 0;
}
</style>
