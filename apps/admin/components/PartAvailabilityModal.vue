<script setup lang="ts">
import type { PartAvailability } from "~/utils/flowApi";

// "Part availability" modal: stock lots + open receiving sources for a part,
// across all orgs/sub-inventories (rows matching the context partition are
// highlighted). Fetches itself every time `open` flips true.
// When pickingOrderId + pickingItem are provided, each row gets a qty input +
// Allocate button that pins a MANUAL allocation (survives engine recomputes);
// qty is capped by the source's remaining availability AND the item's
// remaining open demand. Without them the modal is read-only.
const props = defineProps<{
  open: boolean;
  partNo: string;
  wclItemNo?: string | null;
  contextOrgId?: number | null;
  contextSubInventory?: string | null;
  /** Order no used in the lock_held error message. */
  orderNo?: string | null;
  pickingOrderId?: string;
  pickingItem?: {
    id: string;
    qty: number;
    pickedQty: number;
    allocations: { qty: number }[];
  } | null;
}>();

const emit = defineEmits<{
  close: [];
  allocated: [];
}>();

const flow = useFlowApi();
const { t } = useI18n();

const data = ref<PartAvailability | null>(null);
const loading = ref(false);
const error = ref("");
const dismiss = useOverlayDismiss(() => emit("close"));
// Per-source-row qty inputs, busy flags, and qty allocated this session
// (keys: `s:<lotId>` / `r:<receivingInvoiceItemId>`).
const qtyInputs = ref<Record<string, number>>({});
const allocating = ref<Record<string, boolean>>({});
const done = ref<Record<string, number>>({});

// Date-code (WWYY) range filter: native calendar pickers, converted to WWYY.
const dcFrom = ref("");
const dcTo = ref("");
const dcFromDate = computed(() => (dcFrom.value ? new Date(`${dcFrom.value}T00:00:00`) : null));
const dcToDate = computed(() => (dcTo.value ? new Date(`${dcTo.value}T00:00:00`) : null));
const dcFromCode = computed(() => (dcFromDate.value ? dateToDateCode(dcFromDate.value) : ""));
const dcToCode = computed(() => (dcToDate.value ? dateToDateCode(dcToDate.value) : ""));
const dcActive = computed(() => !!dcFromDate.value || !!dcToDate.value);
const filteredStock = computed(() =>
  (data.value?.stock ?? []).filter((s) => dateCodeInRange(s.dateCode, dcFromDate.value, dcToDate.value))
);
const filteredReceiving = computed(() =>
  (data.value?.receiving ?? []).filter((r) => dateCodeInRange(r.dateCode, dcFromDate.value, dcToDate.value))
);

const allocatable = computed(() => !!props.pickingOrderId && !!props.pickingItem);

// Open demand snapshot from the item row (qty − picked − existing allocations).
const openQty = computed(() => {
  const item = props.pickingItem;
  if (!item) return 0;
  const held = item.allocations.reduce((s, a) => s + a.qty, 0);
  return Math.max(0, item.qty - item.pickedQty - held);
});
const remaining = computed(() => openQty.value - Object.values(done.value).reduce((s, q) => s + q, 0));

function highlight(row: { orgId: number | null; subInventoryCode: string | null }): boolean {
  return row.orgId === (props.contextOrgId ?? null) && row.subInventoryCode === (props.contextSubInventory ?? null);
}

function sourceLeft(key: string, base: number): number {
  return base - (done.value[key] ?? 0);
}
function allocCap(left: number): number {
  return Math.max(0, Math.min(left, remaining.value));
}
function canAllocate(key: string, left: number): boolean {
  const q = qtyInputs.value[key];
  return Number.isInteger(q) && q >= 1 && q <= allocCap(left) && !allocating.value[key];
}

