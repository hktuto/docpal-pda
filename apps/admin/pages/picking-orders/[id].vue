<script setup lang="ts">
// Picking-order detail page (staged-views refactor, spec
// docs/superpowers/specs/2026-11-12-picking-order-detail-staged-views-design.md):
// the page keeps the global chrome — page-head actions, the flow-config-aware
// progress header, SSE change notice, override/reset/print dialogs — and
// renders a status-driven body view below the header. Currently every status
// renders the same `detail` placeholder view (OrderDetailView); focused
// per-stage views (allocation / progress / summary) are added to `stageViews`
// later, one per status.
import type { PickingOrderDetail } from "~/utils/flowApi";
import OrderDetailView from "~/components/picking-orders/OrderDetailView.vue";
import PickingFinishedView from "~/components/picking-orders/PickingFinishedView.vue";
import { buildPickingScanAoa } from "~/utils/pickingScanExcel";

const route = useRoute();
const { t } = useI18n();
const orderId = route.params.id as string;
const flow = useFlowApi();

const order = ref<PickingOrderDetail | null>(null);
const loading = ref(true);
const error = ref("");
const logsKey = ref(0);

// Status → body view. Each entry is a focused stage view; statuses without
// one yet fall back to the `detail` placeholder.
const stageViews = { detail: OrderDetailView, pickingFinished: PickingFinishedView } as const;
const viewForStatus = (status: string): keyof typeof stageViews =>
  status === "picking_finished" || status === "measuring_finished" ? "pickingFinished" : "detail";
const activeView = computed(() => stageViews[viewForStatus(order.value?.status ?? "")]);

// Progress header: stages filtered by the warehouse flow config (mirrored
// from GET /config's flowSteps — app.vue loads the shared singleton).
const { steps: flowSteps } = useFlowSteps();

// Body-view ref: the placeholder exposes `changeBusy` (SSE reload guard) and
// the stage-action handlers driven by the page-head buttons.
const viewEl = ref<{
  changeBusy: boolean;
  reallocating: boolean;
  confirmingAllocation: boolean;
  reallocate: () => Promise<void>;
  openReportModal: () => void;
  confirmAllocation: () => Promise<void>;
} | null>(null);

// Stage actions — status-specific shortcuts rendered in the page head but
// executed inside the body view (which owns the handlers + modals).
const stageActionVisible = computed(() =>
  !!order.value && ["pending", "picking", "allocated"].includes(order.value.status)
);

// Page-head mutations and body mutations both reload the order and bump the
// audit-log key — the view receives this as its `refresh` prop.
async function refresh() {
  order.value = await flow.getPickingOrder(orderId);
  logsKey.value++;
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    order.value = await flow.getPickingOrder(orderId);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

// Picking-list xlsx download (backend-generated; read-only — reflects current
// allocations, no in-request recompute, so no reload afterwards).
const apiBaseUrl = useRuntimeConfig().public.apiBaseUrl as string;
const downloadingPickingList = ref(false);
// Picked-scan Excel (picking_finished view): one row per package in scan
// order — util builds the AOA, XLSX writes it client-side.
const dateCodeFormat = useDateCodeFormat();
const downloadingScanExcel = ref(false);
async function downloadScanExcel() {
  if (!order.value || downloadingScanExcel.value) return;
  downloadingScanExcel.value = true;
  error.value = "";
  try {
    const XLSX = await import("xlsx");
    const aoa = buildPickingScanAoa({ order: order.value, dateCodeFormat: dateCodeFormat.format.value });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "scan");
    XLSX.writeFile(wb, `picking-scan-${order.value.orderNo}.xlsx`);
  } catch (e: any) {
    error.value = `${t("admin.pages.pickingOrders.pickingListError")}: ${e.message}`;
  } finally {
    downloadingScanExcel.value = false;
  }
}
// PNG print of the same picking list (CR-049) — the dialog fetches the
// picking-list document + renders/prints it; build errors surface there.
const printOpen = ref(false);
async function buildPrintDoc() {
  const { getPickingListDocument } = await import("~/utils/flowApi");
  const { pickingListDocToPrintDoc } = await import("~/utils/documentPrintPicking");
  return pickingListDocToPrintDoc(await getPickingListDocument(orderId));
}

