<script lang="ts">
// Per-part session cache (module level): the host dialogs re-expand the same
// part's rows repeatedly within a session, so the breakdown is fetched once
// per part and invalidated after every transfer/remove.
import type { PartAllocationRow } from "~/utils/flowApi";

const cache = new Map<string, Promise<PartAllocationRow[]>>();
</script>

<script setup lang="ts">
// Expandable "allocated qty" breakdown for the availability dialogs (spec
// docs/superpowers/specs/2026-10-14-admin-cross-order-allocation-control-design.md):
// lists WHICH picking orders hold a lot's allocations so an admin can act on
// a specific row in place instead of hunting down the other order.
//
// The host tables render one row per inventory_lots row, so the breakdown is
// scoped to THAT LOT: the endpoint returns every allocation of the part
// (same part_no / wcl_item_no on other lots included) and this component
// keeps only the rows sourced from `lotId` — otherwise the popover would
// list allocations sitting on different shelves/date codes of the same part.
//
// Picking availability modal: Transfer here (onto this order's item) + Remove.
// Receiving PartSearchModal: Remove only — its allocate job is the demand
// form; there is no single "current picking item" to transfer onto.
// Rows of the host dialog's own order never get actions here (that UI lives
// on the picking order detail).
const props = defineProps<{
  partNo: string;
  wclItemNo?: string | null;
  allocatedQty: number;
  /** The stock row's lot — only allocations sourced from this lot are listed. */
  lotId: string;
  /** The host dialog's own picking order — its rows get no actions. */
  currentOrderId?: string | null;
  /** Transfer target (single picking item). Absent → Remove only. */
  transferTarget?: { orderId: string; itemId: string } | null;
}>();

const emit = defineEmits<{
  /** A transfer/remove succeeded — the host refreshes its own data. */
  changed: [];
}>();

const flow = useFlowApi();
const { t } = useI18n();

const expanded = ref(false);
const loading = ref(false);
const rows = ref<PartAllocationRow[]>([]);
const error = ref("");
const busy = ref("");
let loaded = false;

// Only allocations sourced from this stock row's lot — the fetch is per part,
// so same-part allocations on other lots/shelves/date codes must be dropped.
const filteredRows = computed(() =>
  rows.value.filter((r) => r.sourceType === "lot" && r.inventoryLotId === props.lotId)
);

const cacheKey = () => `${props.partNo}|${props.wclItemNo ?? ""}`;

function fetchRows(): Promise<PartAllocationRow[]> {
  const key = cacheKey();
  let pending = cache.get(key);
  if (!pending) {
    pending = flow.getPartAllocations(props.partNo, props.wclItemNo).then((r) => r.allocations);
    cache.set(key, pending);
    // A failed fetch must not poison the cache.
    pending.catch(() => cache.delete(key));
  }
  return pending;
}

