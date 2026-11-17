<template>
  <div class="packaging-detail-page">
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="order">
      <div class="card">
        <div class="order-header__title-row">
          <h2 class="order-header__title">{{ order.orderNo }}</h2>
        </div>
        <DetailRow :label="$t('picking.detail.customer')" :value="order.customerCode" />
        <DetailRow :label="$t('packaging.shipTo')" :value="order.shipTo" />
      </div>

      <!-- Box summary: the scanned box/package counts only (no per-box rows). -->
      <div class="card">
        <DetailRow :label="$t('packaging.boxes')" :value="order.boxCount" />
        <DetailRow :label="$t('packaging.packages')" :value="order.packageCount" />
      </div>

      <!-- Packaged: read back the recorded numbers (no re-confirm). -->
      <div v-if="order.packagedAt" class="card">
        <h3 class="section-title">{{ $t('packaging.packagedTitle') }}</h3>
        <DetailRow :label="$t('packaging.weight')" :value="kg(order.packedWeight)" />
        <DetailRow
          v-if="order.packedInputBoxCount !== null"
          :label="$t('packaging.inputBoxCount')"
          :value="$t('packaging.boxesValue', { count: order.packedInputBoxCount })"
        />
        <DetailRow :label="$t('packaging.autoBoxCount')" :value="$t('packaging.boxesValue', { count: order.packedBoxCount })" />
        <template v-if="order.packedCarts && order.packedCarts.length">
          <div class="cart-list">
            <div v-for="(cart, i) in order.packedCarts" :key="i" class="cart-row">
              <span class="cart-row__label">{{ $t('packaging.cartNo', { no: i + 1 }) }}</span>
              <span class="cart-row__value">
                {{ $t('packaging.boxesValue', { count: cart.boxCount }) }} · {{ kg(cart.weight) }}
              </span>
            </div>
          </div>
        </template>
      </div>

      <!-- Pending: 按箱 / 按卡板 two-mode form, one confirm. -->
      <div v-else class="card">
        <h3 class="section-title">{{ $t('packaging.formTitle') }}</h3>
        <div class="mode-row">
          <button class="btn" :class="{ 'btn-primary': mode === 'box' }" @click="mode = 'box'">
            {{ $t('packaging.modeByBox') }}
          </button>
          <button class="btn" :class="{ 'btn-primary': mode === 'pallet' }" @click="mode = 'pallet'">
            {{ $t('packaging.modeByCart') }}
          </button>
        </div>

        <!-- 按箱: 打包記錄 box count + total weight (auto scan count as reference). -->
        <template v-if="mode === 'box'">
          <p class="hint">{{ $t('packaging.scannedHint', { count: order.boxCount }) }}</p>
          <label class="field">
            <span class="field__label">{{ $t('packaging.inputBoxCount') }}</span>
            <input v-model="boxCountText" class="field__input" type="number" min="1" step="1" inputmode="numeric" />
          </label>
          <label class="field">
            <span class="field__label">{{ $t('packaging.weight') }}</span>
            <input v-model="weightText" class="field__input" type="number" min="0" step="0.001" inputmode="decimal" />
          </label>
          <p v-if="order.grossWeightHint !== null" class="hint">
            {{ $t('packaging.grossHint', { weight: order.grossWeightHint }) }}
          </p>
        </template>

        <!-- 按卡板: one row per cart (auto-numbered), each box count + weight. -->
        <template v-else>
          <div v-for="(cart, i) in carts" :key="i" class="cart-edit">
            <div class="cart-edit__head">
              <span class="cart-edit__label">{{ $t('packaging.cartNo', { no: i + 1 }) }}</span>
              <button
                v-if="carts.length > 1"
                class="btn cart-edit__remove"
                :aria-label="$t('packaging.removeCart')"
                @click="removeCart(i)"
              >✕</button>
            </div>
            <div class="cart-edit__fields">
              <label class="cart-edit__field">
                <span class="field__label">{{ $t('packaging.cartBoxCount') }}</span>
                <input v-model="cart.boxCountText" class="field__input" type="number" min="1" step="1" inputmode="numeric" />
              </label>
              <label class="cart-edit__field">
                <span class="field__label">{{ $t('packaging.cartWeight') }}</span>
                <input v-model="cart.weightText" class="field__input" type="number" min="0" step="0.001" inputmode="decimal" />
              </label>
            </div>
          </div>
          <button class="btn cart-add" @click="addCart">{{ $t('packaging.addCart') }}</button>
          <p class="hint">{{ $t('packaging.cartTotals', { carts: carts.length, boxes: cartTotalBoxes, weight: cartTotalWeight }) }}</p>
        </template>
      </div>

      <footer v-if="!order.packagedAt" class="packaging-footer">
        <button class="btn btn-primary packaging-footer__confirm" :disabled="confirming" @click="confirm">
          <template v-if="confirming"><InlineSpinner /> {{ $t('packaging.confirming') }}</template>
          <template v-else>{{ $t('packaging.confirm') }}</template>
        </button>
      </footer>
    </template>
  </div>
</template>

