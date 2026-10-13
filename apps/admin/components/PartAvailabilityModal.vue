<script setup lang="ts">
import type { PartAvailability, PartAvailabilityReceivingRow, PartAvailabilityStockRow } from "~/utils/flowApi";

// "Part availability" modal: stock lots + open receiving sources for a part,
// across all orgs/sub-inventories (rows matching the context partition are
// highlighted). Fetches itself every time `open` flips true.
//
// With pickingOrderId + pickingItem it is a FINAL-STATE FORM (mirrors the
// receiving-side PartSearchModal): each row states the total this item should
// hold from that source afterwards, and ONE Confirm at the bottom applies
// every row in a single all-or-nothing call. Row inputs are never disabled —
// an impossible value is flagged inline and blocks the Confirm instead.
// Without them the modal is read-only.
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
    allocations: {
      qty: number;
      receivingInvoiceItemId: string | null;
      lot: { id: string } | null;
    }[];
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
const saving = ref(false);
const error = ref("");
const dismiss = useOverlayDismiss(() => emit("close"));
// Stock-table sort (shared options/ordering with the receiving-side modal).
const stockSort = ref<StockSortKey>("date-code");
const sortedStock = computed(() => sortStockRows(filteredStock.value, stockSort.value));
// Desired final totals per source row (`s:<lotId>` / `r:<receivingItemId>`).
// Unset = "keep what it is now".
const plan = ref<Record<string, number>>({});

// Date-code (WWYY) range filter: native calendar pickers, converted to WWYY.
const dcFrom = ref("");
const dcTo = ref("");
const dcFromDate = computed(() => (dcFrom.value ? new Date(`${dcFrom.value}T00:00:00`) : null));
const dcToDate = computed(() => (dcTo.value ? new Date(`${dcTo.value}T00:00:00`) : null));
const dcFromCode = computed(() => (dcFromDate.value ? dateToDateCode(dcFromDate.value) : ""));
const dcToCode = computed(() => (dcToDate.value ? dateToDateCode(dcToDate.value) : ""));
const dcActive = computed(() => !!dcFromDate.value || !!dcToDate.value);
// Only rows the allocation engine could actually use for this order: same org
// + same sub-inventory, or a sibling in the same share group (backend
// `matched`). With no context partition every row matches, so nothing is cut.
const applicableStock = computed(() => (data.value?.stock ?? []).filter((s) => s.matched));
const applicableReceiving = computed(() => (data.value?.receiving ?? []).filter((r) => r.matched));
const filteredStock = computed(() =>
  applicableStock.value.filter((s) => dateCodeInRange(s.dateCode, dcFromDate.value, dcToDate.value))
);
const filteredReceiving = computed(() =>
  applicableReceiving.value.filter((r) => dateCodeInRange(r.dateCode, dcFromDate.value, dcToDate.value))
);
// Receiving dock stock is not allocatable when the flow config turns it off.
const showReceiving = computed(() => data.value?.dockStockAllowed === true);

const allocatable = computed(() => !!props.pickingOrderId && !!props.pickingItem);

// What this item holds TODAY, per source — the form's baseline. Derived from
// the item's own allocation rows so no extra round-trip is needed.
const currentBySource = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  for (const a of props.pickingItem?.allocations ?? []) {
    const key = a.lot?.id ? `s:${a.lot.id}` : a.receivingInvoiceItemId ? `r:${a.receivingInvoiceItemId}` : "";
    if (key) out[key] = (out[key] ?? 0) + a.qty;
  }
  return out;
});

function currentOf(key: string): number {
  return currentBySource.value[key] ?? 0;
}
function planned(key: string): number {
  const v = plan.value[key];
  return v === undefined ? currentOf(key) : v;
}
function setPlan(key: string, v: number) {
  plan.value = { ...plan.value, [key]: v };
}

/** The rows this form submits: everything the admin can actually see. */
const sentStock = computed(() => filteredStock.value);
const sentReceiving = computed(() => (showReceiving.value ? filteredReceiving.value : []));

