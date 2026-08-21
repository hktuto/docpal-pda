<script setup lang="ts">
import type { ShippingBoxDetail } from "~/utils/flowApi";

const route = useRoute();
const boxId = route.params.id as string;
const flow = useFlowApi();
const { t } = useI18n();

const detail = ref<ShippingBoxDetail | null>(null);
const loading = ref(true);
const error = ref("");
const shipping = ref(false);

async function shipBox() {
  if (shipping.value) return;
  if (!window.confirm(t("admin.pages.shipping.shipBoxConfirm", { boxId }))) return;
  shipping.value = true;
  error.value = "";
  try {
    await flow.shipShippingBoxes([boxId]);
    navigateTo("/shipping");
  } catch (e: any) {
    error.value = e.message;
  } finally {
    shipping.value = false;
  }
}

onMounted(async () => {
  try {
    detail.value = await flow.getShippingBox(boxId);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.shipping.detailTitle", { boxId }) }}</h1>
      <div class="head-actions">
        <button
          v-if="detail && !detail.box.shippedAt"
          class="btn"
          :disabled="shipping"
          @click="shipBox"
        >
          {{ $t("admin.pages.shipping.shipBox") }}
        </button>
        <NuxtLink to="/shipping" class="btn">{{ $t("admin.common.back") }}</NuxtLink>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <template v-else-if="detail">
      <div class="detail-grid">
        <div><div class="dt">{{ $t("admin.pages.shipping.boxStatus") }}</div><div class="dd">{{ detail.box.status }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.shipping.size") }}</div><div class="dd">{{ detail.box.boxSize ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.shipping.netWeight") }}</div><div class="dd">{{ detail.box.netWeight ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.shipping.grossWeight") }}</div><div class="dd">{{ detail.box.grossWeight ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.shipping.destination") }}</div><div class="dd">{{ detail.box.destinationCountry ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.shipping.createdAt") }}</div><div class="dd">{{ new Date(detail.box.createdDate).toLocaleString() }}</div></div>
        <div v-if="detail.box.shippedAt"><div class="dt">{{ $t("admin.pages.shipping.shippedAt") }}</div><div class="dd">{{ new Date(detail.box.shippedAt).toLocaleString() }}</div></div>
        <div v-if="detail.box.shippedBy"><div class="dt">{{ $t("admin.pages.shipping.shippedBy") }}</div><div class="dd">{{ detail.box.shippedBy }}</div></div>
      </div>

      <h2 class="section-title">{{ $t("admin.pages.shipping.ordersInBox") }}</h2>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("admin.pages.shipping.orderNo") }}</th>
              <th>{{ $t("admin.pages.shipping.orderStatus") }}</th>
              <th>{{ $t("admin.pages.shipping.shipTo") }}</th>
              <th>{{ $t("admin.pages.shipping.customer") }}</th>
              <th>{{ $t("admin.pages.shipping.poNo") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in detail.orders" :key="o.id">
              <td class="clickable" @click="navigateTo(`/picking-orders/${o.id}`)">{{ o.orderNo }}</td>
              <td>{{ o.status }}</td>
              <td>{{ o.shipTo ?? "—" }}</td>
              <td>{{ o.customerCode ?? "—" }}</td>
              <td>{{ o.poNo ?? "—" }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 class="section-title">{{ $t("admin.pages.shipping.packages") }}</h2>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("admin.pages.shipping.partNo") }}</th>
              <th>{{ $t("admin.pages.shipping.qty") }}</th>
              <th>{{ $t("admin.pages.shipping.dateCode") }}</th>
              <th>{{ $t("admin.pages.shipping.lot") }}</th>
              <th>{{ $t("admin.pages.shipping.cooCow") }}</th>
              <th>{{ $t("admin.pages.shipping.verified") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in detail.packages" :key="p.id">
              <td>{{ p.wclItemNo ?? p.partNo }}</td>
              <td>{{ p.qty }}</td>
              <td>{{ p.dateCode ?? "—" }}</td>
              <td>{{ p.lotCode ?? "—" }}</td>
              <td>{{ p.coo ?? "—" }} / {{ p.cow ?? "—" }}</td>
              <td>{{ p.verified ? "✓" : "" }}</td>
            </tr>
            <tr v-if="detail.packages.length === 0">
              <td colspan="6" class="muted">{{ $t("admin.pages.shipping.emptyBox") }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 10px;
}
.section-title {
  font-size: 15px;
  margin: 18px 0 8px;
  color: #52606d;
}
.clickable {
  cursor: pointer;
  color: #0b5cab;
}
</style>
