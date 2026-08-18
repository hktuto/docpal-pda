<script setup lang="ts">
import type { PickingOrderDetail, TransactionLogRow } from "~/utils/flowApi";

const route = useRoute();
const orderId = route.params.id as string;
const flow = useFlowApi();
const { t } = useI18n();

const order = ref<PickingOrderDetail | null>(null);
const logs = ref<TransactionLogRow[]>([]);
const loading = ref(true);
const error = ref("");

const deliveryDate = ref("");
const savingDate = ref(false);
const dateMsg = ref("");

// Issue resolution (status === 'issue'): optional note, then back to pending.
const resolvingIssue = ref(false);

// "Report issue" modal: admin-side picking issue report (mirrors the PDA's
// PickingIssueReportModal for a single order; merge is PDA-only since it
// needs a multi-order selection).
const PICKING_ISSUE_REASONS = ["insufficient_stock", "cannot_divide", "other"] as const;

const reportOpen = ref(false);
const reportReason = ref("");
const reportQtyInput = ref("");
const reportPackSizeInput = ref("");
const reportNote = ref("");
const reportRemark = ref("");
const reportError = ref("");
const reportSubmitting = ref(false);
const reportDismiss = useOverlayDismiss(() => (reportOpen.value = false));

const totalQty = computed(() => (order.value?.items ?? []).reduce((sum, i) => sum + i.qty, 0));

function openReportModal() {
  reportReason.value = "";
  reportQtyInput.value = "";
  reportPackSizeInput.value = "";
  reportNote.value = "";
  reportRemark.value = "";
  reportError.value = "";
  reportOpen.value = true;
}

// Returns an admin.pages.pickingOrders.reportErr* key, or null when valid.
function validateReport(): string | null {
  const reason = reportReason.value;
  if (!reason) return "reportErrReasonRequired";
  if (reason === "insufficient_stock") {
    const qty = reportQtyInput.value.trim() === "" ? null : Number(reportQtyInput.value);
    if (qty === null || !Number.isInteger(qty) || qty < 0) return "reportErrQtyRequired";
    if (qty >= totalQty.value) return "reportErrQtyExceedsRequested";
  }
  if (reason === "cannot_divide") {
    const packSize = reportPackSizeInput.value.trim() === "" ? null : Number(reportPackSizeInput.value);
    if (packSize === null || !Number.isInteger(packSize) || packSize <= 0) return "reportErrPackSizeRequired";
  }
  return null;
}

async function submitReport() {
  const errKey = validateReport();
  if (errKey) {
    reportError.value = t(`admin.pages.pickingOrders.${errKey}`, { qty: totalQty.value });
    return;
  }
  reportSubmitting.value = true;
  reportError.value = "";
  try {
    const entry: { reason: string; qty?: number; packSize?: number; note?: string; remark?: string } = {
      reason: reportReason.value,
    };
    if (reportReason.value === "insufficient_stock") entry.qty = Number(reportQtyInput.value);
    if (reportReason.value === "cannot_divide") entry.packSize = Number(reportPackSizeInput.value);
    const note = reportNote.value.trim();
    if (note) entry.note = note;
    const remark = reportRemark.value.trim();
    if (remark) entry.remark = remark;
    await flow.reportPickingIssue(orderId, entry);
    reportOpen.value = false;
    await load();
  } catch (e: any) {
    reportError.value = e.message;
  } finally {
    reportSubmitting.value = false;
  }
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [detail, logRows] = await Promise.all([
      flow.getPickingOrder(orderId),
      flow.listPickingOrderLogs(orderId),
    ]);
    order.value = detail;
    logs.value = logRows;
    deliveryDate.value = order.value.deliveryDate ? order.value.deliveryDate.slice(0, 10) : "";
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
    await flow.updatePickingDeliveryDate(orderId, deliveryDate.value || null);
    await load();
    dateMsg.value = "saved";
  } catch (e: any) {
    error.value = e.message;
  } finally {
    savingDate.value = false;
  }
}

async function resolveIssue() {
  const note = window.prompt(t("admin.pages.pickingOrders.resolvePrompt"));
  if (note === null) return;
  resolvingIssue.value = true;
  error.value = "";
  try {
    await flow.resolvePickingIssue(orderId, note);
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    resolvingIssue.value = false;
  }
}

