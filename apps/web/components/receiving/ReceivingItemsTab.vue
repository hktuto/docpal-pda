<template>
  <h2 class="section-title">{{ $t('receiving.itemsTab.title') }}</h2>
  <div v-for="invoice in order.invoices" :key="invoice.id" style="margin-bottom: 1.5rem;">
      <div class="sticky_header">

        <h3 style="margin-bottom: 0.5rem; color: var(--muted);">
        {{ $t('common.invoiceTitle', { no: invoice.invoiceNo }) }}
        </h3>
      </div>

    <div
      v-for="item in invoice.items"
      :key="item.id"
      class="card"
    >
      <DetailRow :label="$t('receiving.itemsTab.part')">
        <span class="card__title">{{ item.partNo }}</span>
      </DetailRow>

      <DetailRow :label="$t('receiving.itemsTab.expected')" :value="item.lineQty ?? '—'" />
      <DetailRow :label="$t('receiving.itemsTab.boxId')" :value="item.ctnNo" />
      <template v-if="expanded">
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
      </template>


      <div class="toggleContainer">
        <div  @click="toggle">
            {{ expanded ? "▲" : "▼" }}
        </div>
      </div>
      <div v-if="order.status !== 'clear'" style="margin-top: 0.75rem;">
        <template v-if="item.pickedQty > 0 || item.putAwayQty > 0">
          <p class="mismatch-locked">{{ $t('common.locked') }}</p>
        </template>

        <template v-else-if="item.mismatch">
          <div class="mismatch-summary">
            <span class="mismatch-badge">{{ formatMismatchSummary(item) }}</span>
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

    </div>
  </div>
</template>

<script setup lang="ts">
import { DisplayReceivingItem, DisplayReceivingOrder } from "./types";

const { t } = useI18n();

const expanded = ref(false)

function toggle(){
  expanded.value = !expanded.value
}

defineProps<{
  order: DisplayReceivingOrder;
  saving: Record<string, boolean>;
}>();

const emit = defineEmits<{
  "report-issue": [item: DisplayReceivingItem];
  "confirm-mismatch": [itemId: string];
  "cancel-mismatch": [itemId: string];
}>();

function formatMismatchSummary(item: DisplayReceivingItem): string {
  const mismatch = item.mismatch;
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
}
</script>

<style scoped>
.sticky_header{
    position: -webkit-sticky; /* For Safari */
    position: sticky;
    top: 61px;
    z-index: 2;
    background: var(--bg);
    margin-inline: calc(1rem * -1);
    padding-inline: 1rem;
    padding-block: 0.22rem;
}
.card{
    position: relative;
}
.toggleContainer{
    position: absolute;
    top: 1rem;
    right: 1rem;
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
