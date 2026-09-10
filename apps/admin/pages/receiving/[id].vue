<script setup lang="ts">
import type { OrderLogsParams, OrderLogsPage, ReceivingOrderDetail, ReceivingItemRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";

const route = useRoute();
const orderId = route.params.id as string;
const flow = useFlowApi();
const { t } = useI18n();
const apiBaseUrl = useRuntimeConfig().public.apiBaseUrl as string;

const order = ref<ReceivingOrderDetail | null>(null);
// The audit-log table fetches itself; bump this key after mutations that
// write logs so it reloads.
const logsKey = ref(0);
const fetchLogs = (p: OrderLogsParams): Promise<OrderLogsPage> => flow.listReceivingOrderLogs(orderId, p);
const loading = ref(true);
const error = ref("");

// Order-level delivery-date editing (mirrors the picking-orders detail page).
const deliveryDate = ref("");
const savingDate = ref(false);
const dateMsg = ref("");

// Per-item / batch detail editing (date code, lot code, COO, COW, ctn no).
const selected = ref<Set<string>>(new Set());
const editItems = ref<ReceivingItemRow[] | null>(null);
const savingEdit = ref(false);

const allItems = computed(() => (order.value?.invoices ?? []).flatMap((inv) => inv.items));
const selectedItems = computed(() => allItems.value.filter((it) => selected.value.has(it.id)));

function openEdit(item: ReceivingItemRow) {
  editItems.value = [item];
}

function openBatchEdit() {
  if (selectedItems.value.length > 0) editItems.value = selectedItems.value;
}

async function saveEdit(fields: Partial<Record<"dateCode" | "lotCode" | "coo" | "cow" | "ctnNo", string | null>>) {
  const items = editItems.value;
  if (!items || Object.keys(fields).length === 0) {
    editItems.value = null;
    return;
  }
  savingEdit.value = true;
  error.value = "";
  const failed: { id: string; message: string }[] = [];
  for (const item of items) {
    try {
      await flow.updateReceivingItem(item.id, fields);
    } catch (e: any) {
      failed.push({ id: item.wclItemNo ?? item.partNo, message: e?.message ?? String(e) });
    }
  }
  savingEdit.value = false;
  editItems.value = null;
  if (failed.length > 0) {
    error.value = failed.map((f) => `${f.id}: ${f.message}`).join("; ");
  }
  await load();
  logsKey.value++;
}

// Client-side invoice filter: an invoice matches when its invoiceNo contains
// the keyword (all items shown) or any item's partNo/wclItemNo/poNo/ctnNo does.
const invoiceFilter = ref("");

const filteredInvoices = computed(() => {
  const inv = order.value?.invoices ?? [];
  const needle = invoiceFilter.value.trim().toLowerCase();
  if (!needle) return inv;
  // Invoice-no match shows the whole invoice; otherwise only matching items.
  const out: typeof inv = [];
  for (const i of inv) {
    if (i.invoiceNo.toLowerCase().includes(needle)) {
      out.push(i);
      continue;
    }
    const items = i.items.filter(
      (it) =>
        it.partNo.toLowerCase().includes(needle) ||
        (it.wclItemNo ?? "").toLowerCase().includes(needle) ||
        (it.poNo ?? "").toLowerCase().includes(needle) ||
        (it.ctnNo ?? "").toLowerCase().includes(needle)
    );
    if (items.length > 0) out.push({ ...i, items });
  }
  return out;
});

// Group-by selector: invoice (default, current behavior), carton no, or item no.
// Persisted in localStorage so the choice survives reloads/navigation.
type GroupBy = "invoice" | "ctnNo" | "item";
const GROUP_BY_STORAGE_KEY = "admin-group:receiving-detail";
const groupBy = ref<GroupBy>("invoice");

if (typeof localStorage !== "undefined") {
  const stored = localStorage.getItem(GROUP_BY_STORAGE_KEY);
  if (stored === "invoice" || stored === "ctnNo" || stored === "item") groupBy.value = stored;
  watch(groupBy, (v) => {
    try {
      localStorage.setItem(GROUP_BY_STORAGE_KEY, v);
    } catch {
      // Storage unavailable — grouping still works.
    }
  });
}

type InvoiceRow = ReceivingOrderDetail["invoices"][number];
interface ItemGroup {
  key: string;
  invoice: InvoiceRow | null;
  items: ReceivingItemRow[];
}

const groups = computed<ItemGroup[]>(() => {
  const invoices = filteredInvoices.value;
  if (groupBy.value === "invoice") {
    return invoices.map((inv) => ({ key: inv.id, invoice: inv, items: inv.items }));
  }
  const buckets = new Map<string, ReceivingItemRow[]>();
  for (const inv of invoices) {
    for (const it of inv.items) {
      const k = groupBy.value === "ctnNo" ? (it.ctnNo ?? "") : (it.wclItemNo ?? it.partNo);
      const arr = buckets.get(k);
      if (arr) arr.push(it);
      else buckets.set(k, [it]);
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, items]) => ({ key, invoice: null, items }));
});