function allocationSource(a: PickingOrderDetail["items"][number]["allocations"][number]): string {
  if (a.lot)
    return t("admin.pages.pickingOrders.allocLot", {
      shelf: a.lot.shelfCode ?? "",
      box: a.lot.boxId ? ` / ${a.lot.boxId}` : "",
      dc: a.lot.dateCode ?? "—",
    });
  if (a.receivingInvoiceItemId) return t("admin.pages.pickingOrders.allocReceivingBox", { box: a.boxId ?? "" });
  if (a.receivingOrderId) return t("admin.pages.pickingOrders.allocReceivingOrder");
  return "—";
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.pickingOrders.detailTitle", { orderNo: order?.orderNo ?? "" }) }}</h1>
      <div class="head-actions">
        <button class="btn" disabled :title="$t('admin.common.downloadPendingTitle')">
          {{ $t("admin.pages.pickingOrders.downloadPackingList") }}
        </button>
        <button class="btn" disabled :title="$t('admin.common.downloadPendingTitle')">
          {{ $t("admin.pages.pickingOrders.downloadTN") }}
        </button>
        <button
          v-if="order && (order.status === 'pending' || order.status === 'picking')"
          class="btn"
          @click="openReportModal"
        >
          {{ $t("admin.pages.pickingOrders.reportIssue") }}
        </button>
        <NuxtLink to="/picking-orders" class="btn">{{ $t("admin.common.back") }}</NuxtLink>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <template v-else-if="order">
      <div class="detail-grid">
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.status") }}</div><div class="dd">{{ order.status }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.customer") }}</div><div class="dd">{{ order.customerCode ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.poNo") }}</div><div class="dd">{{ order.poNo ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.shipTo") }}</div><div class="dd">{{ order.shipTo ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.orgSubInventory") }}</div><div class="dd">{{ order.orgId ?? "—" }} / {{ order.subInventoryCode ?? "—" }}</div></div>
        <div>
          <div class="dt">{{ $t("admin.pages.pickingOrders.deliveryDate") }}</div>
          <div class="dd date-edit">
            <input v-model="deliveryDate" type="date" />
            <button class="btn btn-small btn-primary" :disabled="savingDate" @click="saveDeliveryDate">
              {{ savingDate ? $t("admin.common.saving") : $t("admin.common.save") }}
            </button>
            <span v-if="dateMsg" class="muted">{{ $t("admin.pages.pickingOrders.saved") }}</span>
          </div>
        </div>
      </div>

      <template v-if="order.status === 'issue'">
        <h2 class="section-title">{{ $t("admin.pages.pickingOrders.issue") }}</h2>
        <div class="detail-grid">
          <div><div class="dt">{{ $t("admin.pages.pickingOrders.issueReason") }}</div><div class="dd">{{ order.issueReason ?? "—" }}</div></div>
          <div><div class="dt">{{ $t("admin.pages.pickingOrders.issueQty") }}</div><div class="dd">{{ order.issueQty ?? "—" }}</div></div>
          <div><div class="dt">{{ $t("admin.pages.pickingOrders.issuePackSize") }}</div><div class="dd">{{ order.issuePackSize ?? "—" }}</div></div>
          <div><div class="dt">{{ $t("admin.pages.pickingOrders.issueNote") }}</div><div class="dd">{{ order.issueNote ?? "—" }}</div></div>
          <div><div class="dt">{{ $t("admin.pages.pickingOrders.issueRemark") }}</div><div class="dd">{{ order.issueRemark ?? "—" }}</div></div>
          <div><div class="dt">{{ $t("admin.pages.pickingOrders.issueReportedAt") }}</div><div class="dd">{{ order.issueReportedAt ? new Date(order.issueReportedAt).toLocaleString() : "—" }}</div></div>
          <div><div class="dt">{{ $t("admin.pages.pickingOrders.issueReportedBy") }}</div><div class="dd">{{ order.issueReportedByName ?? order.issueReportedBy ?? "—" }}</div></div>
          <div>
            <button class="btn btn-small btn-primary" :disabled="resolvingIssue" @click="resolveIssue">
              {{ resolvingIssue ? $t("admin.common.saving") : $t("admin.pages.pickingOrders.resolveIssue") }}
            </button>
          </div>
        </div>
      </template>

      <h2 class="section-title">{{ $t("admin.pages.pickingOrders.items") }}</h2>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("admin.fields.partNo") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.line") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.required") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.allocated") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.picked") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.allocations") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.packages") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in order.items" :key="item.id">
              <td>{{ item.partNo }}<span v-if="item.wclItemNo" class="muted"> ({{ item.wclItemNo }})</span></td>
              <td>{{ item.lineNumber ?? "—" }} / {{ item.shipmentNumber ?? "—" }}</td>
              <td>{{ item.qty }}</td>
              <td>{{ item.allocatedQty }}</td>
              <td>{{ item.pickedQty }}</td>
              <td>
                <div v-for="a in item.allocations" :key="a.id">{{ a.qty }} × {{ allocationSource(a) }}</div>
                <span v-if="item.allocations.length === 0" class="muted">—</span>
              </td>
              <td>
                <div v-for="p in item.packages" :key="p.id">
                  {{ p.qty }} (dc {{ p.dateCode ?? "—"
                  }}{{ p.shippingBoxId ? `, ${$t("admin.pages.pickingOrders.boxed")}` : `, ${$t("admin.pages.pickingOrders.unboxed")}`
                  }}{{ p.verified ? `, ${$t("admin.pages.pickingOrders.verified")}` : "" }})
                </div>
                <span v-if="item.packages.length === 0" class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 class="section-title">{{ $t("admin.pages.pickingOrders.shippingBoxes") }}</h2>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("admin.pages.pickingOrders.boxId") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.status") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.size") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.netGross") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.destination") }}</th>
              <th>{{ $t("admin.pages.pickingOrders.packages") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in order.boxes" :key="b.id">
              <td>{{ b.id }}</td>
              <td>
                {{ b.status }}
                <div v-if="b.shippedAt" class="muted">{{ new Date(b.shippedAt).toLocaleDateString() }}</div>
              </td>
              <td>{{ b.boxSize ?? "—" }}</td>
              <td>{{ b.netWeight ?? "—" }} / {{ b.grossWeight ?? "—" }}</td>
              <td>{{ b.destinationCountry ?? "—" }}</td>
              <td>{{ b.packageCount }}</td>
            </tr>
            <tr v-if="order.boxes.length === 0">
              <td colspan="6" class="muted">{{ $t("admin.pages.pickingOrders.noBoxes") }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <AuditLogTable :logs="logs" />
    </template>

    <div
      v-if="reportOpen"
      class="overlay"
      @mousedown="reportDismiss.onMousedown"
      @click="reportDismiss.onClick"
    >
      <div class="dialog">
        <h2>{{ $t("admin.pages.pickingOrders.reportModalTitle", { orderNo: order?.orderNo ?? "" }) }}</h2>
        <div v-if="reportError" class="error-banner">{{ reportError }}</div>
        <form @submit.prevent="submitReport">
          <div class="form-row">
            <label for="pi-reason">{{ $t("admin.pages.pickingOrders.issueReason") }}</label>
            <select id="pi-reason" v-model="reportReason">
              <option value="" disabled>{{ $t("admin.pages.pickingOrders.reportReasonPlaceholder") }}</option>
              <option v-for="r in PICKING_ISSUE_REASONS" :key="r" :value="r">{{ $t(`picking.issueReasons.${r}`) }}</option>
            </select>
          </div>
          <div v-if="reportReason === 'insufficient_stock'" class="form-row">
            <label for="pi-qty">{{ $t("admin.pages.pickingOrders.reportQty") }}</label>
            <input id="pi-qty" v-model="reportQtyInput" type="number" min="0" step="1" />
            <div class="hint">{{ $t("admin.pages.pickingOrders.reportQtyHint", { qty: totalQty }) }}</div>
          </div>
          <div v-if="reportReason === 'cannot_divide'" class="form-row">
            <label for="pi-pack">{{ $t("admin.pages.pickingOrders.reportPackSize") }}</label>
            <input id="pi-pack" v-model="reportPackSizeInput" type="number" min="1" step="1" />
          </div>
          <div class="form-row">
            <label for="pi-note">{{ $t("admin.pages.pickingOrders.reportNote") }}</label>
            <input id="pi-note" v-model="reportNote" type="text" />
          </div>
          <div class="form-row">
            <label for="pi-remark">{{ $t("admin.pages.pickingOrders.reportRemark") }}</label>
            <input id="pi-remark" v-model="reportRemark" type="text" />
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn" @click="reportOpen = false">{{ $t("admin.common.cancel") }}</button>
            <button type="submit" class="btn btn-primary" :disabled="reportSubmitting">
              {{ reportSubmitting ? $t("admin.common.saving") : $t("admin.pages.pickingOrders.reportSubmit") }}
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
</style>
