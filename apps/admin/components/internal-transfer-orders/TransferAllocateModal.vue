<script setup lang="ts">
// Manual-allocation dialog for ONE internal transfer item line (spec
// 2026-11-10-internal-transfer-admin-allocate-design.md): lists the part's
// allocatable stock at the order's from_ partition (the availability
// endpoint's `matched` rows use the same org/sub-inventory + share-group
// rule as the engine) and pins manual allocations, qty capped by the source
// availability (net of BOTH engines' reservations) and the item's open qty.
// The picking modal (PartAvailabilityModal) is deliberately not reused — its
// final-state allocate-form and group modes are picking-specific; this is
// the single-row pin path only.
import type { InternalTransferItemRow, PartAvailabilityReceivingRow, PartAvailabilityStockRow } from "~/utils/flowApi";

const props = defineProps<{
  open: boolean;
  orderId: string;
  orderNo: string;
  item: InternalTransferItemRow | null;
  fromOrgId: number | null;
  fromSubInventoryCode: string | null;
}>();

const emit = defineEmits<{ close: []; allocated: [] }>();

const flow = useFlowApi();
const { t } = useI18n();

const loading = ref(false);
const error = ref("");
const busy = ref("");
const stock = ref<PartAvailabilityStockRow[]>([]);
const receiving = ref<PartAvailabilityReceivingRow[]>([]);
const dockAllowed = ref(true);
const qtyByKey = ref<Record<string, string>>({});

// stage 1: pickedQty is always 0 (packages arrive with the PDA stage)
const remaining = computed(() => Math.max(0, (props.item?.qty ?? 0) - (props.item?.allocatedQty ?? 0)));

async function load() {
  if (!props.item) return;
  loading.value = true;
  error.value = "";
  try {
    const res = await flow.getPartAvailability(props.item.partNo, props.item.wclItemNo, {
      orgId: props.fromOrgId,
      subInventoryCode: props.fromSubInventoryCode,
    });
    stock.value = res.stock.filter((r) => r.matched && r.availableQty > 0);
    receiving.value = res.receiving.filter((r) => r.matched);
    dockAllowed.value = res.dockStockAllowed;
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      qtyByKey.value = {};
      load();
    }
  }
);

function defaultQty(key: string, available: number): number {
  const raw = qtyByKey.value[key];
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return Math.min(available, remaining.value);
}

/** JSON 409 bodies (lock_held etc.) — same style as AllocationBreakdown. */
function describeError(e: any): string {
  try {
    const body = JSON.parse(e?.message ?? "");
    if (typeof body?.error === "string") return body.error;
  } catch {
    // not JSON — fall through
  }
  return e?.message ?? String(e);
}

async function pin(key: string, input: { qty: number; inventoryLotId?: string; receivingInvoiceItemId?: string }) {
  if (!props.item || busy.value) return;
  busy.value = key;
  error.value = "";
  try {
    await flow.addInternalTransferAllocation(props.orderId, props.item.id, input);
    emit("allocated");
    emit("close");
  } catch (e: any) {
    error.value = describeError(e);
  } finally {
    busy.value = "";
  }
}

function pinStock(row: PartAvailabilityStockRow) {
  const key = `l:${row.lotId}`;
  void pin(key, { qty: defaultQty(key, row.availableQty), inventoryLotId: row.lotId });
}

function pinReceiving(row: PartAvailabilityReceivingRow) {
  const key = `r:${row.receivingInvoiceItemId}`;
  void pin(key, { qty: defaultQty(key, Math.max(0, row.receivedQty - row.pickedQty - row.allocatedQty)), receivingInvoiceItemId: row.receivingInvoiceItemId });
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="dialog">
      <button type="button" class="dialog-close" @click="emit('close')" aria-label="Close">&times;</button>
      <h2>{{ $t("internalTransfer.mTitle", { partNo: item?.partNo ?? "" }) }}</h2>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <div v-if="loading" class="muted">{{ $t("admin.common.loading") }}</div>
      <template v-else>
        <p class="hint">
          {{ $t("internalTransfer.mRemaining", { qty: remaining }) }}
          <span v-if="fromOrgId !== null"> · {{ $t("internalTransfer.mAt", { org: fromOrgId, sub: fromSubInventoryCode ?? "—" }) }}</span>
        </p>

        <h3>{{ $t("internalTransfer.mStock") }}</h3>
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("internalTransfer.mShelf") }}</th>
              <th>{{ $t("internalTransfer.mBox") }}</th>
              <th>{{ $t("internalTransfer.mDateCode") }}</th>
              <th class="num">{{ $t("internalTransfer.mAvailable") }}</th>
              <th class="num">{{ $t("internalTransfer.colQty") }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in stock" :key="r.lotId">
              <td>{{ r.shelfDisplayName ?? r.shelfCode ?? "—" }}</td>
              <td>{{ r.boxId ?? "—" }}</td>
              <td>{{ r.dateCode ?? "—" }}</td>
              <td class="num">{{ r.availableQty }}</td>
              <td class="num">
                <input
                  v-model="qtyByKey[`l:${r.lotId}`]"
                  class="qty-input"
                  type="number"
                  min="1"
                  :max="Math.min(r.availableQty, remaining)"
                  :placeholder="String(Math.min(r.availableQty, remaining))"
                />
              </td>
              <td class="num">
                <button type="button" class="btn btn-small" :disabled="busy === `l:${r.lotId}` || remaining <= 0" @click="pinStock(r)">
                  {{ $t("internalTransfer.mAllocate") }}
                </button>
              </td>
            </tr>
            <tr v-if="stock.length === 0">
              <td colspan="6" class="muted">{{ $t("internalTransfer.mNone") }}</td>
            </tr>
          </tbody>
        </table>

        <template v-if="dockAllowed">
          <h3>{{ $t("internalTransfer.mDock") }}</h3>
          <table class="data">
            <thead>
              <tr>
                <th>{{ $t("internalTransfer.mBatch") }}</th>
                <th>{{ $t("internalTransfer.mBox") }}</th>
                <th>{{ $t("internalTransfer.mDateCode") }}</th>
                <th class="num">{{ $t("internalTransfer.mAvailable") }}</th>
                <th class="num">{{ $t("internalTransfer.colQty") }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in receiving" :key="r.receivingInvoiceItemId">
                <td>{{ r.batchNo }} · {{ r.invoiceNo }}</td>
                <td>{{ r.ctnNo ?? "—" }}</td>
                <td>{{ r.dateCode ?? "—" }}</td>
                <td class="num">{{ Math.max(0, r.receivedQty - r.pickedQty - r.allocatedQty) }}</td>
                <td class="num">
                  <input
                    v-model="qtyByKey[`r:${r.receivingInvoiceItemId}`]"
                    class="qty-input"
                    type="number"
                    min="1"
                    :max="Math.min(Math.max(0, r.receivedQty - r.pickedQty - r.allocatedQty), remaining)"
                    :placeholder="String(Math.min(Math.max(0, r.receivedQty - r.pickedQty - r.allocatedQty), remaining))"
                  />
                </td>
                <td class="num">
                  <button
                    type="button"
                    class="btn btn-small"
                    :disabled="busy === `r:${r.receivingInvoiceItemId}` || remaining <= 0"
                    @click="pinReceiving(r)"
                  >
                    {{ $t("internalTransfer.mAllocate") }}
                  </button>
                </td>
              </tr>
              <tr v-if="receiving.length === 0">
                <td colspan="6" class="muted">{{ $t("internalTransfer.mNone") }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.qty-input {
  width: 7ch;
  font: inherit;
  text-align: right;
}
</style>