/** qty − picked − Σ allocations: how much more this item may reserve. */
const headroom = computed(() => {
  const item = props.pickingItem;
  if (!item) return 0;
  const held = item.allocations.reduce((s, a) => s + a.qty, 0);
  return Math.max(0, item.qty - item.pickedQty - held);
});
/** Net effect of the form: rows grow minus rows released. */
const plannedDelta = computed(
  () =>
    sentStock.value.reduce((s, r) => s + planned(`s:${r.lotId}`) - currentOf(`s:${r.lotId}`), 0) +
    sentReceiving.value.reduce(
      (s, r) => s + planned(`r:${r.receivingInvoiceItemId}`) - currentOf(`r:${r.receivingInvoiceItemId}`),
      0
    )
);
/** Open demand left after the form is applied. */
const remaining = computed(() => headroom.value - plannedDelta.value);

/** Physical ceiling per row: a lot can't be oversubscribed past its total. */
function stockCap(s: PartAvailabilityStockRow): number {
  return Math.max(0, s.totalQty);
}
function receivingCap(r: PartAvailabilityReceivingRow): number {
  return Math.max(0, r.receivedQty - r.pickedQty);
}
function stockDelta(s: PartAvailabilityStockRow): number {
  return planned(`s:${s.lotId}`) - currentOf(`s:${s.lotId}`);
}
function receivingDelta(r: PartAvailabilityReceivingRow): number {
  return planned(`r:${r.receivingInvoiceItemId}`) - currentOf(`r:${r.receivingInvoiceItemId}`);
}
/** Growing past what's free means reclaiming other orders' allocations. */
function needsOverride(s: PartAvailabilityStockRow): boolean {
  return stockDelta(s) > s.availableQty;
}

const rowOverCap = computed(
  () =>
    sentStock.value.some((s) => planned(`s:${s.lotId}`) > stockCap(s)) ||
    sentReceiving.value.some((r) => planned(`r:${r.receivingInvoiceItemId}`) > receivingCap(r))
);
/** Over-allocation is a hard reject: it rolls back the whole batch. */
const overOpenDemand = computed(() => remaining.value < 0);
const formInvalid = computed(() => rowOverCap.value || overOpenDemand.value);
const formDirty = computed(
  () =>
    sentStock.value.some((s) => planned(`s:${s.lotId}`) !== currentOf(`s:${s.lotId}`)) ||
    sentReceiving.value.some((r) => planned(`r:${r.receivingInvoiceItemId}`) !== currentOf(`r:${r.receivingInvoiceItemId}`))
);
const overridingRows = computed(() => sentStock.value.filter(needsOverride));
const canSubmit = computed(() => allocatable.value && !formInvalid.value && formDirty.value && !saving.value);

function highlight(row: { orgId: number | null; subInventoryCode: string | null }): boolean {
  return row.orgId === (props.contextOrgId ?? null) && row.subInventoryCode === (props.contextSubInventory ?? null);
}

/** Human label for an error row key, used in the rejected-batch banner. */
function rowLabel(key: string): string {
  if (key.startsWith("s:")) {
    const s = (data.value?.stock ?? []).find((x) => x.lotId === key.slice(2));
    if (!s) return key;
    return [s.shelfDisplayName ?? s.shelfCode, s.boxId, s.dateCode].filter(Boolean).join("-") || s.lotId;
  }
  const r = (data.value?.receiving ?? []).find((x) => x.receivingInvoiceItemId === key.slice(2));
  if (!r) return key;
  return [r.batchNo, r.ctnNo, r.dateCode].filter(Boolean).join("-") || r.receivingInvoiceItemId;
}
/** The backend keys lots `l:`; the form has always called them `s:`. */
function clientKey(key: string): string {
  return key.startsWith("l:") ? `s:${key.slice(2)}` : key;
}
function reasonLabel(reason: string): string {
  return t(`admin.pages.pickingOrders.availabilityReasons.${reason}`);
}

