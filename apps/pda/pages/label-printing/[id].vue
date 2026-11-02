<template>
  <div class="label-printing-detail-page">
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
        <DetailRow
          :label="$t('labelPrinting.totals')"
          :value="$t('labelPrinting.boxesItems', { boxes: order.boxes.length, items: order.items.length })"
        />
      </div>

      <p v-if="matches.length === 0" class="info-line">{{ $t('labelPrinting.noLongerMatch') }}</p>
      <template v-else>
        <LabelPrintRulesPanel ref="panel" :order="order" :matches="matches" />
        <div class="print-all-row">
          <button class="btn" :disabled="panel?.printingAll || panel?.allPrinted" @click="panel?.printAll()">
            <template v-if="panel?.printingAll"><InlineSpinner /> {{ $t('picking.printLabels.printing') }}</template>
            <template v-else>{{ $t('picking.printLabels.printAll') }}</template>
          </button>
        </div>
      </template>

      <footer class="label-printing-footer">
        <button class="btn label-printing-footer__finish" :disabled="finishing" @click="finish">
          <template v-if="finishing"><InlineSpinner /> {{ $t('actions.finishing') }}</template>
          <template v-else>{{ $t('labelPrinting.finish') }}</template>
        </button>
      </footer>
    </template>
  </div>
</template>

<script setup lang="ts">
// Label-printing detail (spec 2026-11-02): the order's live label-print-rule
// matches with the shared print panel, plus the explicit Finish printing
// action that moves the order on to the labeling stage.
import EmptyState from "~/components/EmptyState.vue";
import DetailRow from "~/components/DetailRow.vue";
import InlineSpinner from "~/components/InlineSpinner.vue";
import LabelPrintRulesPanel from "~/components/picking/LabelPrintRulesPanel.vue";
import { badgeClass } from "~/composables/useStatusBadge";
import { finishLabelPrintingOrAlreadyDone } from "~/utils/labeling";
import type { LabelPrintRuleMatch, PickingOrderDetail } from "~/services/types";

definePageMeta({ title: "meta.labelPrintingDetail" });

const route = useRoute();
const orderId = route.params.id as string;
const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const { showToast } = useToast();
const warehouse = useWarehouse();

useHead({ title: t("labelPrinting.title") });

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
    if (detail.labelPrintingPending === false) {
      showToast(t("labelPrinting.alreadyDone"));
      await navigateTo("/label-printing");
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
  if (!window.confirm(t("labelPrinting.confirmFinish", { orderNo: order.value?.orderNo ?? "" }))) return;
  finishing.value = true;
  try {
    const { outcome, result } = await finishLabelPrintingOrAlreadyDone(warehouse, orderId);
    // 409 label_printing_not_pending → already done elsewhere; treat as done.
    showToast(t(outcome === "finished" ? "labelPrinting.finished" : "labelPrinting.alreadyDone"));
    // The order moves on to the labeling queue when the labeling step is on.
    await navigateTo(result?.labelingPending ? `/labeling/${orderId}` : "/label-printing");
  } catch (e) {
    showToast(errorMessage(e));
  } finally {
    finishing.value = false;
  }
}

useVisibleReload(load, ["/label-printing-orders", "/picking-orders"]);
</script>

<style scoped>
/* Clearance so the fixed footer never covers the print list. */
.label-printing-detail-page {
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

.label-printing-footer {
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

.label-printing-footer__finish {
  min-width: 10rem;
}
</style>