async function downloadPickingList() {
  if (!order.value || downloadingPickingList.value) return;
  downloadingPickingList.value = true;
  error.value = "";
  try {
    const token = localStorage.getItem("admin_token");
    const res = await fetch(`${apiBaseUrl}/admin/picking-orders/${orderId}/picking-list`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) throw new Error((await res.text()).trim() || `Request failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `picking-list-${order.value.orderNo}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e: any) {
    error.value = `${t("admin.pages.pickingOrders.pickingListError")}: ${e.message}`;
  } finally {
    downloadingPickingList.value = false;
  }
}

// "Override status" modal (spec 2026-09-17): admin sets the order to any of
// pending/picking/issue/picking_finished/measuring_finished/shipped — no
// transition guards; a live PDA work lock is force-cleared and leftover
// allocations released when closing.
const overrideOpen = ref(false);

async function onOverrideStatus(payload: { status: string; reason: string }) {
  error.value = "";
  try {
    await flow.overridePickingOrderStatus(orderId, payload.status, payload.reason);
    overrideOpen.value = false;
    await refresh();
  } catch (e: any) {
    error.value = e.message;
  }
}

// "Reset order": wipe picked/boxed progress (packages, boxes) back to the
// initial state, KEEPING allocations (spec
// 2026-11-07-admin-order-reset-design.md). Not offered once shipped.
const resetting = ref(false);

async function resetOrder() {
  if (!order.value || resetting.value) return;
  if (!window.confirm(t("admin.pages.pickingOrders.resetOrderConfirm", { orderNo: order.value.orderNo }))) return;
  resetting.value = true;
  error.value = "";
  try {
    await flow.resetPickingOrder(orderId);
    await refresh();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    resetting.value = false;
  }
}

onMounted(load);

// Reload when the order changes elsewhere (PDA picks, issue reports,
// allocation, outdated-warning create/resolve).
// Busy while a modal is open (body view's or the page's own): banner instead
// of a silent reload.
const changeBusy = computed(() => !!(viewEl.value?.changeBusy ?? false) || overrideOpen.value);
const {
  pending: changePending,
  justUpdated: changeUpdated,
  refreshNow,
  dismiss,
} = useChangeNotice(
  [
    "picking_order.created",
    "picking_order.updated",
    "picking_order.deleted",
    "picking.reordered",
    "allocation.computed",
    "outdated.warning.created",
    "outdated.warning.resolved",
  ],
  async () => {
    await refresh();
  },
  { busy: changeBusy }
);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ order?.orderNo ?? ""}}</h1>
      <OutdatedWarningChip class="head-chip" :count="order?.outdatedWarningCount ?? 0" order-kind="picking" />
      <div class="head-actions">
        <button class="btn" :disabled="downloadingPickingList" @click="downloadPickingList">
          {{ $t("admin.pages.pickingOrders.downloadPickingList") }}
        </button>
        <button
          v-if="order && (order.status === 'picking_finished' || order.status === 'measuring_finished')"
          class="btn"
          :disabled="downloadingScanExcel"
          @click="downloadScanExcel"
        >
          {{ $t("admin.pages.pickingOrders.downloadScanExcel") }}
        </button>
        <button class="btn" :disabled="!order" @click="printOpen = true">
          {{ $t("admin.pages.pickingOrders.printPng") }}
        </button>
        <button
          v-if="stageActionVisible"
          class="btn"
          :disabled="!viewEl || viewEl.reallocating"
          @click="viewEl?.reallocate()"
        >
          {{ viewEl?.reallocating ? $t("admin.common.saving") : $t("admin.pages.pickingOrders.reallocate") }}
        </button>
        <button
          v-if="stageActionVisible"
          class="btn"
          :disabled="!viewEl"
          @click="viewEl?.openReportModal()"
        >
          {{ $t("admin.pages.pickingOrders.reportIssue") }}
        </button>
        <button
          v-if="order && order.status === 'pending'"
          class="btn btn-primary"
          :disabled="!viewEl || viewEl.confirmingAllocation"
          @click="viewEl?.confirmAllocation()"
        >
          {{ viewEl?.confirmingAllocation ? $t("admin.common.saving") : $t("admin.pages.pickingOrders.confirmAllocation") }}
        </button>
        <button class="btn" @click="overrideOpen = true">
          {{ $t("admin.pages.pickingOrders.overrideStatus") }}
        </button>
        <button
          v-if="order && order.status !== 'shipped'"
          class="btn"
          :disabled="resetting"
          @click="resetOrder"
        >
          {{ resetting ? $t("admin.common.saving") : $t("admin.pages.pickingOrders.resetOrder") }}
        </button>
        <NuxtLink to="/picking-orders" class="btn">{{ $t("admin.common.back") }}</NuxtLink>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <ChangeNotice :pending="changePending" :just-updated="changeUpdated" @refresh="refreshNow" @dismiss="dismiss" />
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <template v-else-if="order">
      <!-- Progress header: stage pipeline filtered by flow config. -->
      <PickingOrdersOrderProgressHeader
        :status="order.status"
        :label-printing-enabled="flowSteps['label-printing'] !== false"
        :labeling-enabled="flowSteps.labeling !== false"
        :verify-enabled="flowSteps.measuring !== false || flowSteps.verify !== false"
        :label-printing-done="!order.labelPrintingPending"
        :labeling-done="!order.labelingPending"
      />

      <!-- Status-driven body view (placeholder for every status for now). -->
      <component
        :is="activeView"
        ref="viewEl"
        :order="order"
        :logs-key="logsKey"
        :refresh="refresh"
      />
    </template>

    <PickingOrdersStatusOverrideModal
      :open="overrideOpen"
      :order-nos="order ? [order.orderNo] : []"
      :current-statuses="order ? [order.status] : []"
      @close="overrideOpen = false"
      @apply="onOverrideStatus"
    />
    <PrintDocumentDialog
      v-if="printOpen && order"
      :build="buildPrintDoc"
      :filename-base="`picking-list-${order.orderNo}`"
      @close="printOpen = false"
    />
  </div>
</template>

<style scoped>
.head-chip {
  margin-right: auto;
  margin-left: 0.75rem;
}
.head-actions {
  display: flex;
  gap: 0.625rem;
}
</style>
