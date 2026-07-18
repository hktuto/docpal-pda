<template>
  <div class="card card--danger issue-banner">
    <DetailRow :label="$t('picking.issueBanner.issueReason')" :value="issueReasonLabel(order.issueReason)" />
    <DetailRow v-if="order.issueQty != null" :label="$t('picking.issueBanner.actualQtyAvailable')" :value="order.issueQty" />
    <DetailRow v-if="order.issuePackSize != null" :label="$t('picking.issueBanner.packSize')" :value="order.issuePackSize" />
    <DetailRow v-if="order.issueRemark" :label="$t('picking.issueBanner.remark')" :value="order.issueRemark" />
    <DetailRow v-if="order.issueNote" :label="$t('picking.issueBanner.note')" :value="order.issueNote" />
    <DetailRow :label="$t('picking.issueBanner.reported')">
      {{ order.issueReportedAt ? new Date(order.issueReportedAt).toLocaleString() : $t('common.noData') }}
      {{ $t('common.reportedBy', { name: order.issueReportedByUser?.displayName || order.issueReportedBy || $t('common.noData') }) }}
    </DetailRow>
  </div>
</template>

<script setup lang="ts">
import type { PickingIssueReason, PickingOrderDetail } from "~/services/types";

defineProps<{
  order: PickingOrderDetail;
}>();

const { t } = useI18n();

function issueReasonLabel(reason: PickingIssueReason | null) {
  if (reason === "insufficient_stock") return t('picking.issueReasons.insufficient_stock');
  if (reason === "cannot_divide") return t('picking.issueReasons.cannot_divide');
  if (reason === "merge") return t('picking.issueReasons.merge');
  if (reason === "other") return t('picking.issueReasons.other');
  return t('common.noData');
}
</script>

<style scoped>
.issue-banner {
  margin-bottom: 1.5rem;
}
</style>