// One DataTable per group, each with its own useAdminTable instance (created
// lazily and cached by group key). Sort/column state is per group table and
// persists under `admin-table:receiving-detail-items-<groupKey>`; the
// selection Set is shared across all group tables via v-model:selected, so
// DataTable's header checkbox matches the old per-invoice toggle.
// Group item lists were never paged, so pageSize stays large enough to render
// every row (no Pager on this page).
const itemColumnDefs = computed<AdminColumnDef<ReceivingItemRow>[]>(() => [
  {
    key: "partNo",
    label: t("admin.pages.receiving.partNo"),
    accessor: (it) => it.wclItemNo ?? it.partNo,
    size: 180,
  },
  {
    key: "poLine",
    label: t("admin.pages.receiving.poLine"),
    accessor: (it) => `${it.poNo ?? ""}/${it.poLine ?? ""}`,
    size: 140,
  },
  { key: "lineQty", label: t("admin.pages.receiving.expected"), size: 90 },
  { key: "receivedQty", label: t("admin.pages.receiving.received"), size: 90 },
  { key: "putAwayQty", label: t("admin.pages.receiving.putAway"), size: 90 },
  { key: "allocatedQty", label: t("admin.pages.receiving.allocated"), size: 90 },
  { key: "ctnNo", label: t("admin.pages.receiving.ctnNo"), size: 110 },
  { key: "dateCode", label: t("admin.pages.receiving.dateCode"), size: 100 },
]);

type GroupTable = ReturnType<typeof useAdminTable<ReceivingItemRow>>;
const groupTables = new Map<string, GroupTable>();