<script setup lang="ts">
// Packaging detail (打包, spec 2026-11-16-packaging-box-cart-modes-design.md):
// two confirm input modes — 按箱 (打包記錄 box count + total weight; the
// scanned box count is reference only and is never overridden) and 按卡板
// (one row per cart, each with its box count + weight). No scanning —
// manual figures.
import EmptyState from "~/components/EmptyState.vue";
import DetailRow from "~/components/DetailRow.vue";
import InlineSpinner from "~/components/InlineSpinner.vue";
import { isPackagingNotReady } from "~/utils/packaging";
import type { ConfirmPackagingPayload, PackagingOrderDetail } from "~/services/types";

const route = useRoute();
const orderId = route.params.orderId as string;
const { t } = useI18n();
useHead({ title: t("packaging.title") });

const warehouse = useWarehouse();
const errorMessage = useErrorMessage();
const { showToast } = useToast();

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<PackagingOrderDetail | null>(null);
const mode = ref<"box" | "pallet">("box");
const weightText = ref("");
const boxCountText = ref("");
const confirming = ref(false);

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
  pending.value = true;
  error.value = null;
  try {
    order.value = await warehouse.getPackagingOrder(orderId);
  } catch (e) {
    error.value = errorMessage(e);
    order.value = null;
  } finally {
    pending.value = false;
  }
}

const kg = (v: number | null) => (v === null ? null : t("packaging.kgValue", { weight: v }));

async function confirm() {
  if (confirming.value || !order.value) return;
  let payload: ConfirmPackagingPayload;
  if (mode.value === "box") {
    const weight = num(weightText.value);
    const boxCount = num(boxCountText.value);
    if (!Number.isFinite(boxCount) || !Number.isInteger(boxCount) || boxCount < 1) {
      showToast(t("packaging.boxCountRequired"));
      return;
    }
    if (!Number.isFinite(weight) || weight <= 0) {
      showToast(t("packaging.weightRequired"));
      return;
    }
    payload = { mode: "box", weight, boxCount };
  } else {
    const pallets = carts.value.map((c) => ({ boxCount: num(c.boxCountText), weight: num(c.weightText) }));
    if (pallets.some((p) => !Number.isInteger(p.boxCount) || p.boxCount < 1 || !Number.isFinite(p.weight) || p.weight <= 0)) {
      showToast(t("packaging.cartRowsRequired"));
      return;
    }
    payload = { mode: "pallet", pallets };
  }
  if (!window.confirm(t("packaging.confirmQuestion", { orderNo: order.value.orderNo }))) return;
  confirming.value = true;
  try {
    await warehouse.confirmPackaging(orderId, payload);
    showToast(t("packaging.done"));
    await navigateTo("/packaging");
  } catch (e) {
    // 409 packaging_not_ready: someone else confirmed (or the order left the
    // queue) — bounce back to the list.
    if (isPackagingNotReady(e)) {
      showToast(t("packaging.alreadyDone"));
      await navigateTo("/packaging");
    } else {
      showToast(errorMessage(e));
    }
  } finally {
    confirming.value = false;
  }
}

useVisibleReload(load, ["/packaging-orders", "/picking-orders"]);
</script>

<style scoped>
/* Clearance so the fixed footer never covers the form. */
.packaging-detail-page {
  padding-bottom: 4.5rem;
}

.order-header__title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}

.order-header__title {
  margin: 0;
  font-size: 1.125rem;
  min-width: 0;
  overflow-wrap: anywhere;
}

.section-title {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 0.75rem;
}

.field__label {
  color: var(--muted);
  font-size: 0.875rem;
}

.field__input {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.6rem 0.75rem;
  font-size: 1.125rem;
  background: var(--surface, #fff);
  color: var(--text);
}

.hint {
  color: var(--muted);
  font-size: 0.8125rem;
  margin: -0.25rem 0 0.75rem;
}

.mode-row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.cart-list {
  margin-top: 0.5rem;
}

.cart-row {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.375rem 0;
  border-bottom: 1px solid var(--muted-light, #e5e7eb);
}

.cart-row__label {
  color: var(--muted);
  font-size: 0.875rem;
}

.cart-row__value {
  font-size: 0.875rem;
}

.cart-edit {
  border: 1px solid var(--muted-light, #e5e7eb);
  border-radius: var(--radius);
  padding: 0.5rem 0.625rem;
  margin-bottom: 0.625rem;
}

.cart-edit__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.375rem;
}

.cart-edit__label {
  color: var(--muted);
  font-size: 0.8125rem;
  font-weight: 600;
}

.cart-edit__remove {
  padding: 0.25rem 0.625rem;
  font-size: 0.875rem;
}

.cart-edit__fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}

.cart-edit__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}

.cart-add {
  width: 100%;
  margin-bottom: 0.75rem;
}

.packaging-footer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: flex-end;
  padding: 0.75rem 1rem;
  background: var(--bg, #f3f4f6);
  border-top: 1px solid var(--muted-light, #e5e7eb);
  z-index: 50;
}

.packaging-footer__confirm {
  min-width: 10rem;
}
</style>
