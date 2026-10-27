<template>
  <div class="labeling-detail-page">
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="order">
      <div class="order-header">
        <div class="order-header__title-row">
          <h2 class="order-header__title">{{ order.orderNo }}</h2>
          <span class="badge" :class="badgeClass(order.status)">
            {{ statusLabel.picking(order.status) }}
          </span>
        </div>
        <DetailRow :label="$t('picking.detail.customer')" :value="order.customerCode" />
        <DetailRow :label="$t('picking.detail.shipTo')" :value="order.shipTo" />
        <DetailRow
          :label="$t('picking.detail.deliveryDate')"
          :value="order.deliveryDate ? order.deliveryDate.slice(0, 10) : null"
        />
      </div>

      <p v-if="matches.length === 0" class="info-line">{{ $t('labeling.noLongerMatch') }}</p>
      <template v-else>
        <LabelPrintRulesPanel ref="panel" :order="order" :matches="matches" />
        <div class="print-all-row">
          <button class="btn" :disabled="panel?.printingAll || panel?.allPrinted" @click="panel?.printAll()">
            <template v-if="panel?.printingAll"><InlineSpinner /> {{ $t('picking.printLabels.printing') }}</template>
            <template v-else>{{ $t('picking.printLabels.printAll') }}</template>
          </button>
        </div>
      </template>

      <footer class="labeling-footer">
        <button class="btn labeling-footer__finish" :disabled="finishing" @click="finish">
          <template v-if="finishing"><InlineSpinner /> {{ $t('actions.finishing') }}</template>
          <template v-else>{{ $t('labeling.finish') }}</template>
        </button>
      </footer>
    </template>
  </div>
</template>

<script setup lang="ts">
// Labeling detail (spec 2026-10-28): the order's live label-print-rule
// matches with the shared print panel, plus the explicit Finish labeling
// action that releases the order into measuring/verify.
import EmptyState from "~/components/EmptyState.vue";
import DetailRow from "~/components/DetailRow.vue";
import InlineSpinner from "~/components/InlineSpinner.vue";
import LabelPrintRulesPanel from "~/components/picking/LabelPrintRulesPanel.vue";
import { badgeClass } from "~/composables/useStatusBadge";
import { finishLabelingOrAlreadyDone } from "~/utils/labeling";
import type { LabelPrintRuleMatch, PickingOrderDetail } from "~/services/types";

definePageMeta({ title: "meta.labelingDetail" });

const route = useRoute();
const orderId = route.params.id as string;
const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const { showToast } = useToast();
const warehouse = useWarehouse();

useHead({ title: t("labeling.title") });

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<PickingOrderDetail | null>(null);
const matches = ref<LabelPrintRuleMatch[]>([]);
const finishing = ref(false);
const panel = ref<InstanceType<typeof LabelPrintRulesPanel> | null>(null);

async function load() {
  pending.value = true;
  error.value = null;
  try {
    const detail = await warehouse.getPickingOrder(orderId);
    // Another operator already cleared the stage (or an admin override did):
    // the order is gone from the queue — bounce back to the list. Old
    // backends omit the field (undefined) and stay.
    if (detail.labelingPending === false) {
      showToast(t("labeling.alreadyDone"));
      await navigateTo("/labeling");
      return;
    }
    order.value = detail;
    // Live rule re-evaluation (rules may have been edited since finish);
    // a fetch failure leaves the print list empty — the finish action stays.
    try {
      matches.value = await warehouse.getPickingLabelPrintRules(orderId);
    } catch (e) {
      matches.value = [];
      showToast(errorMessage(e));
    }
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

async function finish() {
  if (finishing.value) return;
  if (!window.confirm(t("labeling.confirmFinish", { orderNo: order.value?.orderNo ?? "" }))) return;
  finishing.value = true;
  try {
    const result = await finishLabelingOrAlreadyDone(warehouse, orderId);
    // 409 labeling_not_pending → already done elsewhere; treat as done.
    showToast(t(result === "finished" ? "labeling.finished" : "labeling.alreadyDone"));
    await navigateTo("/labeling");
  } catch (e) {
    showToast(errorMessage(e));
  } finally {
    finishing.value = false;
  }
}

useVisibleReload(load, ["/labeling-orders", "/picking-orders"]);
</script>

<style scoped>
/* Clearance so the fixed footer never covers the print list. */
.labeling-detail-page {
  padding-bottom: 4.5rem;
}

.order-header {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem;
  margin-bottom: 1rem;
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

.info-line {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--muted);
  font-size: 0.875rem;
  padding: 0.75rem 1rem;
}

.print-all-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.75rem;
}

.labeling-footer {
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

.labeling-footer__finish {
  min-width: 10rem;
}
</style>
