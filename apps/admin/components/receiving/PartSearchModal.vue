<script setup lang="ts">
import type { PartAvailabilityStockRow, PartDemandRow, ReceivingItemRow } from "~/utils/flowApi";

// Receiving-side part search + allocate dialog (replaces the row's separate
// Allocate action): the part's open PICKING demand (only rows matching this
// item's org/sub-inventory via PartDemandTables, qty input + Allocate per row
// — pins a MANUAL allocation sourced from this receiving item) plus related
// stock lots (read-only).
const props = defineProps<{
  open: boolean;
  item: ReceivingItemRow | null;
  /** Fallback org when the item carries none (pre-arrival). */
  contextOrgId?: number | null;
}>();

const emit = defineEmits<{
  close: [];
  allocated: [];
}>();

const flow = useFlowApi();
const { t } = useI18n();

const demand = ref<PartDemandRow[]>([]);
const stock = ref<PartAvailabilityStockRow[]>([]);
const loading = ref(false);
const error = ref("");
const dismiss = useOverlayDismiss(() => emit("close"));

// Per-demand-row qty inputs, busy flags, and qty allocated this session.
const qtyInputs = ref<Record<string, number>>({});
const allocating = ref<Record<string, boolean>>({});
const sessionUsed = ref<Record<string, number>>({});
const sessionTotal = ref(0);

const orgId = computed(() => props.item?.orgId ?? props.contextOrgId ?? null);
const subInventory = computed(() => props.item?.subInventoryCode ?? null);

// Remaining qty this receiving item can still source (received − picked −
// allocated − allocated this session).
const receivingLeft = computed(() => {
  const row = props.item;
  if (!row) return 0;
  return Math.max(0, row.receivedQty - row.pickedQty - row.allocatedQty - sessionTotal.value);
});

function demandLeft(d: PartDemandRow): number {
  return Math.max(0, d.remainingQty - (sessionUsed.value[d.pickingItemId] ?? 0));
}
function demandCap(d: PartDemandRow): number {
  return Math.max(0, Math.min(demandLeft(d), receivingLeft.value));
}
function canAllocate(d: PartDemandRow): boolean {
  const q = qtyInputs.value[d.pickingItemId];
  return Number.isInteger(q) && q >= 1 && q <= demandCap(d) && !allocating.value[d.pickingItemId];
}

async function allocate(d: PartDemandRow) {
  const row = props.item;
  if (!row || !canAllocate(d)) return;
  const qty = qtyInputs.value[d.pickingItemId];
  allocating.value = { ...allocating.value, [d.pickingItemId]: true };
  error.value = "";
  try {
    await flow.addManualPickingAllocation(d.pickingOrderId, d.pickingItemId, {
      qty,
      receivingInvoiceItemId: row.id,
    });
    sessionTotal.value += qty;
    sessionUsed.value = { ...sessionUsed.value, [d.pickingItemId]: (sessionUsed.value[d.pickingItemId] ?? 0) + qty };
    // Suggest the next qty from the refreshed cap.
    qtyInputs.value = { ...qtyInputs.value, [d.pickingItemId]: demandCap(d) };
    emit("allocated");
  } catch (e: any) {
    // 409 lock_held carries a JSON body ({error, holderId, holderName}) —
    // the api client throws the raw body text as the message.
    let handled = false;
    try {
      const body = JSON.parse(e.message);
      if (body?.error === "lock_held") {
        error.value = t("admin.pages.pickingOrders.reallocateLocked", {
          orderNo: d.orderNo,
          name: body.holderName ?? body.holderId,
        });
        handled = true;
      }
    } catch {
      // not JSON — fall through to the raw message
    }
    if (!handled) error.value = e.message;
  } finally {
    allocating.value = { ...allocating.value, [d.pickingItemId]: false };
  }
}

function highlight(row: { orgId: number | null; subInventoryCode: string | null }): boolean {
  return row.orgId === orgId.value && row.subInventoryCode === subInventory.value;
}

