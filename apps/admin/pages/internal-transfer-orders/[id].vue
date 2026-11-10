<script setup lang="ts">
import type { InternalTransferAllocationRow, InternalTransferItemRow, InternalTransferOrderDetailRow } from "~/utils/flowApi";
import TransferAllocateModal from "~/components/internal-transfer-orders/TransferAllocateModal.vue";

// Detail view of one upstream-synced internal transfer order + its item
// lines. Stage 1 (spec 2026-11-10-internal-transfer-admin-allocate-design.md):
// per-order Re-allocate, delegated picking order assignment, manual
// allocation add/remove. PDA picking + the finish branches are stage 2.
const flow = useFlowApi();
const { t } = useI18n();
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

// --- delegated picking order assignment (org-validated, open orders only) ---

const ASSIGNABLE_STATUSES = ["pending", "allocated", "picking", "issue"];
const assignSearch = ref("");
const assignSearching = ref(false);
const suggestions = ref<{ id: string; orderNo: string; status: string; customerCode: string | null; orgId: number | null }[]>([]);
const assigning = ref(false);
const assignErr = ref("");
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;

const canEditAssignment = computed(() => ["pending", "allocated"].includes(order.value?.status ?? ""));

function scheduleAssignSearch(raw: string) {
  clearTimeout(searchTimer);
  const q = raw?.trim();
  if (!q) {
    suggestions.value = [];
    return;
  }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    assignSearching.value = true;
    try {
      const res = await flow.listPickingOrders({ search: q, status: ASSIGNABLE_STATUSES, page: 1, pageSize: 15 });
      if (seq !== searchSeq) return;
      const toOrg = order.value?.toOrgId ?? null;
      suggestions.value = res.rows
        .filter((r) => toOrg === null || r.orgId === null || r.orgId === toOrg)
        .map((r) => ({ id: r.id, orderNo: r.orderNo, status: r.status, customerCode: r.customerCode, orgId: r.orgId }));
    } catch {
      if (seq !== searchSeq) return;
      suggestions.value = [];
    } finally {
      if (seq === searchSeq) assignSearching.value = false;
    }
  }, 300);
}

