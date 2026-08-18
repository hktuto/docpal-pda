<script setup lang="ts">
import type { ReceivingOrderDetail, ReceivingItemRow, TransactionLogRow } from "~/utils/flowApi";

const route = useRoute();
const orderId = route.params.id as string;
const flow = useFlowApi();
const { t } = useI18n();

const order = ref<ReceivingOrderDetail | null>(null);
const logs = ref<TransactionLogRow[]>([]);
const loading = ref(true);
const error = ref("");

// Order-level delivery-date editing (mirrors the picking-orders detail page).
const deliveryDate = ref("");
const savingDate = ref(false);
const dateMsg = ref("");

// Per-item inline date-code editing.
const editDateCode = ref<Record<string, string>>({});
const savingItem = ref<Record<string, boolean>>({});
const savedItem = ref<Record<string, boolean>>({});

// Client-side invoice filter: an invoice matches when its invoiceNo contains
// the keyword (all items shown) or any item's partNo/wclItemNo/poNo does.
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
        (it.poNo ?? "").toLowerCase().includes(needle)
    );
    if (items.length > 0) out.push({ ...i, items });
  }
  return out;
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [detail, logRows] = await Promise.all([
      flow.getReceivingOrder(orderId),
      flow.listReceivingOrderLogs(orderId),
    ]);
    order.value = detail;
    logs.value = logRows;
    deliveryDate.value = order.value.deliveryDate ? order.value.deliveryDate.slice(0, 10) : "";
    const map: Record<string, string> = {};
    for (const inv of order.value.invoices) {
      for (const item of inv.items) map[item.id] = item.dateCode ?? "";
    }
    editDateCode.value = map;
    savedItem.value = {};
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
    dateMsg.value = "saved";
  } catch (e: any) {
    error.value = e.message;
  } finally {
    savingDate.value = false;
  }
}

async function saveDateCode(item: ReceivingItemRow) {
  savingItem.value[item.id] = true;
  error.value = "";
  try {
    const v = (editDateCode.value[item.id] ?? "").trim();
    await flow.updateReceivingItemDateCode(item.id, v || null);
    savedItem.value[item.id] = true;
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    savingItem.value[item.id] = false;
  }
}

// Per-item mismatch confirm/cancel (same semantics as the Issues page).
const mismatchActing = ref<Record<string, string>>({});

