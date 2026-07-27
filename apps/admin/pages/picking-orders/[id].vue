<script setup lang="ts">
import type { PickingOrderDetail } from "~/utils/flowApi";

const route = useRoute();
const orderId = route.params.id as string;
const flow = useFlowApi();
const { t } = useI18n();

const order = ref<PickingOrderDetail | null>(null);
const loading = ref(true);
const error = ref("");

const deliveryDate = ref("");
const savingDate = ref(false);
const dateMsg = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    order.value = await flow.getPickingOrder(orderId);
    deliveryDate.value = order.value.deliveryDate ? order.value.deliveryDate.slice(0, 10) : "";
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function saveDeliveryDate() {
  savingDate.value = true;
  dateMsg.value = "";
  error.value = "";
  try {
    await flow.updatePickingDeliveryDate(orderId, deliveryDate.value || null);
    await load();
    dateMsg.value = "saved";
  } catch (e: any) {
    error.value = e.message;
  } finally {
    savingDate.value = false;
  }
}

function allocationSource(a: PickingOrderDetail["items"][number]["allocations"][number]): string {
  if (a.lot)
    return t("admin.pages.pickingOrders.allocLot", {
      shelf: a.lot.shelfCode ?? "",
      box: a.lot.boxId ? ` / ${a.lot.boxId}` : "",
      dc: a.lot.dateCode ?? "—",
    });
  if (a.receivingInvoiceItemId) return t("admin.pages.pickingOrders.allocReceivingBox", { box: a.boxId ?? "" });
  if (a.receivingOrderId) return t("admin.pages.pickingOrders.allocReceivingOrder");
  return "—";
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.pickingOrders.detailTitle", { orderNo: order?.orderNo ?? "" }) }}</h1>
      <div class="head-actions">
        <button class="btn" disabled :title="$t('admin.common.downloadPendingTitle')">
          {{ $t("admin.pages.pickingOrders.downloadPackingList") }}
        </button>
        <button class="btn" disabled :title="$t('admin.common.downloadPendingTitle')">
          {{ $t("admin.pages.pickingOrders.downloadTN") }}
        </button>
        <NuxtLink to="/picking-orders" class="btn">{{ $t("admin.common.back") }}</NuxtLink>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <template v-else-if="order">
      <div class="detail-grid">
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.status") }}</div><div class="dd">{{ order.status }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.customer") }}</div><div class="dd">{{ order.customerCode ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.poNo") }}</div><div class="dd">{{ order.poNo ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.shipTo") }}</div><div class="dd">{{ order.shipTo ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.orgSubInventory") }}</div><div class="dd">{{ order.orgId ?? "—" }} / {{ order.subInventoryCode ?? "—" }}</div></div>
        <div>
          <div class="dt">{{ $t("admin.pages.pickingOrders.deliveryDate") }}</div>
          <div class="dd date-edit">
            <input v-model="deliveryDate" type="date" />
            <button class="btn btn-small btn-primary" :disabled="savingDate" @click="saveDeliveryDate">
              {{ savingDate ? $t("admin.common.saving") : $t("admin.common.save") }}
            </button>
            <span v-if="dateMsg" class="muted">{{ $t("admin.pages.pickingOrders.saved") }}</span>
          </div>
        </div>
        <div v-if="order.measuringTask">
          <div class="dt">{{ $t("admin.pages.pickingOrders.measuringTask") }}</div>
          <div class="dd">{{ order.measuringTask.status }}</div>
        </div>
      </div>

      <h2 class="section-title">{{ $t("admin.pages.pickingOrders.items") }}</h2>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("admin.fields.partNo") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.required") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.allocated") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.picked") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.allocations") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.packages") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in order.items" :key="item.id">
              <td>{{ item.partNo }}<span v-if="item.wclItemNo" class="muted"> ({{ item.wclItemNo }})</span></td>
              <td>{{ item.qty }}</td>
              <td>{{ item.allocatedQty }}</td>
              <td>{{ item.pickedQty }}</td>
              <td>
                <div v-for="a in item.allocations" :key="a.id">{{ a.qty }} × {{ allocationSource(a) }}</div>
                <span v-if="item.allocations.length === 0" class="muted">—</span>
              </td>
              <td>
                <div v-for="p in item.packages" :key="p.id">
                  {{ p.qty }} (dc {{ p.dateCode ?? "—"
                  }}{{ p.shippingBoxId ? `, ${$t("admin.pages.pickingOrders.boxed")}` : `, ${$t("admin.pages.pickingOrders.unboxed")}`
                  }}{{ p.verified ? `, ${$t("admin.pages.pickingOrders.verified")}` : "" }})
                </div>
                <span v-if="item.packages.length === 0" class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 class="section-title">{{ $t("admin.pages.pickingOrders.shippingBoxes") }}</h2>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("admin.pages.pickingOrders.boxId") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.status") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.size") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.netGross") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.destination") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.packages") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in order.boxes" :key="b.id">
              <td>{{ b.id }}</td>
              <td>{{ b.status }}</td>
              <td>{{ b.boxSize ?? "—" }}</td>
              <td>{{ b.netWeight ?? "—" }} / {{ b.grossWeight ?? "—" }}</td>
              <td>{{ b.destinationCountry ?? "—" }}</td>
              <td>{{ b.packageCount }}</td>
            </tr>
            <tr v-if="order.boxes.length === 0">
              <td colspan="6" class="muted">{{ $t("admin.pages.pickingOrders.noBoxes") }}</td>
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
.date-edit {
  display: flex;
  align-items: center;
  gap: 8px;
}
.date-edit input {
  padding: 5px 7px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
}
</style>
