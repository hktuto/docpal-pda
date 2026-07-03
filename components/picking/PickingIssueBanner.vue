<template>
  <div class="card card--danger issue-banner">
    <DetailRow label="Issue reason" :value="issueReasonLabel(order.issueReason)" />
    <DetailRow v-if="order.issueQty != null" label="Actual qty available" :value="order.issueQty" />
    <DetailRow v-if="order.issuePackSize != null" label="Pack size" :value="order.issuePackSize" />
    <DetailRow v-if="order.issueRemark" label="Remark" :value="order.issueRemark" />
    <DetailRow v-if="order.issueNote" label="Note" :value="order.issueNote" />
    <DetailRow label="Reported">
      {{ order.issueReportedAt ? new Date(order.issueReportedAt).toLocaleString() : "—" }}
      by {{ order.issueReportedByUser?.displayName || order.issueReportedBy || "—" }}
    </DetailRow>
  </div>
</template>

<script setup lang="ts">
import { type PickingIssueReason } from "~/db/schema";
import { type PickingOrderDetail } from "~/db/picking";

defineProps<{
  order: PickingOrderDetail;
}>();

function issueReasonLabel(reason: PickingIssueReason | null) {
  if (reason === "insufficient_stock") return "Insufficient stock";
  if (reason === "cannot_divide") return "Cannot divide quantity";
  if (reason === "merge") return "Merge orders";
  if (reason === "other") return "Other";
  return "—";
}
</script>

<style scoped>
.issue-banner {
  margin-bottom: 1.5rem;
}
</style>