watch(
  () => props.open,
  async (isOpen) => {
    const row = props.item;
    if (!isOpen || !row) return;
    demand.value = [];
    stock.value = [];
    error.value = "";
    qtyInputs.value = {};
    allocating.value = {};
    sessionUsed.value = {};
    sessionTotal.value = 0;
    loading.value = true;
    try {
      const [demandRes, availRes] = await Promise.all([
        flow.getPartDemand(row.partNo, row.wclItemNo),
        flow.getPartAvailability(row.partNo, row.wclItemNo),
      ]);
      demand.value = demandRes.demand;
      stock.value = availRes.stock;
      // Prefill each row's qty input with the largest sensible amount.
      const inputs: Record<string, number> = {};
      for (const d of demandRes.demand) inputs[d.pickingItemId] = demandCap(d);
      qtyInputs.value = inputs;
    } catch (e: any) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }
);
</script>

<template>
  <div v-if="open && item" class="overlay" @mousedown="dismiss.onMousedown" @click="dismiss.onClick">
    <div class="dialog search-dialog">
      <h2>{{ $t("admin.pages.receiving.searchTitle", { partNo: item.wclItemNo ?? item.partNo }) }}</h2>
      <div class="muted avail-context">
        {{ $t("admin.pages.receiving.searchContext", {
          org: orgId ?? "—",
          subInventory: subInventory ?? "—",
        }) }}
        · {{ $t("admin.pages.receiving.demandAllocatable", { qty: receivingLeft }) }}
      </div>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>
      <template v-else>
        <h3 class="avail-section">{{ $t("admin.pages.receiving.searchDemand") }}</h3>
        <ReceivingPartDemandTables
          :rows="demand"
          :context-org-id="orgId"
          :context-sub-inventory="subInventory"
          :session-used="sessionUsed"
          allocatable
        >
          <template #allocate="{ row: d }">
            <span class="alloc-cell">
              <input
                v-model.number="qtyInputs[d.pickingItemId]"
                type="number"
                min="1"
                :max="demandCap(d)"
                class="avail-qty"
                :disabled="demandCap(d) <= 0"
              />
              <button
                class="btn btn-small btn-primary"
                :disabled="!canAllocate(d)"
                @click="allocate(d)"
              >
                {{ allocating[d.pickingItemId] ? $t("admin.common.saving") : $t("admin.pages.receiving.allocate") }}
              </button>
            </span>
          </template>
        </ReceivingPartDemandTables>

        <h3 class="avail-section">{{ $t("admin.pages.receiving.searchStock") }}</h3>
        <table v-if="stock.length > 0" class="avail-table">
          <thead>
            <tr>
              <th>{{ $t("admin.pages.shelfBoxes.orgId") }}</th>
              <th>{{ $t("admin.pages.shelfBoxes.subInventory") }}</th>
              <th>{{ $t("admin.pages.stockSearch.shelf") }}</th>
              <th>{{ $t("admin.pages.stockSearch.box") }}</th>
              <th>{{ $t("admin.pages.stockSearch.dateCode") }}</th>
              <th>{{ $t("admin.pages.stockSearch.lotCode") }}</th>
              <th class="num">{{ $t("admin.pages.stockSearch.totalQty") }}</th>
              <th class="num">{{ $t("admin.pages.stockSearch.allocatedQty") }}</th>
              <th class="num">{{ $t("admin.pages.stockSearch.availableQty") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in stock" :key="s.lotId" :class="{ 'avail-match': highlight(s) }">
              <td>{{ s.orgId ?? "—" }}</td>
              <td>{{ s.subInventoryCode ?? "—" }}</td>
              <td>{{ s.shelfCode ?? "—" }}</td>
              <td>{{ s.boxId ?? "—" }}</td>
              <td>{{ s.dateCode ?? "—" }}</td>
              <td>{{ s.lotCode ?? "—" }}</td>
              <td class="num">{{ s.totalQty }}</td>
              <td class="num">{{ s.allocatedQty }}</td>
              <td class="num">{{ s.availableQty }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="muted">{{ $t("admin.pages.pickingOrders.availabilityNoneStock") }}</div>
      </template>
      <div class="dialog-actions">
        <button class="btn" @click="emit('close')">{{ $t("admin.common.cancel") }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-dialog {
  width: 56.25rem;
}
</style>
