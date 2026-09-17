<script setup lang="ts">
import type { PickingItemRow } from "~/utils/flowApi";

// Tooltip detail rows for one allocation — shared by the picking-order detail
// items table (flat + grouped view) so both show the same lot / receiving
// detail on hover. Renders nothing for receiving-sourced allocations without
// embedded receiving info (order-level dock sources).
defineProps<{ a: PickingItemRow["allocations"][number] }>();
</script>

<template>
  <template v-if="a.lot">
    <div v-if="a.lot.shelfWarning" class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.warning") }}</span>
      <span>{{ a.lot.shelfWarning }}</span>
    </div>
    <div class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.shelf") }}</span>
      <span>{{ a.lot.shelfCode ?? "—" }}</span>
    </div>
    <div class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.box") }}</span>
      <span>{{ a.lot.boxId ?? "—" }}</span>
    </div>
    <div class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.dateCode") }}</span>
      <span>{{ a.lot.dateCode ?? "—" }}</span>
    </div>
    <div class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.lotCode") }}</span>
      <span>{{ a.lot.lotCode ?? "—" }}</span>
    </div>
    <div class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.coo") }}</span>
      <span>{{ a.lot.coo ?? "—" }}</span>
    </div>
    <div class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.cow") }}</span>
      <span>{{ a.lot.cow ?? "—" }}</span>
    </div>
    <div class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.lotTotal") }}</span>
      <span>{{ a.lot.totalQty }}</span>
    </div>
    <div class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.lotAllocated") }}</span>
      <span>{{ a.lot.allocatedQty }}</span>
    </div>
    <div class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.lotAvailable") }}</span>
      <span>{{ a.lot.availableQty }}</span>
    </div>
  </template>
  <template v-else-if="a.receiving">
    <div class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.receivingOrder") }}</span>
      <NuxtLink :to="`/receiving/${a.receiving.orderId}`">{{ a.receiving.batchNo }}</NuxtLink>
    </div>
    <div v-if="a.receiving.invoiceNo" class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.invoice") }}</span>
      <span>{{ a.receiving.invoiceNo }}</span>
    </div>
    <div v-if="a.receiving.partNo" class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.partNo") }}</span>
      <span>{{ a.receiving.partNo }}</span>
    </div>
    <div v-if="a.receiving.poNo" class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.poNo") }}</span>
      <span>{{ a.receiving.poNo }}</span>
    </div>
    <div v-if="a.receiving.receivedQty != null" class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.receivedQty") }}</span>
      <span>{{ a.receiving.receivedQty }}</span>
    </div>
    <div v-if="a.receiving.dateCode" class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.dateCode") }}</span>
      <span>{{ a.receiving.dateCode }}</span>
    </div>
    <div v-if="a.boxId" class="alloc-tip-row">
      <span class="alloc-tip-label">{{ $t("admin.pages.allocationTip.ctnNo") }}</span>
      <span>{{ a.boxId }}</span>
    </div>
  </template>
</template>
