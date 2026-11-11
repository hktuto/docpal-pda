<script setup lang="ts">
// Packaging detail (打包): the admin twin of the PDA form — total weight +
// boxes (auto, server-recomputed at confirm) or pallets, one confirm.
// Packaged orders read back the recorded numbers instead of the form.
import type { PackagingOrderDetail } from "~/utils/flowApi";

const route = useRoute();
const orderId = route.params.id as string;
const flow = useFlowApi();
const { t } = useI18n();

const detail = ref<PackagingOrderDetail | null>(null);
const loading = ref(true);
const error = ref("");
const confirming = ref(false);
const weightText = ref("");
const palletText = ref("1");
const onPallets = ref(false);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    detail.value = await flow.getPackagingOrder(orderId);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const {
  pending: changePending,
  justUpdated: changeUpdated,
  refreshNow,
  dismiss,
} = useChangeNotice(["picking.packaged", "picking_order.updated"], load);

async function confirmPackaging() {
  const d = detail.value;
  if (!d || confirming.value) return;
  const weight = Number(weightText.value);
  if (!Number.isFinite(weight) || weight <= 0) {
    error.value = t("admin.pages.packaging.weightRequired");
    return;
  }
  let palletCount: number | null = null;
  if (onPallets.value) {
    palletCount = Number(palletText.value);
    if (!Number.isInteger(palletCount) || palletCount < 1) {
      error.value = t("admin.pages.packaging.palletRequired");
      return;
    }
  }
  if (!window.confirm(t("admin.pages.packaging.confirmQuestion", { orderNo: d.orderNo }))) return;
  confirming.value = true;
  error.value = "";
  try {
    await flow.confirmPackagingOrder(orderId, weight, palletCount);
    await load();
  } catch (e: any) {
    // 409 packaging_not_ready: the order left the queue (someone else
    // confirmed) — reload shows the recorded state.
    error.value = e?.message === "packaging_not_ready" ? t("admin.pages.packaging.alreadyDone") : e.message;
    await load();
  } finally {
    confirming.value = false;
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.packaging.detailTitle", { orderNo: detail?.orderNo ?? "" }) }}</h1>
      <div class="head-actions">
        <NuxtLink to="/packaging" class="btn">{{ $t("admin.common.back") }}</NuxtLink>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <ChangeNotice :pending="changePending" :just-updated="changeUpdated" @refresh="refreshNow" @dismiss="dismiss" />
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <template v-else-if="detail">
      <div class="detail-grid">
        <div><div class="dt">{{ $t("admin.pages.packaging.orderNo") }}</div><div class="dd">{{ detail.orderNo }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.packaging.customer") }}</div><div class="dd">{{ detail.customerCode ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.packaging.shipTo") }}</div><div class="dd">{{ detail.shipTo ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.packaging.poNo") }}</div><div class="dd">{{ detail.poNo ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.packaging.boxes") }}</div><div class="dd">{{ detail.boxCount }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.packaging.packages") }}</div><div class="dd">{{ detail.packageCount }}</div></div>
        <div v-if="detail.grossWeightHint !== null"><div class="dt">{{ $t("admin.pages.packaging.grossHint") }}</div><div class="dd">{{ detail.grossWeightHint }}</div></div>
        <div v-if="detail.assignee"><div class="dt">{{ $t("admin.pages.packaging.assignee") }}</div><div class="dd">{{ detail.assignee }}</div></div>
      </div>

      <h2 class="section-title">{{ $t("admin.pages.packaging.boxesTitle") }}</h2>
      <table class="data">
        <thead>
          <tr>
            <th>{{ $t("admin.pages.shipping.boxId") }}</th>
            <th>{{ $t("admin.pages.shipping.size") }}</th>
            <th>{{ $t("admin.pages.shipping.packages") }}</th>
            <th>{{ $t("admin.pages.shipping.grossWeight") }}</th>
            <th>{{ $t("admin.pages.shipping.destination") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in detail.boxes" :key="b.id">
            <td><span class="clickable" @click="navigateTo(`/shipping/${b.id}`)">{{ b.id }}</span></td>
            <td>{{ b.boxSize ?? "—" }}</td>
            <td>{{ b.packageCount }}</td>
            <td>{{ b.grossWeight ?? "—" }}</td>
            <td>{{ b.destinationCountry ?? "—" }}</td>
          </tr>
        </tbody>
      </table>

      <!-- Packaged: recorded numbers, no re-confirm. -->
      <template v-if="detail.packagedAt">
        <h2 class="section-title">{{ $t("admin.pages.packaging.packagedTitle") }}</h2>
        <div class="detail-grid">
          <div><div class="dt">{{ $t("admin.pages.packaging.weight") }}</div><div class="dd">{{ detail.packedWeight }} kg</div></div>
          <div><div class="dt">{{ $t("admin.pages.packaging.boxes") }}</div><div class="dd">{{ detail.packedBoxCount }}</div></div>
          <div v-if="detail.packedPalletCount !== null"><div class="dt">{{ $t("admin.pages.packaging.palletCount") }}</div><div class="dd">{{ detail.packedPalletCount }}</div></div>
          <div><div class="dt">{{ $t("admin.pages.packaging.packagedAt") }}</div><div class="dd">{{ formatDateTime(detail.packagedAt) }}</div></div>
          <div><div class="dt">{{ $t("admin.pages.packaging.packagedBy") }}</div><div class="dd">{{ detail.packagedBy ?? "—" }}</div></div>
        </div>
      </template>

      <!-- Pending: the confirm form. -->
      <template v-else>
        <h2 class="section-title">{{ $t("admin.pages.packaging.formTitle") }}</h2>
        <div class="form-row">
          <label>
            <span>{{ $t("admin.pages.packaging.weight") }}</span>
            <input v-model="weightText" type="number" min="0" step="0.001" />
          </label>
          <div class="mode-toggle">
            <button type="button" class="btn" :class="{ selected: !onPallets }" @click="onPallets = false">
              {{ $t("admin.pages.packaging.modeBoxes", { count: detail.boxCount }) }}
            </button>
            <button type="button" class="btn" :class="{ selected: onPallets }" @click="onPallets = true">
              {{ $t("admin.pages.packaging.modePallets") }}
            </button>
          </div>
          <label v-if="onPallets">
            <span>{{ $t("admin.pages.packaging.palletCount") }}</span>
            <input v-model="palletText" type="number" min="1" step="1" />
          </label>
          <button class="btn btn-primary" :disabled="confirming" @click="confirmPackaging">
            {{ confirming ? $t("admin.pages.packaging.confirming") : $t("admin.pages.packaging.confirm") }}
          </button>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 0.625rem;
}
.section-title {
  font-size: 0.9375rem;
  margin: 1.125rem 0 0.5rem;
  color: #52606d;
}
.clickable {
  cursor: pointer;
  color: #0b5cab;
}
.form-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem;
}
.form-row label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.8125rem;
  color: #52606d;
}
.form-row input {
  padding: 0.4375rem 0.5625rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  font-size: 0.875rem;
  width: 10rem;
}
.mode-toggle {
  display: flex;
  gap: 0.375rem;
}
.mode-toggle .btn.selected {
  border-color: #0b5cab;
  color: #0b5cab;
}
</style>