async function actMismatch(item: ReceivingItemRow, action: "confirm" | "cancel") {
  mismatchActing.value[item.id] = action;
  error.value = "";
  try {
    if (action === "confirm") await flow.confirmReceivingMismatch(item.id);
    else await flow.cancelReceivingMismatch(item.id);
    await load();
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
        <button class="btn" disabled :title="$t('admin.common.downloadPendingTitle')">
          {{ $t("admin.pages.receiving.downloadDeliveryOrderList") }}
        </button>
        <button class="btn" disabled :title="$t('admin.common.downloadPendingTitle')">
          {{ $t("admin.pages.receiving.downloadPickingList") }}
        </button>
        <NuxtLink to="/receiving" class="btn">{{ $t("admin.common.back") }}</NuxtLink>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
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
      </div>

      <template v-for="inv in filteredInvoices" :key="inv.id">
        <h2 class="section-title">
          {{ $t("admin.pages.receiving.invoiceTitle", { invoiceNo: inv.invoiceNo }) }}
          <span class="muted">
            — {{ $t("admin.pages.receiving.orgSubInventory") }}: {{ inv.orgId }}
            · {{ $t("admin.pages.receiving.itemsCount", { count: inv.items.length })
            }}{{ inv.deliveryDate ? $t("admin.pages.receiving.deliverySuffix", { date: new Date(inv.deliveryDate).toLocaleDateString() }) : "" }}
          </span>
        </h2>
        <div class="table-wrap">
          <table class="data invoice-table">
            <colgroup>
              <col class="col-part" />
              <col class="col-po" />
              <col class="col-qty" />
              <col class="col-qty" />
              <col class="col-qty" />
              <col class="col-qty" />
              <col class="col-ctn" />
              <col class="col-dc" />
              <col class="col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th>{{ $t("admin.pages.receiving.partNo") }}</th>
                <th>{{ $t("admin.pages.receiving.poLine") }}</th>
                <th>{{ $t("admin.pages.receiving.expected") }}</th>
                <th>{{ $t("admin.pages.receiving.received") }}</th>
                <th>{{ $t("admin.pages.receiving.putAway") }}</th>
                <th>{{ $t("admin.pages.receiving.allocated") }}</th>
                <th>{{ $t("admin.pages.receiving.ctnNo") }}</th>
                <th>{{ $t("admin.pages.receiving.dateCode") }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in inv.items" :key="item.id">
                <td class="wrap">
                  {{ item.partNo }}<span v-if="item.wclItemNo" class="muted"> ({{ item.wclItemNo }})</span>
                  <div v-if="item.mismatch" class="mismatch-line">
                    {{ $t("admin.pages.receiving.mismatch") }}: {{ item.mismatch.reason ?? "—"
                    }}<template v-if="item.mismatch.mismatchQty != null"> × {{ item.mismatch.mismatchQty }}</template
                    ><template v-if="item.mismatch.wrongPartNo"> — {{ item.mismatch.wrongPartNo }}</template
                    ><template v-if="item.mismatch.note"> — {{ item.mismatch.note }}</template>
                  </div>
                </td>
                <td class="wrap">{{ item.poNo ?? "—" }}<span v-if="item.poLine"> / {{ item.poLine }}</span></td>
                <td>{{ item.lineQty ?? "—" }}</td>
                <td>{{ item.receivedQty }}</td>
                <td>{{ item.putAwayQty }}</td>
                <td>{{ item.allocatedQty }}</td>
                <td>{{ item.ctnNo ?? "—" }}</td>
                <td>
                  <input
                    v-model="editDateCode[item.id]"
                    class="dc-input"
                    placeholder="—"
                    @keyup.enter="saveDateCode(item)"
                  />
                </td>
                <td class="actions">
                  <button
                    class="btn btn-small btn-primary"
                    :disabled="savingItem[item.id]"
                    @click="saveDateCode(item)"
                  >
                    {{ savingItem[item.id] ? $t("admin.common.saving") : $t("admin.common.save") }}
                  </button>
                  <span v-if="savedItem[item.id]" class="muted">{{ $t("admin.pages.receiving.saved") }}</span>
                  <template v-if="item.mismatch">
                    <button
                      class="btn btn-small btn-primary"
                      :disabled="!!mismatchActing[item.id]"
                      @click="actMismatch(item, 'confirm')"
                    >
                      {{ mismatchActing[item.id] === "confirm" ? $t("admin.common.saving") : $t("admin.pages.issues.confirm") }}
                    </button>
                    <button
                      class="btn btn-small"
                      :disabled="!!mismatchActing[item.id]"
                      @click="actMismatch(item, 'cancel')"
                    >
                      {{ mismatchActing[item.id] === "cancel" ? $t("admin.common.saving") : $t("admin.common.cancel") }}
                    </button>
                    <button
                      class="btn btn-small"
                      :disabled="!!removingItem[item.id]"
                      @click="removeItem(item)"
                    >
                      {{ removingItem[item.id] ? $t("admin.common.saving") : $t("admin.pages.receiving.removeItem") }}
                    </button>
                  </template>
                  <button v-else class="btn btn-small" @click="openIssueModal(item)">
                    {{ $t("admin.pages.receiving.markIssue") }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <p v-if="order.invoices.length === 0" class="muted">{{ $t("admin.pages.receiving.noInvoices") }}</p>
      <p v-else-if="filteredInvoices.length === 0" class="muted">
        {{ $t("admin.pages.receiving.noInvoicesMatch") }}
      </p>

      <AuditLogTable :logs="logs" />
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
.dc-input {
  width: 90px;
  padding: 5px 7px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
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
/* Fixed layout + identical colgroup keeps every invoice table's columns aligned. */
.invoice-table {
  table-layout: fixed;
}
.col-part {
  width: 22%;
}
.col-po {
  width: 11%;
}
.col-qty {
  width: 8%;
}
.col-ctn {
  width: 9%;
}
.col-dc {
  width: 11%;
}
.col-actions {
  width: 15%;
}
.invoice-table th {
  white-space: normal;
  padding: 8px 6px;
  font-size: 11px;
  letter-spacing: 0;
}
.invoice-table td.wrap {
  white-space: normal;
  overflow-wrap: anywhere;
}
td.actions .btn {
  margin: 0 6px 4px 0;
}
</style>