async function allocate(key: string, base: number, source: { inventoryLotId: string } | { receivingInvoiceItemId: string }) {
  const item = props.pickingItem;
  if (!item || !props.pickingOrderId || !canAllocate(key, sourceLeft(key, base))) return;
  const qty = qtyInputs.value[key];
  allocating.value = { ...allocating.value, [key]: true };
  error.value = "";
  try {
    await flow.addManualPickingAllocation(props.pickingOrderId, item.id, { qty, ...source });
    done.value = { ...done.value, [key]: (done.value[key] ?? 0) + qty };
    // Suggest the next qty from the refreshed cap.
    qtyInputs.value = { ...qtyInputs.value, [key]: allocCap(sourceLeft(key, base)) };
    emit("allocated");
  } catch (e: any) {
    // 409 lock_held carries a JSON body ({error, holderId, holderName}) —
    // the api client throws the raw body text as the message.
    let handled = false;
    try {
      const body = JSON.parse(e.message);
      if (body?.error === "lock_held") {
        error.value = t("admin.pages.pickingOrders.reallocateLocked", {
          orderNo: props.orderNo ?? "",
          name: body.holderName ?? body.holderId,
        });
        handled = true;
      }
    } catch {
      // not JSON — fall through to the raw message
    }
    if (!handled) error.value = e.message;
  } finally {
    allocating.value = { ...allocating.value, [key]: false };
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return;
    data.value = null;
    error.value = "";
    qtyInputs.value = {};
    done.value = {};
    allocating.value = {};
    dcFrom.value = "";
    dcTo.value = "";
    loading.value = true;
    try {
      data.value = await flow.getPartAvailability(props.partNo, props.wclItemNo);
      // Prefill each row's qty input with the largest sensible amount.
      const rem = openQty.value;
      const inputs: Record<string, number> = {};
      for (const s of data.value.stock) inputs[`s:${s.lotId}`] = Math.min(s.availableQty, rem);
      for (const r of data.value.receiving)
        inputs[`r:${r.receivingInvoiceItemId}`] = Math.min(Math.max(0, r.receivedQty - r.pickedQty), rem);
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
  <div v-if="open" class="overlay" @mousedown="dismiss.onMousedown" @click="dismiss.onClick">
    <div class="dialog avail-dialog">
      <h2>{{ $t("admin.pages.pickingOrders.availabilityTitle", { partNo }) }}</h2>
      <div class="muted avail-context">
        {{ $t("admin.pages.pickingOrders.availabilityContext", {
          org: contextOrgId ?? "—",
          subInventory: contextSubInventory ?? "—",
        }) }}
        <template v-if="allocatable">
          · {{ $t("admin.pages.pickingOrders.availabilityOpenDemand", { qty: remaining }) }}
        </template>
      </div>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <div class="avail-filter">
        <label>
          {{ $t("admin.pages.pickingOrders.availabilityDateCodeFrom") }}
          <input v-model="dcFrom" type="date" />
          <span v-if="dcFromCode" class="muted">{{ dcFromCode }}</span>
        </label>
        <label>
          {{ $t("admin.pages.pickingOrders.availabilityDateCodeTo") }}
          <input v-model="dcTo" type="date" />
          <span v-if="dcToCode" class="muted">{{ dcToCode }}</span>
        </label>
        <button v-if="dcActive" class="btn btn-small" @click="dcFrom = ''; dcTo = ''">
          {{ $t("admin.pages.pickingOrders.availabilityDateCodeClear") }}
        </button>
      </div>
      <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>
      <template v-else-if="data">
        <h3 class="avail-section">{{ $t("admin.pages.pickingOrders.availabilityStock") }}</h3>
        <table v-if="filteredStock.length > 0" class="avail-table">
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
              <th v-if="allocatable" class="num">{{ $t("admin.pages.pickingOrders.availabilityAllocate") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in filteredStock" :key="s.lotId" :class="{ 'avail-match': highlight(s) }">
              <td>{{ s.orgId ?? "—" }}</td>
              <td>{{ s.subInventoryCode ?? "—" }}</td>
              <td>{{ s.shelfCode ?? "—" }}</td>
              <td>{{ s.boxId ?? "—" }}</td>
              <td>{{ s.dateCode ?? "—" }}</td>
              <td>{{ s.lotCode ?? "—" }}</td>
              <td class="num">{{ s.totalQty }}</td>
              <td class="num">{{ s.allocatedQty }}</td>
              <td class="num">{{ sourceLeft(`s:${s.lotId}`, s.availableQty) }}</td>
              <td v-if="allocatable" class="num">
                <span class="alloc-cell">
                  <input
                    v-model.number="qtyInputs[`s:${s.lotId}`]"
                    type="number"
                    min="1"
                    :max="allocCap(sourceLeft(`s:${s.lotId}`, s.availableQty))"
                    class="avail-qty"
                    :disabled="allocCap(sourceLeft(`s:${s.lotId}`, s.availableQty)) <= 0"
                  />
                  <button
                    class="btn btn-small btn-primary"
                    :disabled="!canAllocate(`s:${s.lotId}`, sourceLeft(`s:${s.lotId}`, s.availableQty))"
                    @click="allocate(`s:${s.lotId}`, s.availableQty, { inventoryLotId: s.lotId })"
                  >
                    {{ allocating[`s:${s.lotId}`] ? $t("admin.common.saving") : $t("admin.pages.pickingOrders.availabilityAllocate") }}
                  </button>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="muted">{{ $t("admin.pages.pickingOrders.availabilityNoneStock") }}</div>

        <h3 class="avail-section">{{ $t("admin.pages.pickingOrders.availabilityReceiving") }}</h3>
        <table v-if="filteredReceiving.length > 0" class="avail-table">
          <thead>
            <tr>
              <th>{{ $t("admin.pages.receiving.batchNo") }}</th>
              <th>{{ $t("admin.pages.receiving.supplier") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.status") }}</th>
              <th>{{ $t("admin.pages.issues.invoiceNo") }}</th>
              <th class="num">{{ $t("admin.pages.pickingOrders.availabilityLineQty") }}</th>
              <th class="num">{{ $t("admin.pages.receiving.received") }}</th>
              <th class="num">{{ $t("admin.pages.receiving.putAway") }}</th>
              <th>{{ $t("admin.pages.shelfBoxes.orgId") }}</th>
              <th>{{ $t("admin.pages.shelfBoxes.subInventory") }}</th>
              <th>{{ $t("admin.pages.receiving.ctnNo") }}</th>
              <th>{{ $t("admin.pages.receiving.dateCode") }}</th>
              <th v-if="allocatable" class="num">{{ $t("admin.pages.pickingOrders.availabilityAllocate") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in filteredReceiving"
              :key="r.receivingInvoiceItemId"
              :class="{ 'avail-match': highlight(r) }"
            >
              <td>{{ r.batchNo }}</td>
              <td>{{ r.supplierCode ?? "—" }}</td>
              <td>{{ $t(`status.receiving.${r.status}`) }}</td>
              <td>{{ r.invoiceNo }}</td>
              <td class="num">{{ r.lineQty ?? "—" }}</td>
              <td class="num">{{ r.receivedQty }}</td>
              <td class="num">{{ r.putAwayQty }}</td>
              <td>{{ r.orgId ?? "—" }}</td>
              <td>{{ r.subInventoryCode ?? "—" }}</td>
              <td>{{ r.ctnNo ?? "—" }}</td>
              <td>{{ r.dateCode ?? "—" }}</td>
              <td v-if="allocatable" class="num">
                <span class="alloc-cell">
                  <input
                    v-model.number="qtyInputs[`r:${r.receivingInvoiceItemId}`]"
                    type="number"
                    min="1"
                    :max="allocCap(sourceLeft(`r:${r.receivingInvoiceItemId}`, r.receivedQty - r.pickedQty))"
                    class="avail-qty"
                    :disabled="allocCap(sourceLeft(`r:${r.receivingInvoiceItemId}`, r.receivedQty - r.pickedQty)) <= 0"
                  />
                  <button
                    class="btn btn-small btn-primary"
                    :disabled="!canAllocate(`r:${r.receivingInvoiceItemId}`, sourceLeft(`r:${r.receivingInvoiceItemId}`, r.receivedQty - r.pickedQty))"
                    @click="allocate(`r:${r.receivingInvoiceItemId}`, r.receivedQty - r.pickedQty, { receivingInvoiceItemId: r.receivingInvoiceItemId })"
                  >
                    {{ allocating[`r:${r.receivingInvoiceItemId}`] ? $t("admin.common.saving") : $t("admin.pages.pickingOrders.availabilityAllocate") }}
                  </button>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="muted">{{ $t("admin.pages.pickingOrders.availabilityNoneReceiving") }}</div>
      </template>
      <div class="dialog-actions">
        <button class="btn" @click="emit('close')">{{ $t("admin.common.cancel") }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.avail-dialog {
  width: 900px;
}
.avail-filter {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 10px;
  font-size: 13px;
  color: #52606d;
}
.avail-filter label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.avail-filter input[type="date"] {
  padding: 4px 6px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
  font-size: 13px;
}
</style>
