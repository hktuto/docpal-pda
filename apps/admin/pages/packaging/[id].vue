<script setup lang="ts">
// Packaging detail (打包): the admin twin of the PDA form — two confirm
// input modes (spec 2026-11-16-packaging-box-cart-modes-design.md): 按箱
// (打包記錄 box count + total weight, auto scan count as reference) and 按卡
// 板 (one row per cart, each box count + weight). Packaged orders read back
// the recorded numbers instead of the form.
import type { ConfirmPackagingPayload, PackagingOrderDetail } from "~/utils/flowApi";

const route = useRoute();
const orderId = route.params.id as string;
const flow = useFlowApi();
const { t } = useI18n();

const detail = ref<PackagingOrderDetail | null>(null);
const loading = ref(true);
const error = ref("");
const confirming = ref(false);
const mode = ref<"box" | "pallet">("box");
const weightText = ref("");
const boxCountText = ref("");

interface CartDraft {
  boxCountText: string | number;
  weightText: string | number;
}
const carts = ref<CartDraft[]>([{ boxCountText: "", weightText: "" }]);

function addCart() {
  carts.value.push({ boxCountText: "", weightText: "" });
}
function removeCart(i: number) {
  carts.value.splice(i, 1);
}
const num = (v: string | number): number => {
  // <input type="number"> v-model yields a number when filled, "" when empty.
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  const s = v.trim();
  return s === "" ? NaN : Number(s);
};
const cartTotalBoxes = computed(() =>
  carts.value.reduce((s, c) => s + (Number.isFinite(num(c.boxCountText)) ? num(c.boxCountText) : 0), 0)
);
const cartTotalWeight = computed(() =>
  Math.round(carts.value.reduce((s, c) => s + (Number.isFinite(num(c.weightText)) ? num(c.weightText) : 0), 0) * 1000) / 1000
);

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
  let payload: ConfirmPackagingPayload;
  if (mode.value === "box") {
    const boxCount = num(boxCountText.value);
    const weight = num(weightText.value);
    if (!Number.isInteger(boxCount) || boxCount < 1) {
      error.value = t("admin.pages.packaging.boxCountRequired");
      return;
    }
    if (!Number.isFinite(weight) || weight <= 0) {
      error.value = t("admin.pages.packaging.weightRequired");
      return;
    }
    payload = { mode: "box", weight, boxCount };
  } else {
    const pallets = carts.value.map((c) => ({ boxCount: num(c.boxCountText), weight: num(c.weightText) }));
    if (pallets.some((p) => !Number.isInteger(p.boxCount) || p.boxCount < 1 || !Number.isFinite(p.weight) || p.weight <= 0)) {
      error.value = t("admin.pages.packaging.cartRowsRequired");
      return;
    }
    payload = { mode: "pallet", pallets };
  }
  if (!window.confirm(t("admin.pages.packaging.confirmQuestion", { orderNo: d.orderNo }))) return;
  confirming.value = true;
  error.value = "";
  try {
    await flow.confirmPackagingOrder(orderId, payload);
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
            <td>{{ b.id }}</td>
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
          <div><div class="dt">{{ $t("admin.pages.packaging.inputBoxCount") }}</div><div class="dd">{{ detail.packedInputBoxCount ?? "—" }}</div></div>
          <div><div class="dt">{{ $t("admin.pages.packaging.autoBoxCount") }}</div><div class="dd">{{ detail.packedBoxCount }}</div></div>
          <div v-if="detail.packedPalletCount !== null"><div class="dt">{{ $t("admin.pages.packaging.palletCount") }}</div><div class="dd">{{ detail.packedPalletCount }}</div></div>
          <div><div class="dt">{{ $t("admin.pages.packaging.packagedAt") }}</div><div class="dd">{{ formatDateTime(detail.packagedAt) }}</div></div>
          <div><div class="dt">{{ $t("admin.pages.packaging.packagedBy") }}</div><div class="dd">{{ detail.packagedBy ?? "—" }}</div></div>
        </div>
        <table v-if="detail.packedCarts && detail.packedCarts.length" class="data carts-table">
          <thead>
            <tr>
              <th>{{ $t("admin.pages.packaging.cartNo") }}</th>
              <th>{{ $t("admin.pages.packaging.cartBoxCount") }}</th>
              <th>{{ $t("admin.pages.packaging.cartWeight") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(cart, i) in detail.packedCarts" :key="i">
              <td>{{ $t("admin.pages.packaging.cartNoValue", { no: i + 1 }) }}</td>
              <td>{{ cart.boxCount }}</td>
              <td>{{ cart.weight }} kg</td>
            </tr>
          </tbody>
        </table>
      </template>

      <!-- Pending: the two-mode confirm form. -->
      <template v-else>
        <h2 class="section-title">{{ $t("admin.pages.packaging.formTitle") }}</h2>
        <div class="form-row">
          <div class="mode-toggle">
            <button type="button" class="btn" :class="{ selected: mode === 'box' }" @click="mode = 'box'">
              {{ $t("admin.pages.packaging.modeByBox") }}
            </button>
            <button type="button" class="btn" :class="{ selected: mode === 'pallet' }" @click="mode = 'pallet'">
              {{ $t("admin.pages.packaging.modeByCart") }}
            </button>
          </div>
        </div>

        <!-- 按箱: 打包記錄 box count + total weight. -->
        <div v-if="mode === 'box'" class="form-row">
          <p class="mode-hint">{{ $t("admin.pages.packaging.scannedHint", { count: detail.boxCount }) }}</p>
          <label>
            <span>{{ $t("admin.pages.packaging.inputBoxCount") }}</span>
            <input v-model="boxCountText" type="number" min="1" step="1" />
          </label>
          <label>
            <span>{{ $t("admin.pages.packaging.weight") }}</span>
            <input v-model="weightText" type="number" min="0" step="0.001" />
          </label>
        </div>

        <!-- 按卡板: one row per cart (auto-numbered), each box count + weight. -->
        <template v-else>
          <div v-for="(cart, i) in carts" :key="i" class="cart-edit">
            <div class="cart-edit__head">
              <span class="cart-edit__label">{{ $t("admin.pages.packaging.cartNoValue", { no: i + 1 }) }}</span>
              <button v-if="carts.length > 1" type="button" class="btn cart-edit__remove" @click="removeCart(i)">✕</button>
            </div>
            <div class="cart-edit__fields">
              <label>
                <span>{{ $t("admin.pages.packaging.cartBoxCount") }}</span>
                <input v-model="cart.boxCountText" type="number" min="1" step="1" />
              </label>
              <label>
                <span>{{ $t("admin.pages.packaging.cartWeight") }}</span>
                <input v-model="cart.weightText" type="number" min="0" step="0.001" />
              </label>
            </div>
          </div>
          <button type="button" class="btn cart-add" @click="addCart">{{ $t("admin.pages.packaging.addCart") }}</button>
          <p class="mode-hint">{{ $t("admin.pages.packaging.cartTotals", { carts: carts.length, boxes: cartTotalBoxes, weight: cartTotalWeight }) }}</p>
        </template>

        <button class="btn btn-primary" :disabled="confirming" @click="confirmPackaging">
          {{ confirming ? $t("admin.pages.packaging.confirming") : $t("admin.pages.packaging.confirm") }}
        </button>
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
.mode-hint {
  width: 100%;
  margin: 0;
  font-size: 0.8125rem;
  color: #52606d;
}
.carts-table {
  max-width: 28rem;
  margin-top: 0.75rem;
}
.cart-edit {
  width: 100%;
  max-width: 26rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  padding: 0.5rem 0.625rem;
  margin-bottom: 0.5rem;
}
.cart-edit__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.375rem;
}
.cart-edit__label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: #52606d;
}
.cart-edit__remove {
  padding: 0.2rem 0.6rem;
  font-size: 0.8125rem;
}
.cart-edit__fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}
.cart-edit__fields label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.8125rem;
  color: #52606d;
}
.cart-edit__fields input {
  padding: 0.4375rem 0.5625rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  font-size: 0.875rem;
  width: 100%;
}
.cart-add {
  margin-bottom: 0.5rem;
}
</style>