async function submit() {
  const orderId = props.pickingOrderId;
  const item = props.pickingItem;
  if (!orderId || !item || !canSubmit.value) return;
  // One confirmation covers every row that reclaims stock from other orders.
  if (overridingRows.value.length > 0) {
    const qty = overridingRows.value.reduce((s, r) => s + (stockDelta(r) - r.availableQty), 0);
    const ok = window.confirm(`${t("admin.pages.pickingOrders.availabilityOverrideConfirm", { qty })}\n\n` +
      overridingRows.value.map((r) => rowLabel(`s:${r.lotId}`)).join("\n"));
    if (!ok) return;
  }
  saving.value = true;
  error.value = "";
  try {
    // Send every visible row so the form is unambiguous: rows the admin left
    // alone go out at their current value and are a no-op server-side.
    // Rows hidden by the filters are NOT sent — the backend keeps them as-is,
    // so a date-code filter can never silently release stock.
    const rows = [
      ...sentStock.value.map((s) => ({
        inventoryLotId: s.lotId,
        qty: planned(`s:${s.lotId}`),
        override: needsOverride(s),
      })),
      ...sentReceiving.value.map((r) => ({
        receivingInvoiceItemId: r.receivingInvoiceItemId,
        qty: planned(`r:${r.receivingInvoiceItemId}`),
      })),
    ];
    await flow.allocatePickingItemFromSources(orderId, item.id, rows);
    emit("allocated");
    emit("close");
  } catch (e: any) {
    // 409s carry a JSON body the api client throws verbatim: per-row reasons
    // for a rejected batch, or the open/allocated totals for an
    // over-allocation. Anything else falls back to the raw message.
    let handled = false;
    try {
      const body = JSON.parse(e.message);
      if (body?.error === "allocate_rejected" && Array.isArray(body.rows)) {
        error.value = body.rows
          .map((r: { key: string; reason: string }) =>
            t("admin.pages.pickingOrders.availabilityRowRejected", {
              row: rowLabel(clientKey(r.key)),
              reason: reasonLabel(r.reason),
            })
          )
          .join(" · ");
        handled = true;
      } else if (body?.error === "lock_held") {
        error.value = t("admin.pages.pickingOrders.reallocateLocked", {
          orderNo: props.orderNo ?? "",
          name: body.holderName ?? body.holderId,
        });
        handled = true;
      } else if (body?.error === "over_allocation") {
        error.value = t("admin.pages.pickingOrders.availabilityOverAllocation", {
          openQty: body.openQty,
          allocated: body.allocated,
        });
        handled = true;
      } else if (body?.error === "insufficient_available") {
        error.value = t("admin.pages.pickingOrders.availabilityOverrideInsufficient");
        handled = true;
      }
    } catch {
      // not JSON — fall through to the raw message
    }
    if (!handled) error.value = e.message;
  } finally {
    saving.value = false;
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return;
    data.value = null;
    error.value = "";
    plan.value = {};
    saving.value = false;
    dcFrom.value = "";
    dcTo.value = "";
    stockSort.value = "date-code";
    loading.value = true;
    try {
      data.value = await flow.getPartAvailability(props.partNo, props.wclItemNo, {
        orgId: props.contextOrgId ?? null,
        subInventoryCode: props.contextSubInventory ?? null,
      });
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
      <p v-if="allocatable" class="hint-text">
        {{ $t("admin.pages.pickingOrders.availabilityHint") }}
      </p>
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
        <label class="avail-sort">
          {{ $t("admin.pages.pickingOrders.availabilitySortBy") }}
          <select v-model="stockSort">
            <option v-for="o in STOCK_SORT_OPTIONS" :key="o.value" :value="o.value">
              {{ $t(o.labelKey) }}
            </option>
          </select>
        </label>
      </div>
      <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>
      <template v-else-if="data">
        <h3 class="avail-section">{{ $t("admin.pages.pickingOrders.availabilityStock") }}</h3>
        <table v-if="filteredStock.length > 0" class="avail-table">
          <thead>
            <tr>
              <th>{{ $t("admin.pages.shelfBoxes.orgId") }}</th>
              <th>{{ $t("admin.pages.shelfBoxes.subInventory") }}</th>
              <th>{{ $t("stockSearch.shelf") }}</th>
              <th>{{ $t("stockSearch.box") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.availabilityLocation") }}</th>
              <th>{{ $t("stockSearch.dateCode") }}</th>
              <th>{{ $t("stockSearch.lotCode") }}</th>
              <th class="num">{{ $t("stockSearch.totalQty") }}</th>
              <th class="num">{{ $t("stockSearch.allocatedQty") }}</th>
              <th class="num">{{ $t("stockSearch.availableQty") }}</th>
              <th v-if="allocatable" class="num">{{ $t("admin.pages.pickingOrders.availabilityTarget") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in sortedStock" :key="s.lotId" :class="{ 'avail-match': highlight(s) }">
              <td>{{ s.orgId ?? "—" }}</td>
              <td>{{ s.subInventoryCode ?? "—" }}</td>
              <td>{{ s.shelfDisplayName ?? s.shelfCode ?? "—" }}</td>
              <td>{{ s.boxId ?? "—" }}</td>
              <td>{{ formatStockLocation(s) }}</td>
              <td>{{ s.dateCode ?? "—" }}</td>
              <td>{{ s.lotCode ?? "—" }}</td>
              <td class="num">{{ s.totalQty }}</td>
              <td class="num">{{ s.allocatedQty }}</td>
              <td class="num">{{ s.availableQty }}</td>
              <td v-if="allocatable" class="num">
                <input
                  :value="planned(`s:${s.lotId}`)"
                  type="number"
                  min="0"
                  :max="stockCap(s)"
                  class="avail-qty"
                  @input="setPlan(`s:${s.lotId}`, Number(($event.target as HTMLInputElement).value))"
                />
                <div v-if="!s.shelfKnown" class="warn-text">
                  {{ $t("admin.pages.pickingOrders.availabilityShelfUnknown") }}
                </div>
                <div v-else-if="planned(`s:${s.lotId}`) > stockCap(s)" class="warn-text">
                  {{ $t("admin.pages.pickingOrders.availabilityRowCap", { max: stockCap(s) }) }}
                </div>
                <div v-else-if="needsOverride(s)" class="warn-text">
                  {{ $t("admin.pages.pickingOrders.availabilityWillReclaim", { qty: stockDelta(s) - s.availableQty }) }}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="muted">{{ $t("admin.pages.pickingOrders.availabilityNoneStock") }}</div>

        <!-- The whole section is hidden when the warehouse config disallows
             allocation from receiving dock stock. -->
        <template v-if="showReceiving">
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
                <th v-if="allocatable" class="num">{{ $t("admin.pages.pickingOrders.availabilityTarget") }}</th>
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
                  <input
                    :value="planned(`r:${r.receivingInvoiceItemId}`)"
                    type="number"
                    min="0"
                    :max="receivingCap(r)"
                    class="avail-qty"
                    @input="setPlan(`r:${r.receivingInvoiceItemId}`, Number(($event.target as HTMLInputElement).value))"
                  />
                  <div v-if="planned(`r:${r.receivingInvoiceItemId}`) > receivingCap(r)" class="warn-text">
                    {{ $t("admin.pages.pickingOrders.availabilityRowCap", { max: receivingCap(r) }) }}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="muted">{{ $t("admin.pages.pickingOrders.availabilityNoneReceiving") }}</div>
        </template>
        <div v-if="overOpenDemand" class="warn-text">
          {{ $t("admin.pages.pickingOrders.availabilityOverOpen", { qty: Math.abs(remaining) }) }}
        </div>
      </template>
      <div class="dialog-actions">
        <button class="btn" @click="emit('close')">{{ $t("admin.common.cancel") }}</button>
        <button
          v-if="allocatable && !loading"
          class="btn btn-primary"
          :disabled="!canSubmit"
          @click="submit"
        >
          {{ saving ? $t("admin.common.saving") : $t("admin.pages.pickingOrders.availabilitySubmit") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.avail-dialog {
  width: 56.25rem;
}
.avail-filter {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  margin-bottom: 0.625rem;
  font-size: 0.8125rem;
  color: #52606d;
}
.avail-filter label {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
}
.avail-filter input[type="date"] {
  padding: 0.25rem 0.375rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  font-size: 0.8125rem;
}
.avail-filter select {
  padding: 0.25rem 0.375rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  font-size: 0.8125rem;
  background: #fff;
}
.avail-sort {
  margin-left: auto;
}
.warn-text {
  font-size: 0.75rem;
  color: #b54708;
  text-align: left;
  max-width: 9rem;
}
</style>