function tableForGroup(key: string): GroupTable {
  let inst = groupTables.get(key);
  if (!inst) {
    inst = useAdminTable<ReceivingItemRow>({
      // All group tables are the same shape — syncKey makes them share
      // sort/column order/width/visibility live and persist under one key.
      tableId: "receiving-detail-items",
      syncKey: "receiving-detail-items",
      columns: itemColumnDefs,
      rows: computed(() => groups.value.find((g) => g.key === key)?.items ?? []),
      getRowId: (it) => it.id,
      defaultPageSize: 1000,
    });
    groupTables.set(key, inst);
  }
  return inst;
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    order.value = await flow.getReceivingOrder(orderId);
    deliveryDate.value = order.value.deliveryDate ? order.value.deliveryDate.slice(0, 10) : "";
    selected.value = new Set();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function saveDeliveryDate() {
  savingDate.value = true;
  dateMsg.value = "";
  error.value = "";
  try {
    await flow.updateReceivingDeliveryDate(orderId, deliveryDate.value || null);
    await load();
    logsKey.value++;
    dateMsg.value = "saved";
  } catch (e: any) {
    error.value = e.message;
  } finally {
    savingDate.value = false;
  }
}

// Per-item mismatch confirm/cancel (same semantics as the Issues page).
const mismatchActing = ref<Record<string, string>>({});

// Admin-side arrival confirmation (pending / provisional_received → in_hand),
// same endpoint the PDA uses.
const confirmingArrival = ref(false);

// Allocation runs in the background after confirm-arrival; allocation.finished
// (SSE) tells us when the recompute is done so the page can refresh itself.
const events = useAdminEvents();
const allocState = ref<"" | "running" | "done" | "slow">("");
let allocUnsub: (() => void) | undefined;
let allocTimer: ReturnType<typeof setTimeout> | undefined;

function waitForAllocation() {
  allocUnsub?.();
  clearTimeout(allocTimer);
  allocState.value = "running";
  allocUnsub = events.subscribe("allocation.finished", async () => {
    allocUnsub?.();
    allocUnsub = undefined;
    clearTimeout(allocTimer);
    await load();
    logsKey.value++;
    allocState.value = "done";
    setTimeout(() => {
      if (allocState.value === "done") allocState.value = "";
    }, 8000);
  });
  // No hard failure state — a slow recompute just keeps running in the
  // background; tell the user instead of spinning forever.
  allocTimer = setTimeout(() => {
    if (allocState.value === "running") allocState.value = "slow";
  }, 60_000);
}

onBeforeUnmount(() => {
  allocUnsub?.();
  clearTimeout(allocTimer);
});

async function confirmInHand() {
  if (!order.value) return;
  if (!window.confirm(t("admin.pages.receiving.confirmInHandConfirm", { batchNo: order.value.batchNo }))) return;
  confirmingArrival.value = true;
  error.value = "";
  try {
    await flow.confirmReceivingArrival(orderId);
    await load();
    logsKey.value++;
    waitForAllocation();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    confirmingArrival.value = false;
  }
}

// Picking-list xlsx download (backend-generated, shipper layout).
const downloadingPickingList = ref(false);

async function downloadPickingList() {
  if (!order.value || downloadingPickingList.value) return;
  downloadingPickingList.value = true;
  error.value = "";
  try {
    const token = localStorage.getItem("admin_token");
    const res = await fetch(`${apiBaseUrl}/admin/receiving-orders/${orderId}/picking-list`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) throw new Error((await res.text()).trim() || `Request failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `picking-list-${order.value.batchNo}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e: any) {
    error.value = `${t("admin.pages.receiving.pickingListError")}: ${e.message}`;
  } finally {
    downloadingPickingList.value = false;
  }
}

async function actMismatch(item: ReceivingItemRow, action: "confirm" | "cancel") {
  mismatchActing.value[item.id] = action;
  error.value = "";
  try {
    if (action === "confirm") await flow.confirmReceivingMismatch(item.id);
    else await flow.cancelReceivingMismatch(item.id);
    await load();
    logsKey.value++;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    delete mismatchActing.value[item.id];
  }
}

// "Mark issue" modal: admin-side mismatch report (mirrors the PDA's
// validation rules in apps/web/utils/mismatch.ts).
const MISMATCH_REASONS = [
  "not_found",
  "damaged",
  "qty_mismatch",
  "wrong_part",
  "over_shipment",
  "quality_rejection",
] as const;

const issueItem = ref<ReceivingItemRow | null>(null);
const issueReason = ref("");
const issueQtyInput = ref("");
const issueWrongPartNo = ref("");
const issueNote = ref("");
const issueError = ref("");
const issueSubmitting = ref(false);
const issueDismiss = useOverlayDismiss(() => (issueItem.value = null));

function openIssueModal(item: ReceivingItemRow) {
  issueItem.value = item;
  issueReason.value = "";
  issueQtyInput.value = "";
  issueWrongPartNo.value = "";
  issueNote.value = "";
  issueError.value = "";
}

function parseIssueQty(): number | null {
  const raw = issueQtyInput.value.trim();
  return raw === "" ? null : Number(raw);
}

// Returns an admin.pages.receiving.issueErr* key, or null when valid.
// expectedQty null = line qty unknown upstream — the expected-bound check
// can't apply (the server re-validates on submit anyway).
function validateIssue(expectedQty: number | null, qty: number | null): string | null {
  const reason = issueReason.value;
  if (!reason) return "issueErrReasonRequired";
  if (reason === "not_found" && qty !== null) return "issueErrNotFoundNoQty";
  if (qty !== null && (!Number.isInteger(qty) || qty < 0)) return "issueErrQtyNonNegativeInt";
  if (expectedQty !== null && (reason === "damaged" || reason === "quality_rejection") && qty !== null && qty > expectedQty)
    return "issueErrQtyExceedsExpected";
  if ((reason === "over_shipment" || reason === "wrong_part") && (qty === null || qty <= 0))
    return "issueErrQtyGreaterThanZero";
  if (reason === "wrong_part" && issueWrongPartNo.value.trim() === "") return "issueErrWrongPartRequired";
  if (reason === "qty_mismatch" && qty === null) return "issueErrQtyMismatchQtyRequired";
  return null;
}

async function submitIssue() {
  const item = issueItem.value;
  if (!item) return;
  const qty = parseIssueQty();
  const errKey = validateIssue(item.lineQty, qty);
  if (errKey) {
    issueError.value = t(`admin.pages.receiving.${errKey}`, { qty: item.lineQty ?? "—" });
    return;
  }
  issueSubmitting.value = true;
  issueError.value = "";
  try {
    const body: { reason: string; mismatchQty?: number; wrongPartNo?: string; note?: string } = {
      reason: issueReason.value,
    };
    if (qty !== null) body.mismatchQty = qty;
    const wrongPartNo = issueWrongPartNo.value.trim();
    if (wrongPartNo) body.wrongPartNo = wrongPartNo;
    const note = issueNote.value.trim();
    if (note) body.note = note;
    await flow.reportReceivingMismatch(item.id, body);
    issueItem.value = null;
    await load();
    logsKey.value++;
  } catch (e: any) {
    issueError.value = e.message;
  } finally {
    issueSubmitting.value = false;
  }
}

// Per-item removal (only allowed by the backend while no work has started;
// a 409 item_work_started surfaces in the error banner as-is).
const removingItem = ref<Record<string, boolean>>({});

async function removeItem(item: ReceivingItemRow) {
  if (!window.confirm(t("admin.pages.receiving.removeItemConfirm", { partNo: item.partNo }))) return;
  removingItem.value[item.id] = true;
  error.value = "";
  try {
    await flow.removeReceivingItem(item.id);
    await load();
    logsKey.value++;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    delete removingItem.value[item.id];
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.receiving.detailTitle", { batchNo: order?.batchNo ?? "" }) }}</h1>
      <div class="head-actions">
        <!-- <button class="btn" disabled :title="$t('admin.common.downloadPendingTitle')">
          {{ $t("admin.pages.receiving.downloadDeliveryOrderList") }}
        </button> -->
        <button
          v-if="order && (order.status === 'in_hand')"
        class="btn" :disabled="downloadingPickingList || !order" @click="downloadPickingList">
          {{ $t("admin.pages.receiving.downloadPickingList") }}
        </button>
        <button
          v-if="order && (order.status === 'pending' || order.status === 'provisional_received')"
          class="btn btn-primary"
          :disabled="confirmingArrival"
          @click="confirmInHand"
        >
          {{ confirmingArrival ? $t("admin.common.saving") : $t("admin.pages.receiving.confirmInHand") }}
        </button>
        <NuxtLink to="/receiving" class="btn">{{ $t("admin.common.back") }}</NuxtLink>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="allocState" class="alloc-banner" :class="`alloc-${allocState}`">
      {{ $t(`admin.pages.receiving.allocation.${allocState}`) }}
    </div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <template v-else-if="order">
      <div class="detail-grid">
        <div><div class="dt">{{ $t("admin.pages.receiving.status") }}</div><div class="dd">{{ order.status }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.receiving.supplier") }}</div><div class="dd">{{ order.supplier?.name ?? "—" }}</div></div>
        <div>
          <div class="dt">{{ $t("admin.pages.receiving.deliveryDate") }}</div>
          <div class="dd date-edit">
            <input v-model="deliveryDate" type="date" />
            <button class="btn btn-small btn-primary" :disabled="savingDate" @click="saveDeliveryDate">
              {{ savingDate ? $t("admin.common.saving") : $t("admin.common.save") }}
            </button>
            <span v-if="dateMsg" class="muted">{{ $t("admin.pages.receiving.saved") }}</span>
          </div>
        </div>
        <div><div class="dt">{{ $t("admin.pages.receiving.orderDateCode") }}</div><div class="dd">{{ order.dateCode ?? "—" }}</div></div>
      </div>

      <div class="search-bar">
        <input
          v-model="invoiceFilter"
          type="search"
          class="search-input"
          :placeholder="$t('admin.pages.receiving.invoiceFilterPlaceholder')"
        />
        <select v-model="groupBy" class="group-by-select" :aria-label="$t('admin.pages.receiving.groupBy')">
          <option value="invoice">{{ $t("admin.pages.receiving.groupBy") }}: {{ $t("admin.pages.receiving.groupByInvoice") }}</option>
          <option value="ctnNo">{{ $t("admin.pages.receiving.groupBy") }}: {{ $t("admin.pages.receiving.groupByCarton") }}</option>
          <option value="item">{{ $t("admin.pages.receiving.groupBy") }}: {{ $t("admin.pages.receiving.groupByItem") }}</option>
        </select>
      </div>

      <div v-if="selected.size > 0" class="batch-bar">
        <span>{{ $t("admin.pages.receiving.selectedCount", { count: selected.size }) }}</span>
        <button class="btn btn-small btn-primary" @click="openBatchEdit">
          {{ $t("admin.pages.receiving.batchEdit") }}
        </button>
        <button class="btn btn-small" @click="selected = new Set()">
          {{ $t("admin.pages.receiving.clearSelection") }}
        </button>
      </div>

      <template v-for="group in groups" :key="group.key">
        <h2 class="section-title">
          <template v-if="group.invoice">
            {{ $t("admin.pages.receiving.invoiceTitle", { invoiceNo: group.invoice.invoiceNo }) }}
            <span class="muted">
              — {{ $t("admin.pages.receiving.orgSubInventory") }}: {{ group.invoice.orgId }}
              · {{ $t("admin.pages.receiving.itemsCount", { count: group.items.length })
              }}{{ group.invoice.deliveryDate ? $t("admin.pages.receiving.deliverySuffix", { date: new Date(group.invoice.deliveryDate).toLocaleDateString() }) : "" }}
            </span>
          </template>
          <template v-else-if="groupBy === 'ctnNo'">
            {{ $t("admin.pages.receiving.ctnGroupTitle", { ctnNo: group.key || "—" }) }}
            <span class="muted">— {{ $t("admin.pages.receiving.itemsCount", { count: group.items.length }) }}</span>
          </template>
          <template v-else>
            {{ $t("admin.pages.receiving.itemGroupTitle", { itemNo: group.key }) }}
            <span class="muted">— {{ $t("admin.pages.receiving.itemsCount", { count: group.items.length }) }}</span>
          </template>
        </h2>
        <DataTable
          :table="tableForGroup(group.key).table"
          v-model:selected="selected"
          selectable
          sync-scroll-key="receiving-detail-items"
          :empty-text="$t('admin.common.noRecords')"
          :on-reset-columns="tableForGroup(group.key).resetColumnState"
        >
          <template #cell-partNo="{ row }">
            {{ row.wclItemNo ?? row.partNo }}
            <div v-if="row.mismatch" class="mismatch-line">
              {{ $t("admin.pages.receiving.mismatch") }}: {{ row.mismatch.reason ?? "—"
              }}<template v-if="row.mismatch.mismatchQty != null"> × {{ row.mismatch.mismatchQty }}</template
              ><template v-if="row.mismatch.wrongPartNo"> — {{ row.mismatch.wrongPartNo }}</template
              ><template v-if="row.mismatch.note"> — {{ row.mismatch.note }}</template>
            </div>
          </template>
          <template #cell-poLine="{ row }">
            {{ row.poNo ?? "—" }}<span v-if="row.poLine"> / {{ row.poLine }}</span>
          </template>
          <template #actions="{ row }">
            <button class="btn btn-small" @click="openEdit(row)">
              {{ $t("admin.pages.receiving.editDetail") }}
            </button>
            <template v-if="row.mismatch">
              <button
                class="btn btn-small btn-primary"
                :disabled="!!mismatchActing[row.id]"
                @click="actMismatch(row, 'confirm')"
              >
                {{ mismatchActing[row.id] === "confirm" ? $t("admin.common.saving") : $t("admin.pages.issues.confirm") }}
              </button>
              <button
                class="btn btn-small"
                :disabled="!!mismatchActing[row.id]"
                @click="actMismatch(row, 'cancel')"
              >
                {{ mismatchActing[row.id] === "cancel" ? $t("admin.common.saving") : $t("admin.common.cancel") }}
              </button>
              <button
                class="btn btn-small"
                :disabled="!!removingItem[row.id]"
                @click="removeItem(row)"
              >
                {{ removingItem[row.id] ? $t("admin.common.saving") : $t("admin.pages.receiving.removeItem") }}
              </button>
            </template>
            <button v-else class="btn btn-small" @click="openIssueModal(row)">
              {{ $t("admin.pages.receiving.markIssue") }}
            </button>
          </template>
        </DataTable>
      </template>
      <p v-if="order.invoices.length === 0" class="muted">{{ $t("admin.pages.receiving.noInvoices") }}</p>
      <p v-else-if="groups.length === 0" class="muted">
        {{ $t("admin.pages.receiving.noInvoicesMatch") }}
      </p>

      <AuditLogTable :fetch-logs="fetchLogs" :refresh-key="logsKey" />
    </template>

    <div
      v-if="issueItem"
      class="overlay"
      @mousedown="issueDismiss.onMousedown"
      @click="issueDismiss.onClick"
    >
      <div class="dialog">
        <h2>{{ $t("admin.pages.receiving.issueModalTitle", { partNo: issueItem.partNo }) }}</h2>
        <div v-if="issueError" class="error-banner">{{ issueError }}</div>
        <form @submit.prevent="submitIssue">
          <div class="form-row">
            <label for="mi-reason">{{ $t("admin.pages.receiving.issueReason") }}</label>
            <select id="mi-reason" v-model="issueReason">
              <option value="" disabled>{{ $t("admin.pages.receiving.issueReasonPlaceholder") }}</option>
              <option v-for="r in MISMATCH_REASONS" :key="r" :value="r">{{ $t(`logStates.${r}`) }}</option>
            </select>
          </div>
          <div class="form-row">
            <label for="mi-qty">{{ $t("admin.pages.receiving.issueQty") }}</label>
            <input id="mi-qty" v-model="issueQtyInput" type="number" min="0" step="1" />
            <div class="hint">{{ $t("admin.pages.receiving.issueQtyHint", { qty: issueItem.lineQty ?? "—" }) }}</div>
          </div>
          <div class="form-row">
            <label for="mi-wrong">{{ $t("admin.pages.receiving.issueWrongPartNo") }}</label>
            <input id="mi-wrong" v-model="issueWrongPartNo" type="text" />
          </div>
          <div class="form-row">
            <label for="mi-note">{{ $t("admin.pages.receiving.issueNote") }}</label>
            <input id="mi-note" v-model="issueNote" type="text" />
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn" @click="issueItem = null">{{ $t("admin.common.cancel") }}</button>
            <button type="submit" class="btn btn-primary" :disabled="issueSubmitting">
              {{ issueSubmitting ? $t("admin.common.saving") : $t("admin.pages.receiving.issueSubmit") }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <ReceivingItemEditModal
      v-if="editItems"
      :items="editItems"
      :saving="savingEdit"
      @close="editItems = null"
      @save="saveEdit"
    />
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 10px;
}
.section-title {
  font-size: 15px;
  margin: 18px 0 8px;
  color: #52606d;
}
.batch-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0;
  padding: 8px 10px;
  background: #eef2f7;
  border: 1px solid #d5dee7;
  border-radius: 6px;
}
.date-edit {
  display: flex;
  align-items: center;
  gap: 8px;
}
.date-edit input {
  padding: 5px 7px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
}
.mismatch-line {
  color: #b91c1c;
  font-size: 12px;
  margin-top: 2px;
}
.group-by-select {
  padding: 7px 9px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
  font-size: 14px;
}
.search-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 0;
}
:deep(td.actions) .btn {
  margin: 0 6px 4px 0;
}
.alloc-banner {
  margin-bottom: 12px;
  padding: 9px 12px;
  border-radius: 6px;
  font-size: 14px;
}
.alloc-running {
  background: #fff8e6;
  border: 1px solid #f0dca0;
  color: #8a6d1a;
}
.alloc-done {
  background: #e9f7ef;
  border: 1px solid #b5e2c8;
  color: #1e7a46;
}
.alloc-slow {
  background: #eef2f7;
  border: 1px solid #d5dee7;
  color: #52606d;
}
</style>
