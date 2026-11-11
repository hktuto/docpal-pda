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

      <div class="card">
        <DetailRow :label="$t('packaging.boxes')" :value="order.boxCount" />
        <DetailRow :label="$t('packaging.packages')" :value="order.packageCount" />
        <DetailRow v-for="b in order.boxes" :key="b.id" :label="b.id" :value="boxMeta(b)" />
      </div>

      <!-- Packaged: read back the recorded numbers (no re-confirm). -->
      <div v-if="order.packagedAt" class="card">
        <h3 class="section-title">{{ $t('packaging.packagedTitle') }}</h3>
        <DetailRow :label="$t('packaging.weight')" :value="kg(order.packedWeight)" />
        <DetailRow
          v-if="order.packedPalletCount !== null"
          :label="$t('packaging.palletCount')"
          :value="$t('packaging.palletsValue', { count: order.packedPalletCount })"
        />
        <DetailRow :label="$t('packaging.boxes')" :value="$t('packaging.boxesValue', { count: order.packedBoxCount })" />
      </div>

      <!-- Pending: total weight + boxes/pallets mode, one confirm. -->
      <div v-else class="card">
        <h3 class="section-title">{{ $t('packaging.formTitle') }}</h3>
        <label class="field">
          <span class="field__label">{{ $t('packaging.weight') }}</span>
          <input v-model="weightText" class="field__input" type="number" min="0" step="0.001" inputmode="decimal" />
        </label>
        <p v-if="order.grossWeightHint !== null" class="hint">
          {{ $t('packaging.grossHint', { weight: order.grossWeightHint }) }}
        </p>
        <div class="mode-row">
          <button class="btn" :class="{ 'btn-primary': !onPallets }" @click="onPallets = false">
            {{ $t('packaging.modeBoxes', { count: order.boxCount }) }}
          </button>
          <button class="btn" :class="{ 'btn-primary': onPallets }" @click="onPallets = true">
            {{ $t('packaging.modePallets') }}
          </button>
        </div>
        <label v-if="onPallets" class="field">
          <span class="field__label">{{ $t('packaging.palletCount') }}</span>
          <input v-model="palletText" class="field__input" type="number" min="1" step="1" inputmode="numeric" />
        </label>
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
// Packaging detail (打包, spec 2026-11-10-packaging-shipping-steps-design.md):
// record the shipment's total weight + box count (auto, server-recomputed at
// confirm) or pallet count, and confirm once. No scanning — manual figures.
import EmptyState from "~/components/EmptyState.vue";
import DetailRow from "~/components/DetailRow.vue";
import InlineSpinner from "~/components/InlineSpinner.vue";
import { isPackagingNotReady } from "~/utils/packaging";
import type { PackagingOrderDetail } from "~/services/types";

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
const weightText = ref("");
const palletText = ref("1");
const onPallets = ref(false);
const confirming = ref(false);

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
const boxMeta = (b: PackagingOrderDetail["boxes"][number]) =>
  t("packaging.boxMeta", { packages: b.packageCount, weight: b.grossWeight ?? "—" });

async function confirm() {
  if (confirming.value || !order.value) return;
  const weight = Number(weightText.value);
  if (!Number.isFinite(weight) || weight <= 0) {
    showToast(t("packaging.weightRequired"));
    return;
  }
  let palletCount: number | null = null;
  if (onPallets.value) {
    palletCount = Number(palletText.value);
    if (!Number.isInteger(palletCount) || palletCount < 1) {
      showToast(t("packaging.palletRequired"));
      return;
    }
  }
  if (!window.confirm(t("packaging.confirmQuestion", { orderNo: order.value.orderNo }))) return;
  confirming.value = true;
  try {
    await warehouse.confirmPackaging(orderId, weight, palletCount);
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
