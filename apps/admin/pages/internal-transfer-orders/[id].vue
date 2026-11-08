<script setup lang="ts">
import type { InternalTransferItemRow, InternalTransferOrderDetailRow } from "~/utils/flowApi";

// Detail view of one upstream-synced internal transfer order + its item
// lines. Read-only — same page family as /internal-transfer-orders.
const flow = useFlowApi();
const { t } = useI18n();
const route = useRoute();

const order = ref<InternalTransferOrderDetailRow | null>(null);
const items = ref<InternalTransferItemRow[]>([]);
const loading = ref(true);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const res = await flow.getInternalTransferOrder(String(route.params.id));
    order.value = res.order;
    items.value = res.items;
  } catch (e: any) {
    error.value = e?.message ?? String(e);
    order.value = null;
    items.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function fmtLoc(orgId: number | null, code: string | null): string {
  return orgId === null && !code ? "—" : `${orgId ?? "?"} / ${code ?? "?"}`;
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ order?.orderNo ?? $t("internalTransfer.title") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
        <NuxtLink to="/internal-transfer-orders" class="btn">{{ $t("admin.common.back") }}</NuxtLink>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <template v-else-if="order">
      <div class="detail-grid">
        <div><div class="dt">{{ $t("internalTransfer.colStatus") }}</div><div class="dd">{{ $t(`internalTransfer.status.${order.status}`) }}</div></div>
        <div><div class="dt">{{ $t("internalTransfer.colAllocation") }}</div><div class="dd">{{ $t(`status.allocation.${order.allocationStatus}`) }}</div></div>
        <div><div class="dt">{{ $t("internalTransfer.colFrom") }}</div><div class="dd">{{ fmtLoc(order.fromOrgId, order.fromSubInventoryCode) }}</div></div>
        <div><div class="dt">{{ $t("internalTransfer.colTo") }}</div><div class="dd">{{ fmtLoc(order.toOrgId, order.toSubInventoryCode) }}</div></div>
        <div><div class="dt">{{ $t("internalTransfer.colCustomer") }}</div><div class="dd">{{ order.customerName ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("internalTransfer.colCreated") }}</div><div class="dd">{{ new Date(order.createdDate).toLocaleString() }}</div></div>
        <div><div class="dt">{{ $t("internalTransfer.colRemark") }}</div><div class="dd">{{ order.remark ?? "—" }}</div></div>
      </div>

      <h2 class="section-title">{{ $t("internalTransfer.items") }}</h2>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("internalTransfer.colLine") }}</th>
              <th>{{ $t("internalTransfer.colPartNo") }}</th>
              <th>{{ $t("internalTransfer.colWclItemNo") }}</th>
              <th class="num">{{ $t("internalTransfer.colQty") }}</th>
              <th class="num">{{ $t("internalTransfer.colPickedQty") }}</th>
              <th class="num">{{ $t("internalTransfer.colAllocatedQty") }}</th>
              <th>{{ $t("internalTransfer.colItemStatus") }}</th>
              <th>{{ $t("internalTransfer.colPoNo") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in items" :key="item.id">
              <td>{{ item.lineNumber ?? "—" }}</td>
              <td>{{ item.partNo }}</td>
              <td>{{ item.wclItemNo ?? "—" }}</td>
              <td class="num">{{ item.qty }}</td>
              <td class="num">{{ item.pickedQty }}</td>
              <td class="num">{{ item.allocatedQty }}</td>
              <td>{{ item.status }}</td>
              <td>{{ item.poNo ?? "—" }}</td>
            </tr>
            <tr v-if="items.length === 0">
              <td :colspan="8" class="muted">{{ $t("internalTransfer.noneItems") }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.num {
  text-align: right;
}
</style>