async function toggle() {
  expanded.value = !expanded.value;
  if (!expanded.value || loaded) return;
  loading.value = true;
  error.value = "";
  try {
    rows.value = await fetchRows();
    loaded = true;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function reload() {
  cache.delete(cacheKey());
  loaded = false;
  rows.value = await fetchRows();
  loaded = true;
}

function isOwnRow(r: PartAllocationRow): boolean {
  return !!props.currentOrderId && r.pickingOrderId === props.currentOrderId;
}

function canTransfer(r: PartAllocationRow): boolean {
  return !!props.transferTarget && !isOwnRow(r) && !r.locked;
}

function canRemove(r: PartAllocationRow): boolean {
  return !isOwnRow(r) && !r.locked;
}

/** JSON 409 bodies (lock_held with holder info etc.) — same style as the hosts. */
function describeError(e: any, r: PartAllocationRow): string {
  try {
    const body = JSON.parse(e.message);
    if (body?.error === "lock_held") {
      return t("admin.pages.pickingOrders.reallocateLocked", {
        orderNo: r.orderNo,
        name: body.holderName ?? body.holderId,
      });
    }
    if (typeof body?.error === "string") return body.error;
  } catch {
    // not JSON — fall through to the raw message
  }
  return e.message;
}

async function transfer(r: PartAllocationRow) {
  const target = props.transferTarget;
  if (!target || busy.value) return;
  const input = window.prompt(
    t("admin.pages.pickingOrders.allocBreakdownTransferQty", { max: r.qty }),
    String(r.qty)
  );
  if (input === null) return;
  const qty = Number(input);
  if (!Number.isInteger(qty) || qty <= 0 || qty > r.qty) {
    error.value = t("admin.pages.pickingOrders.allocBreakdownInvalidQty", { max: r.qty });
    return;
  }
  busy.value = r.allocationId;
  error.value = "";
  try {
    await flow.transferPickingAllocation(target.orderId, target.itemId, r.allocationId, qty);
    await reload();
    emit("changed");
  } catch (e: any) {
    error.value = describeError(e, r);
  } finally {
    busy.value = "";
  }
}

async function remove(r: PartAllocationRow) {
  if (busy.value) return;
  const ok = window.confirm(
    t("admin.pages.pickingOrders.allocBreakdownRemoveConfirm", {
      qty: r.qty,
      partNo: r.partNo,
      orderNo: r.orderNo,
    })
  );
  if (!ok) return;
  busy.value = r.allocationId;
  error.value = "";
  try {
    await flow.removePickingAllocation(r.pickingOrderId, r.pickingItemId, r.allocationId);
    await reload();
    emit("changed");
  } catch (e: any) {
    error.value = describeError(e, r);
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <span v-if="allocatedQty <= 0" class="ab-num">0</span>
  <span v-else class="ab-wrap">
    <button type="button" class="ab-trigger" :class="{ 'ab-open': expanded }" @click="toggle">
      {{ allocatedQty }} {{ expanded ? "▾" : "▸" }}
    </button>
    <div v-if="expanded" class="ab-panel">
      <div v-if="error" class="error-banner">{{ error }}</div>
      <div v-else-if="loading" class="muted">{{ $t("admin.common.loading") }}</div>
      <template v-else>
        <div class="ab-head muted">
          {{ $t("admin.pages.pickingOrders.allocBreakdownTitle", { n: filteredRows.length }) }}
        </div>
        <table class="ab-table">
          <tbody>
            <tr v-for="r in filteredRows" :key="r.allocationId">
              <td class="ab-order">
                <NuxtLink :to="`/picking-orders/${r.pickingOrderId}`" class="ab-link">{{ r.orderNo }}</NuxtLink>
                <span v-if="isOwnRow(r)" class="muted"> ({{ $t("admin.pages.pickingOrders.allocBreakdownThisOrder") }})</span>
              </td>
              <td>{{ $t(`status.picking.${r.orderStatus}`) }}</td>
              <td class="num">{{ r.qty }}</td>
              <td class="ab-flags">
                <span v-if="r.manual" :title="$t('admin.pages.pickingOrders.allocBreakdownManual')">📌</span>
                <span v-if="r.locked" class="ab-lock">
                  🔒 {{ r.workingByName ?? $t("admin.pages.pickingOrders.allocBreakdownLockedUnknown") }}
                </span>
              </td>
              <td class="ab-actions">
                <button
                  v-if="canTransfer(r)"
                  type="button"
                  class="btn btn-small"
                  :disabled="busy === r.allocationId"
                  @click="transfer(r)"
                >
                  {{ $t("admin.pages.pickingOrders.allocBreakdownTransfer") }}
                </button>
                <button
                  v-if="canRemove(r)"
                  type="button"
                  class="btn btn-small"
                  :disabled="busy === r.allocationId"
                  @click="remove(r)"
                >
                  {{ $t("admin.pages.pickingOrders.allocBreakdownRemove") }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </template>
    </div>
  </span>
</template>

<style scoped>
.ab-wrap {
  position: relative;
  display: inline-block;
}
.ab-trigger {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: #1d4ed8;
  cursor: pointer;
  white-space: nowrap;
}
.ab-trigger:hover {
  text-decoration: underline;
}
.ab-panel {
  position: absolute;
  right: 0;
  top: 100%;
  z-index: 40;
  width: 26rem;
  max-width: 78vw;
  margin-top: 0.25rem;
  padding: 0.5rem 0.625rem;
  background: #fff;
  border: 1px solid #b6c2cd;
  border-radius: 0.375rem;
  box-shadow: 0 0.5rem 1.25rem rgba(15, 23, 42, 0.18);
  text-align: left;
  font-size: 0.8125rem;
}
.ab-head {
  margin-bottom: 0.375rem;
  font-size: 0.75rem;
}
.ab-table {
  width: 100%;
  border-collapse: collapse;
}
.ab-table td {
  padding: 0.1875rem 0.375rem 0.1875rem 0;
  vertical-align: top;
}
.ab-order {
  white-space: nowrap;
}
.ab-link {
  color: #1d4ed8;
  text-decoration: none;
}
.ab-link:hover {
  text-decoration: underline;
}
.ab-flags {
  white-space: nowrap;
}
.ab-lock {
  color: #b54708;
}
.ab-actions {
  white-space: nowrap;
  text-align: right;
}
.ab-actions .btn {
  margin-left: 0.25rem;
}
</style>
