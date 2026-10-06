<script setup lang="ts">
import type { LotHistory, LotHistoryMovement } from "~/utils/flowApi";

// Lot-history drill-down (spec 2026-10-06 admin audit-trail enrichment):
// origin receiving lines + the full inventory_transactions ledger for one
// lot, with actor names and resolved picking order / shipping box references.
// Read-only; fetches itself every time `open` flips true.
const props = defineProps<{
  open: boolean;
  lotId: string | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

const flow = useFlowApi();
const { t, te } = useI18n();

const data = ref<LotHistory | null>(null);
const loading = ref(false);
const error = ref("");
const dismiss = useOverlayDismiss(() => emit("close"));

function txnLabel(type: string): string {
  const key = `lotHistory.txn.${type.toLowerCase()}`;
  return te(key) ? t(key) : type;
}

function targetText(m: LotHistoryMovement): string {
  if (m.pickingOrderNo) {
    return m.shippingBoxId ? `${m.pickingOrderNo} → ${m.shippingBoxId}` : m.pickingOrderNo;
  }
  if (m.receivingBatchNo) return m.receivingBatchNo;
  if (m.referenceType === "goods_verify_task") return m.referenceId ?? "";
  if (m.referenceType === "shelf_box") return m.referenceId ?? "";
  return "";
}

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen || !props.lotId) return;
    data.value = null;
    error.value = "";
    loading.value = true;
    try {
      data.value = await flow.listLotHistory(props.lotId);
    } catch (e: any) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }
);
</script>

<template>
  <div v-if="open" class="overlay" @mousedown="dismiss.onMousedown" @click="dismiss.onClick">
    <div class="dialog lot-history-dialog">
      <h2>{{ $t("lotHistory.title") }}</h2>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>
      <template v-else-if="data">
        <div class="lot-head muted">
          <span>{{ data.lot.wclItemNo ?? data.lot.partNo }}</span>
          <span v-if="data.lot.dateCode">{{ $t("stockSearch.dateCode") }}: {{ data.lot.dateCode }}</span>
          <span v-if="data.lot.lotCode">{{ $t("stockSearch.lotCode") }}: {{ data.lot.lotCode }}</span>
          <span v-if="data.lot.coo">{{ $t("stockSearch.coo") }}: {{ data.lot.coo }}</span>
          <span v-if="data.lot.cow">{{ $t("stockSearch.cow") }}: {{ data.lot.cow }}</span>
          <span
            >{{ $t("lotHistory.location") }}:
            {{ data.lot.shelfCode ?? $t("lotHistory.dock") }}
            {{ data.lot.boxId ? `· ${data.lot.boxId}` : "" }}</span
          >
          <span
            >{{ $t("lotHistory.qty") }}: {{ data.lot.totalQty }} ({{
              $t("stockSearch.allocatedQty")
            }}
            {{ data.lot.allocatedQty }})</span
          >
        </div>

        <h3 class="lot-section">{{ $t("lotHistory.origin") }}</h3>
        <table v-if="data.sources.length > 0" class="lot-table">
          <thead>
            <tr>
              <th>{{ $t("admin.pages.receiving.batchNo") }}</th>
              <th>{{ $t("stockSearch.partNo") }}</th>
              <th class="num">{{ $t("lotHistory.qty") }}</th>
              <th>{{ $t("lotHistory.time") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in data.sources" :key="s.receivingInvoiceItemId">
              <td>{{ s.batchNo }}</td>
              <td>{{ s.partNo }}</td>
              <td class="num">{{ s.qty }}</td>
              <td>{{ formatDateTime(s.createdDate) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="muted">{{ $t("lotHistory.noSources") }}</div>

        <h3 class="lot-section">{{ $t("lotHistory.movements") }}</h3>
        <div class="lot-scroll">
          <table v-if="data.movements.length > 0" class="lot-table">
            <thead>
              <tr>
                <th>{{ $t("lotHistory.time") }}</th>
                <th>{{ $t("lotHistory.actor") }}</th>
                <th>{{ $t("lotHistory.type") }}</th>
                <th class="num">{{ $t("lotHistory.qty") }}</th>
                <th>{{ $t("lotHistory.shelfBox") }}</th>
                <th>{{ $t("lotHistory.target") }}</th>
                <th>{{ $t("lotHistory.reason") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in data.movements" :key="m.id">
                <td>{{ formatDateTime(m.txnAt) }}</td>
                <td>{{ m.actorName ?? $t("lotHistory.system") }}</td>
                <td>{{ txnLabel(m.txnType) }}</td>
                <td class="num" :class="m.qtyDelta < 0 ? 'neg' : 'pos'">
                  {{ m.qtyDelta > 0 ? `+${m.qtyDelta}` : m.qtyDelta }}
                </td>
                <td>
                  {{ m.shelfCode ?? "—" }}
                  <template v-if="m.boxId">· {{ m.boxId }}</template>
                </td>
                <td>{{ targetText(m) || "—" }}</td>
                <td class="wrap">{{ m.txnReason ?? "" }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="muted">{{ $t("lotHistory.noMovements") }}</div>
        </div>
      </template>
      <div class="dialog-actions">
        <button class="btn" @click="emit('close')">{{ $t("admin.common.cancel") }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lot-history-dialog {
  width: 62.5rem;
  max-width: 95vw;
}
.lot-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem 1rem;
  font-size: 0.8125rem;
  margin-bottom: 0.625rem;
}
.lot-section {
  font-size: 0.875rem;
  margin: 0.875rem 0 0.375rem;
  color: #37424e;
}
.lot-scroll {
  max-height: 24rem;
  overflow: auto;
}
.lot-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}
.lot-table th,
.lot-table td {
  padding: 0.3125rem 0.5rem;
  border-bottom: 1px solid #e4e7eb;
  text-align: left;
  white-space: nowrap;
}
.lot-table th {
  background: #f5f7fa;
  position: sticky;
  top: 0;
}
.lot-table .num {
  text-align: right;
}
.neg {
  color: #b23b3b;
}
.pos {
  color: #237a47;
}
.wrap {
  white-space: normal;
}
</style>
