<script setup lang="ts">
import type { PartAvailabilityStockRow, PartDemandRow, ReceivingItemRow } from "~/utils/flowApi";

// Receiving-side part search dialog: redistribute ONE receiving item's dock
// stock across the part's open picking demand.
//
// This is a final-state form (spec
// docs/superpowers/specs/2026-10-12-admin-receiving-reallocate-form-design.md):
// every row states the total this receiving item should hold on that picking
// item afterwards, and the whole set is committed in one all-or-nothing call.
// Releasing before allocating is what lets an admin move qty onto a row that
// is already fully allocated — the per-item over-allocation guard can never be
// hit, because we only add to a row that has room below its own requirement.
//
// The related-stock table below is unchanged (read-only context).
const props = defineProps<{
  open: boolean;
  item: ReceivingItemRow | null;
  /** Owning receiving order — the re-allocation route is keyed on it. */
  receivingOrderId: string;
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
const saving = ref(false);
const error = ref("");
const dismiss = useOverlayDismiss(() => emit("close"));
// Stock-table sort (shared options/ordering with the picking-side modal).
const stockSort = ref<StockSortKey>("date-code");
const sortedStock = computed(() => sortStockRows(stock.value, stockSort.value));

// Desired final totals per picking item. Unset = "keep what it is now".
const plan = ref<Record<string, number>>({});

const orgId = computed(() => props.item?.orgId ?? props.contextOrgId ?? null);
const subInventory = computed(() => props.item?.subInventoryCode ?? null);

/** The pool this form redistributes: received − picked. */
const poolSize = computed(() => {
  const row = props.item;
  return row ? row.receivedQty - row.pickedQty : 0;
});
/** Currently distributed across the listed rows. */
const heldTotal = computed(() => demand.value.reduce((sum, d) => sum + (d.matched ? d.fromItemQty : 0), 0));

function planned(d: PartDemandRow): number {
  const v = plan.value[d.pickingItemId];
  return v === undefined ? d.fromItemQty : v;
}
function plannedTotal(): number {
  return demand.value.reduce((sum, d) => sum + (d.matched ? planned(d) : 0), 0);
}
function rowCap(d: PartDemandRow): number {
  return Math.max(0, d.qty - d.pickedQty);
}
const formInvalid = computed(
  () => plannedTotal() > poolSize.value || demand.value.some((d) => d.matched && !d.locked && planned(d) > rowCap(d))
);
const formDirty = computed(() => demand.value.some((d) => d.matched && !d.locked && planned(d) !== d.fromItemQty));
/** A live work lock would reject the whole batch, so say so up front. */
const hasLocked = computed(() => demand.value.some((d) => d.matched && d.locked));
const canSubmit = computed(() => !formInvalid.value && formDirty.value && !hasLocked.value && !saving.value);

function highlight(row: { orgId: number | null; subInventoryCode: string | null }): boolean {
  return row.orgId === orgId.value && row.subInventoryCode === subInventory.value;
}

function rowReasonLabel(reason: string): string {
  return t(`admin.pages.receiving.reallocReasons.${reason}`);
}

async function submit() {
  const row = props.item;
  if (!row || !canSubmit.value) return;
  saving.value = true;
  error.value = "";
  try {
    // Send every listed row so the form is unambiguous: rows the admin left
    // alone are sent at their current value and change to a no-op server-side.
    const rows = demand.value
      .filter((d) => d.matched && !d.locked)
      .map((d) => ({ pickingItemId: d.pickingItemId, qty: planned(d) }));
    await flow.reallocateReceivingItemDemand(props.receivingOrderId, row.id, rows);
    emit("allocated");
    emit("close");
  } catch (e: any) {
    // 409s carry a JSON body the api client throws verbatim: per-row reasons
    // for a rejected batch, or planned/available totals for an oversubscribed
    // pool. Anything else falls back to the raw message.
    let handled = false;
    try {
      const body = JSON.parse(e.message);
      if (body?.error === "reallocate_rejected" && Array.isArray(body.rows)) {
        error.value = body.rows
          .map((r: { orderNo: string; reason: string }) => `${r.orderNo}: ${rowReasonLabel(r.reason)}`)
          .join(" · ");
        handled = true;
      } else if (body?.error === "insufficient_available") {
        error.value = t("admin.pages.receiving.reallocPoolOver");
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

async function loadData() {
  const row = props.item;
  if (!row) return;
  const ctx = {
    orgId: orgId.value,
    subInventoryCode: subInventory.value,
    fromReceivingItemId: row.id,
  };
  const [demandRes, availRes] = await Promise.all([
    flow.getPartDemand(row.partNo, row.wclItemNo, ctx),
    flow.getPartAvailability(row.partNo, row.wclItemNo, ctx),
  ]);
  // Stock: only lots the allocation engine could use for this item's
  // partition (same org + same sub-inventory, or a share-group sibling).
  // Demand rows are filtered by PartDemandTables (same rule).
  demand.value = demandRes.demand;
  stock.value = availRes.stock.filter((s) => s.matched);
}

// A remove from the allocated-qty breakdown succeeded: refresh both tables
// (the freed qty shows up in the stock rows and the demand form).
async function onAllocationsChanged() {
  try {
    await loadData();
  } catch (e: any) {
    error.value = e.message;
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    const row = props.item;
    if (!isOpen || !row) return;
    demand.value = [];
    stock.value = [];
    error.value = "";
    stockSort.value = "date-code";
    plan.value = {};
    saving.value = false;
    loading.value = true;
    try {
      await loadData();
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
        · {{ $t("admin.pages.receiving.reallocPool", { held: heldTotal, available: poolSize }) }}
      </div>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>
      <template v-else>
        <h3 class="avail-section">{{ $t("admin.pages.receiving.searchDemand") }}</h3>
        <ReceivingPartDemandTables
          v-model="plan"
          :rows="demand"
          :context-org-id="orgId"
          :context-sub-inventory="subInventory"
          :available="poolSize"
        />

        <h3 class="avail-section">{{ $t("admin.pages.receiving.searchStock") }}</h3>
        <div class="avail-filter">
          <label class="avail-sort">
            {{ $t("admin.pages.pickingOrders.availabilitySortBy") }}
            <select v-model="stockSort">
              <option v-for="o in STOCK_SORT_OPTIONS" :key="o.value" :value="o.value">
                {{ $t(o.labelKey) }}
              </option>
            </select>
          </label>
        </div>
        <table v-if="stock.length > 0" class="avail-table">
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
              <td class="num">
                <AllocationBreakdown
                  :part-no="s.partNo"
                  :wcl-item-no="s.wclItemNo"
                  :allocated-qty="s.allocatedQty"
                  :transfer-target="null"
                  @changed="onAllocationsChanged"
                />
              </td>
              <td class="num">{{ s.availableQty }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="muted">{{ $t("admin.pages.pickingOrders.availabilityNoneStock") }}</div>
      </template>
      <div class="dialog-actions">
        <button class="btn" @click="emit('close')">{{ $t("admin.common.cancel") }}</button>
        <button v-if="!loading" class="btn btn-primary" :disabled="!canSubmit" @click="submit">
          {{ saving ? $t("admin.common.saving") : $t("admin.pages.receiving.reallocSubmit") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-dialog {
  width: 56.25rem;
}
.avail-filter {
  display: flex;
  align-items: center;
  margin-bottom: 0.625rem;
  font-size: 0.8125rem;
  color: #52606d;
}
.avail-filter label {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
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
</style>