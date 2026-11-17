<script setup lang="ts">
import type { InternalTransferAllocationRow, InternalTransferItemRow, InternalTransferOrderDetailRow } from "~/utils/flowApi";
import TransferAllocateModal from "~/components/internal-transfer-orders/TransferAllocateModal.vue";

// Detail view of one upstream-synced internal transfer order + its item
// lines. Stage 1 (spec 2026-11-10-internal-transfer-admin-allocate-design.md):
// per-order Re-allocate, allocation-supply promise display, manual
// allocation add/remove. PDA picking + the finish branches are stage 2.
const flow = useFlowApi();
const { t } = useI18n();
const { formatLabel: formatDcLabel } = useDateCodeDisplay();
const route = useRoute();

const order = ref<InternalTransferOrderDetailRow | null>(null);
const items = ref<InternalTransferItemRow[]>([]);
const loading = ref(true);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const res = await flow.getInternalTransferOrder(String(route.params.id));
    order.value = res.order;
    items.value = res.items;
  } catch (e: any) {
    error.value = e?.message ?? String(e);
    order.value = null;
    items.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function fmtLoc(orgId: number | null, code: string | null): string {
  return orgId === null && !code ? "—" : `${orgId ?? "?"} / ${code ?? "?"}`;
}

/** JSON 409 bodies (lock_held with holder info) — same style as the picking detail. */
function describeError(e: any): string {
  try {
    const body = JSON.parse(e?.message ?? "");
    if (body?.error === "lock_held") {
      return t("internalTransfer.lockHeld", { name: body.holderName ?? body.holderId });
    }
    if (typeof body?.error === "string") return body.error;
  } catch {
    // not JSON — fall through
  }
  return e?.message ?? String(e);
}

// --- Re-allocate (order-scoped wipe/rebuild from the from_ partition) ---

const reallocating = ref(false);
const reallocMsg = ref("");
const reallocErr = ref("");
const canReallocate = computed(() => ["pending", "allocated", "picking"].includes(order.value?.status ?? ""));

async function reallocate() {
  if (!order.value || reallocating.value) return;
  if (!window.confirm(t("internalTransfer.reallocateConfirm"))) return;
  reallocating.value = true;
  reallocErr.value = "";
  reallocMsg.value = "";
  try {
    const res = await flow.reallocateInternalTransferOrder(order.value.id);
    const a = res.allocation;
    reallocMsg.value = t("internalTransfer.reallocateDone", { fully: a.fullyAllocated, demands: a.demands });
    await load();
  } catch (e: any) {
    reallocErr.value = describeError(e);
  } finally {
    reallocating.value = false;
  }
}

// --- admin confirm / unconfirm (the PDA queue gate) ---

async function setStatus(status: "pending" | "allocated") {
  if (!order.value || reallocating.value) return;
  if (status === "pending" && !window.confirm(t("internalTransfer.unconfirmConfirm"))) return;
  reallocating.value = true;
  reallocErr.value = "";
  reallocMsg.value = "";
  try {
    await flow.setInternalTransferStatus(order.value.id, status);
    reallocMsg.value = t(status === "allocated" ? "internalTransfer.confirmed" : "internalTransfer.unconfirmed");
    await load();
  } catch (e: any) {
    reallocErr.value = describeError(e);
  } finally {
    reallocating.value = false;
  }
}

// --- manual allocation add/remove ---

const modalItem = ref<InternalTransferItemRow | null>(null);
const modalOpen = ref(false);
const removeBusy = ref("");

function openModal(item: InternalTransferItemRow) {
  modalItem.value = item;
  modalOpen.value = true;
}

async function removeAllocation(item: InternalTransferItemRow, alloc: InternalTransferAllocationRow) {
  if (!order.value || removeBusy.value) return;
  if (!window.confirm(t("internalTransfer.removeAllocConfirm", { qty: alloc.qty }))) return;
  removeBusy.value = alloc.id;
  error.value = "";
  try {
    await flow.removeInternalTransferAllocation(order.value.id, item.id, alloc.id);
    await load();
  } catch (e: any) {
    error.value = describeError(e);
  } finally {
    removeBusy.value = "";
  }
}

function allocationSource(a: InternalTransferAllocationRow): string {
  // Same label style as the picking detail's allocation rows.
  if (a.lot)
    return t("admin.pages.pickingOrders.allocLot", {
      shelf: a.lot.shelfCode ?? "",
      box: a.lot.boxId ? ` / ${a.lot.boxId}` : "",
      dc: formatDcLabel(a.lot) || "—",
    });
  if (a.receivingInvoiceItemId) return t("admin.pages.pickingOrders.allocReceivingBox", { box: a.boxId ?? "" });
  if (a.receivingOrderId)
    return t("admin.pages.pickingOrders.allocReceivingOrder") + (a.orderLevelBatchNo ? ` ${a.orderLevelBatchNo}` : "");
  return "—";
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ order?.orderNo ?? $t("internalTransfer.title") }}</h1>
      <div class="head-actions">
        <button
          v-if="order?.status === 'pending'"
          class="btn btn-primary"
          :disabled="reallocating"
          @click="setStatus('allocated')"
        >
          {{ $t("internalTransfer.confirm") }}
        </button>
        <button
          v-if="order?.status === 'allocated'"
          class="btn"
          :disabled="reallocating"
          @click="setStatus('pending')"
        >
          {{ $t("internalTransfer.unconfirm") }}
        </button>
        <button
          v-if="canReallocate"
          class="btn btn-primary"
          :disabled="reallocating"
          @click="reallocate"
        >
          {{ reallocating ? "…" : $t("internalTransfer.reallocate") }}
        </button>
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
        <NuxtLink to="/internal-transfer-orders" class="btn">{{ $t("admin.common.back") }}</NuxtLink>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="reallocErr" class="error-banner">{{ reallocErr }}</div>
    <div v-if="reallocMsg" class="ok-banner">{{ reallocMsg }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <template v-else-if="order">
      <div class="detail-grid">
        <div><div class="dt">{{ $t("internalTransfer.colStatus") }}</div><div class="dd">{{ $t(`internalTransfer.status.${order.status}`) }}</div></div>
        <div><div class="dt">{{ $t("internalTransfer.colAllocation") }}</div><div class="dd">{{ $t(`status.allocation.${order.allocationStatus}`) }}</div></div>
        <div><div class="dt">{{ $t("internalTransfer.colFrom") }}</div><div class="dd">{{ fmtLoc(order.fromOrgId, order.fromSubInventoryCode) }}</div></div>
        <div><div class="dt">{{ $t("internalTransfer.colTo") }}</div><div class="dd">{{ fmtLoc(order.toOrgId, order.toSubInventoryCode) }}</div></div>
        <div><div class="dt">{{ $t("internalTransfer.colCustomer") }}</div><div class="dd">{{ order.customerName ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("internalTransfer.colCreated") }}</div><div class="dd">{{ new Date(order.createdDate).toLocaleString() }}</div></div>
        <div><div class="dt">{{ $t("internalTransfer.colRemark") }}</div><div class="dd">{{ order.remark ?? "—" }}</div></div>
      </div>

      <h2 class="section-title">{{ $t("internalTransfer.items") }}</h2>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("internalTransfer.colLine") }}</th>
              <th>{{ $t("internalTransfer.colPartNo") }}</th>
              <th>{{ $t("internalTransfer.colWclItemNo") }}</th>
              <th class="num">{{ $t("internalTransfer.colQty") }}</th>
              <th class="num">{{ $t("internalTransfer.colPickedQty") }}</th>
              <th class="num">{{ $t("internalTransfer.colAllocatedQty") }}</th>
              <th>{{ $t("internalTransfer.colAllocations") }}</th>
              <th>{{ $t("internalTransfer.colItemStatus") }}</th>
              <th>{{ $t("internalTransfer.colPoNo") }}</th>
              <th>{{ $t("internalTransfer.colActions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in items" :key="item.id">
              <td>{{ item.lineNumber ?? "—" }}</td>
              <td>{{ item.partNo }}</td>
              <td>{{ item.wclItemNo ?? "—" }}</td>
              <td class="num">{{ item.qty }}</td>
              <td class="num">{{ item.pickedQty }}</td>
              <td class="num">
                {{ item.allocatedQty }}
                <div v-if="item.promisedQty > 0" class="muted promise-line">
                  {{ $t("internalTransfer.promised", { qty: item.promisedQty, orders: item.promisedOrders ?? "" }) }}
                </div>
              </td>
              <td>
                <template v-for="a in item.allocations" :key="a.id">
                  <AllocationsStockAllocationRow
                    v-if="a.lot"
                    :qty="a.qty"
                    :removing="removeBusy === a.id"
                    :remove-title="$t('internalTransfer.removeAlloc')"
                    @remove="removeAllocation(item, a)"
                  >
                    {{ allocationSource(a) }}<span v-if="a.manual" :title="$t('internalTransfer.manualPin')"> 📌</span>
                    <span v-if="a.lot.shelfWarning" class="shelf-warning" :title="a.lot.shelfWarning">⚠️</span>
                    <span v-if="a.outdated" class="shelf-warning" :title="$t('stockAgeWarning.tooltip')">⚠️</span>
                    <template #tooltip>
                      <AllocationsAllocationDetail :a="a" />
                    </template>
                  </AllocationsStockAllocationRow>
                  <AllocationsReceivingAllocationRow
                    v-else
                    :qty="a.qty"
                    :removing="removeBusy === a.id"
                    :remove-title="$t('internalTransfer.removeAlloc')"
                    @remove="removeAllocation(item, a)"
                  >
                    {{ allocationSource(a) }}<span v-if="a.manual" :title="$t('internalTransfer.manualPin')"> 📌</span>
                    <span v-if="a.outdated" class="shelf-warning" :title="$t('stockAgeWarning.tooltip')">⚠️</span>
                    <template v-if="a.receiving" #tooltip>
                      <AllocationsAllocationDetail :a="a" />
                    </template>
                  </AllocationsReceivingAllocationRow>
                </template>
                <span v-if="item.allocations.length === 0" class="muted">—</span>
              </td>
              <td>{{ item.status }}</td>
              <td>{{ item.poNo ?? "—" }}</td>
              <td>
                <button type="button" class="btn btn-small" :title="$t('internalTransfer.allocateBtn')" @click="openModal(item)">🔍</button>
              </td>
            </tr>
            <tr v-if="items.length === 0">
              <td :colspan="10" class="muted">{{ $t("internalTransfer.noneItems") }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <TransferAllocateModal
        v-model:open="modalOpen"
        :order-id="order.id"
        :order-no="order.orderNo"
        :item="modalItem"
        @close="modalOpen = false"
        @allocated="load"
      />
    </template>
  </div>
</template>

<style scoped>
.num {
  text-align: right;
}
.promise-line {
  font-size: 0.75rem;
}
.shelf-warning {
  cursor: help;
}
</style>
