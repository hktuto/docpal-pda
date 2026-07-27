<script setup lang="ts">
import type { MeasuringTaskDetail } from "~/utils/flowApi";

const route = useRoute();
const taskId = route.params.id as string;
const flow = useFlowApi();

const detail = ref<MeasuringTaskDetail | null>(null);
const loading = ref(true);
const error = ref("");

onMounted(async () => {
  try {
    detail.value = await flow.getMeasuringTask(taskId);
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
      <h1>{{ $t("admin.pages.shipping.detailTitle", { orderNo: detail?.order.orderNo ?? "" }) }}</h1>
      <NuxtLink to="/shipping" class="btn">{{ $t("admin.common.back") }}</NuxtLink>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <template v-else-if="detail">
      <div class="detail-grid">
        <div><div class="dt">{{ $t("admin.pages.shipping.orderStatus") }}</div><div class="dd">{{ detail.order.status }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.shipping.customer") }}</div><div class="dd">{{ detail.order.customerCode ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.shipping.poNo") }}</div><div class="dd">{{ detail.order.poNo ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.shipping.shipTo") }}</div><div class="dd">{{ detail.order.shipTo ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.shipping.measuringTask") }}</div><div class="dd">{{ detail.task.status }}</div></div>
      </div>

      <template v-for="b in detail.boxes" :key="b.id">
        <h2 class="section-title">
          {{ $t("admin.pages.shipping.boxTitle", { id: b.id }) }}
          <span class="muted">
            — {{ b.status }}{{ b.boxSize ? `, ${b.boxSize}` : ""
            }}{{ b.destinationCountry ? `, ${b.destinationCountry}` : ""
            }}{{ b.grossWeight != null ? `, ${$t("admin.pages.shipping.gross", { n: b.grossWeight })}` : "" }}
          </span>
        </h2>
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
              <tr v-for="p in b.packages" :key="p.id">
                <td>{{ p.partNo }}<span v-if="p.wclItemNo" class="muted"> ({{ p.wclItemNo }})</span></td>
                <td>{{ p.qty }}</td>
                <td>{{ p.dateCode ?? "—" }}</td>
                <td>{{ p.lotCode ?? "—" }}</td>
                <td>{{ p.coo ?? "—" }} / {{ p.cow ?? "—" }}</td>
                <td>{{ p.verified ? "✓" : "" }}</td>
              </tr>
              <tr v-if="b.packages.length === 0">
                <td colspan="6" class="muted">{{ $t("admin.pages.shipping.emptyBox") }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <p v-if="detail.boxes.length === 0" class="muted">{{ $t("admin.pages.shipping.noBoxes") }}</p>
    </template>
  </div>
</template>

<style scoped>
.section-title {
  font-size: 15px;
  margin: 18px 0 8px;
  color: #52606d;
}
</style>
