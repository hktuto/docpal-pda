<template>
  <h2 class="section-title">Invoices & Items</h2>
  <div v-for="invoice in order.invoices" :key="invoice.id" style="margin-bottom: 1.5rem;">
    <h3 style="margin-bottom: 0.5rem; color: var(--muted);">
      Invoice {{ invoice.invoiceNo }}
    </h3>

    <div
      v-for="item in invoice.items"
      :key="item.id"
      class="card"
      :class="{ 'card--mismatch': item.reportedMismatch }"
    >
      <DetailRow label="Part">
        <span class="card__title">{{ item.part?.partNo }}</span>
      </DetailRow>
      <DetailRow label="PO / Line" :value="`${item.poNo} / ${item.poLine}`" />
      <DetailRow label="Expected" :value="item.qty" />
      <DetailRow label="Reserved" :value="allocatedByItem[item.id] || 0" />
      <DetailRow label="Picked" :value="item.pickedQty" />
      <DetailRow label="Put away" :value="item.putAwayQty" />
      <DetailRow
        label="Available"
        :value="item.receivedQty - item.pickedQty - item.putAwayQty - (allocatedByItem[item.id] || 0)"
      />
      <DetailRow
        label="Date / Lot / COO / COW"
        :value="`${item.dateCode} / ${item.lotCode} / ${item.coo} / ${item.cow}`"
      />

      <div v-if="order.status === 'pending' || order.status === 'in_hand'" style="margin-top: 0.75rem;">
        <template v-if="item.pickedQty > 0 || item.putAwayQty > 0">
          <p class="mismatch-locked">Locked: stock already in use.</p>
        </template>

        <template v-else-if="item.reportedMismatch">
          <div class="mismatch-summary">
            <span class="mismatch-badge">{{ formatMismatchSummary(item) }}</span>
            <span v-if="item.mismatchNote" class="mismatch-note">{{ item.mismatchNote }}</span>
            <button class="btn btn--small btn--danger" :disabled="saving[item.id]" @click="emit('report-issue', item)">Edit issue</button>
          </div>
        </template>

        <template v-else>
          <button class="btn btn--small btn--danger" :disabled="saving[item.id]" @click="emit('report-issue', item)">Report issue</button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { DisplayReceivingItem, DisplayReceivingOrder } from "./types";

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
      return "Not found";
    case "damaged":
      return `Damaged: ${item.mismatchQty} of ${item.qty}`;
    case "quality_rejection":
      return `Quality rejection: ${item.mismatchQty} of ${item.qty}`;
    case "qty_mismatch":
      return `Quantity mismatch: received ${item.mismatchQty} of ${item.qty}`;
    case "over_shipment":
      return `Over shipment: +${item.mismatchQty}`;
    case "wrong_part":
      return `Wrong part: ${item.wrongPartNo} × ${item.mismatchQty}`;
    default:
      return "Mismatch reported";
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