async function assign(pickingOrderId: string | null) {
  if (!order.value || assigning.value) return;
  if (pickingOrderId === null && !window.confirm(t("internalTransfer.assignClearConfirm"))) return;
  assigning.value = true;
  assignErr.value = "";
  try {
    await flow.assignInternalTransferPickingOrder(order.value.id, pickingOrderId);
    suggestions.value = [];
    assignSearch.value = "";
    await load();
  } catch (e: any) {
    assignErr.value = describeError(e);
  } finally {
    assigning.value = false;
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

function allocSource(alloc: InternalTransferAllocationRow): string {
  if (alloc.sourceType === "lot") {
    return [alloc.shelfDisplayName ?? alloc.shelfCode, alloc.boxId, alloc.dateCode, alloc.lotCode].filter(Boolean).join(" · ") || "—";
  }
  return [alloc.receivingBatchNo, alloc.receivingInvoiceNo, alloc.ctnNo, alloc.dateCode].filter(Boolean).join(" · ") || "—";
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ order?.orderNo ?? $t("internalTransfer.title") }}</h1>
      <div class="head-actions">
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

      <div class="assign-card">
        <h2 class="section-title">{{ $t("internalTransfer.assignTitle") }}</h2>
        <div v-if="assignErr" class="error-banner">{{ assignErr }}</div>
        <template v-if="order.pickingOrderId">
          <p class="assign-line">
            <NuxtLink :to="`/picking-orders/${order.pickingOrderId}`">{{ order.pickingOrderNo }}</NuxtLink>
            <span class="muted">
              · {{ $t(`status.picking.${order.pickingOrderStatus ?? "pending"}`) }}
              · {{ fmtLoc(order.pickingOrderOrgId, order.pickingOrderSubInventoryCode) }}
              <template v-if="order.pickingOrderCustomerCode"> · {{ order.pickingOrderCustomerCode }}</template>
            </span>
          </p>
          <button v-if="canEditAssignment" class="btn" :disabled="assigning" @click="assign(null)">
            {{ $t("internalTransfer.assignClear") }}
          </button>
        </template>
        <template v-else>
          <p class="muted">{{ $t("internalTransfer.assignNone") }}</p>
          <template v-if="canEditAssignment">
            <input
              v-model="assignSearch"
              class="assign-input"
              type="text"
              :placeholder="$t('internalTransfer.assignSearch', { org: order.toOrgId ?? '?' })"
              @input="scheduleAssignSearch(assignSearch)"
            />
            <div v-if="assignSearching" class="muted">…</div>
            <div v-else-if="suggestions.length === 0 && assignSearch.trim()" class="muted">
              {{ $t("internalTransfer.assignNoMatches", { org: order.toOrgId ?? "?" }) }}
            </div>
            <ul v-else-if="suggestions.length > 0" class="assign-suggestions">
              <li v-for="s in suggestions" :key="s.id">
                <button type="button" :disabled="assigning" @click="assign(s.id)">
                  <span class="sug-no">{{ s.orderNo }}</span>
                  <span class="muted">{{ $t(`status.picking.${s.status}`) }}<template v-if="s.customerCode"> · {{ s.customerCode }}</template></span>
                </button>
              </li>
            </ul>
          </template>
        </template>
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
              <th>{{ $t("internalTransfer.colItemStatus") }}</th>
              <th>{{ $t("internalTransfer.colPoNo") }}</th>
              <th>{{ $t("internalTransfer.colActions") }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="item in items" :key="item.id">
              <tr>
                <td>{{ item.lineNumber ?? "—" }}</td>
                <td>{{ item.partNo }}</td>
                <td>{{ item.wclItemNo ?? "—" }}</td>
                <td class="num">{{ item.qty }}</td>
                <td class="num">{{ item.pickedQty }}</td>
                <td class="num">{{ item.allocatedQty }}</td>
                <td>{{ item.status }}</td>
                <td>{{ item.poNo ?? "—" }}</td>
                <td>
                  <button type="button" class="btn btn-small" :title="$t('internalTransfer.allocateBtn')" @click="openModal(item)">🔍</button>
                </td>
              </tr>
              <tr v-for="alloc in item.allocations" :key="alloc.id" class="alloc-row">
                <td colspan="8">
                  <span class="muted">{{ $t("internalTransfer.allocSource") }}:</span> {{ allocSource(alloc) }}
                  <span class="num">× {{ alloc.qty }}</span>
                  <span v-if="alloc.manual" class="pin" :title="$t('internalTransfer.manualPin')">📌</span>
                </td>
                <td>
                  <button
                    type="button"
                    class="btn btn-small"
                    :disabled="removeBusy === alloc.id"
                    @click="removeAllocation(item, alloc)"
                  >
                    {{ $t("internalTransfer.removeAlloc") }}
                  </button>
                </td>
              </tr>
            </template>
            <tr v-if="items.length === 0">
              <td :colspan="9" class="muted">{{ $t("internalTransfer.noneItems") }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <TransferAllocateModal
        v-model:open="modalOpen"
        :order-id="order.id"
        :order-no="order.orderNo"
        :item="modalItem"
        :from-org-id="order.fromOrgId"
        :from-sub-inventory-code="order.fromSubInventoryCode"
        @allocated="load"
      />
    </template>
  </div>
</template>

<style scoped>
.num {
  text-align: right;
}
.assign-card {
  margin: 1rem 0;
}
.assign-line {
  margin: 0.25rem 0;
}
.assign-input {
  width: 24ch;
  font: inherit;
}
.assign-suggestions {
  list-style: none;
  margin: 0.25rem 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  max-width: 30rem;
}
.assign-suggestions button {
  display: flex;
  gap: 0.75rem;
  width: 100%;
  padding: 0.3125rem 0.5rem;
  font: inherit;
  font-size: 0.875rem;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
}
.assign-suggestions button:hover {
  background: #eef4f6;
}
.sug-no {
  font-weight: 600;
  color: var(--brand-teal-dark);
}
.alloc-row td {
  padding-top: 0;
  font-size: 0.8125rem;
  color: #52606d;
  border-top: none;
}
.pin {
  margin-left: 0.25rem;
}
</style>
