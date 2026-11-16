<script setup lang="ts">
// picking_finished / measuring_finished view (staged-views refactor, spec
// docs/superpowers/specs/2026-11-12-picking-order-detail-staged-views-design.md):
// a summary of what was actually picked — per-package REAL scan data (the
// scanned batch fields, re-scan credit, source label barcode), which shipping
// box each package went into, and per-box measuring / verify assignees.
// Allocation columns are intentionally absent here — see AllocationView.
import type { AdminColumnDef } from "~/composables/useAdminTable";
import type { OrderLogsParams, OrderLogsPage, PickingOrderDetail } from "~/utils/flowApi";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

const props = defineProps<{
  order: PickingOrderDetail;
  /** Audit-log refresh key — bumped by page-level mutations too. */
  logsKey: number;
  /** Reload the order (and the page's audit-log key) after a mutation. */
  refresh: () => Promise<void>;
}>();

const { t } = useI18n();
// Packages store canonical YYWW — formatDcLabel converts to the
// label/operator format for display.
const { formatLabel: formatDcLabel } = useDateCodeDisplay();

const route = useRoute();
const orderId = route.params.id as string;
const flow = useFlowApi();
const error = ref("");

// The audit-log table fetches itself; the page bumps logsKey after
// mutations that write logs (both view-internal and page-head actions).
const fetchLogs = (p: OrderLogsParams): Promise<OrderLogsPage> => flow.listPickingOrderLogs(orderId, p);

// Shared per-step assignee pickers (measuring / verify per box here).
const { assigneeOptions, assigneeSaving, assigneeValue, saveStepAssignee, initFromOrder, loadUsers } = useStepAssignees(orderId);
function onAssigneeSaved() {
  error.value = "";
  return props.refresh();
}

// ---------------------------------------------------------------------------
// Summary stats
// ---------------------------------------------------------------------------

const activeItems = computed(() => (props.order.items ?? []).filter((i) => i.status !== "cancelled"));
const requiredQty = computed(() => activeItems.value.reduce((sum, i) => sum + i.qty, 0));
const pickedQty = computed(() => activeItems.value.reduce((sum, i) => sum + i.pickedQty, 0));
const allPackages = computed(() => activeItems.value.flatMap((i) => i.packages ?? []));
const reScannedQty = computed(() => allPackages.value.reduce((sum, p) => sum + (p.rescannedQty ?? 0), 0));
const boxCount = computed(() => (props.order.boxes ?? []).length);
const verifiedPackageCount = computed(() => allPackages.value.filter((p) => p.verified).length);

const stats = computed(() => [
  { label: t("admin.pages.pickingOrders.pickingFinished.statRequired"), value: `${pickedQty.value} / ${requiredQty.value}` },
  { label: t("admin.pages.pickingOrders.pickingFinished.statPackages"), value: String(allPackages.value.length) },
  { label: t("admin.pages.pickingOrders.pickingFinished.statBoxes"), value: String(boxCount.value) },
  {
    label: t("admin.pages.pickingOrders.pickingFinished.statRescanned"),
    value: `${reScannedQty.value} / ${requiredQty.value}`,
  },
  {
    label: t("admin.pages.pickingOrders.pickingFinished.statVerified"),
    value: `${verifiedPackageCount.value} / ${allPackages.value.length}`,
  },
]);

// Packing record (打包, specs 2026-11-10 + 2026-11-16): once packaged the
// summary shows the PACKAGING figures instead of the scan stats — the record
// as entered at the packaging confirm (box mode: packing-record box count vs
// the scanned auto count; cart mode: the per-cart rows).
const packaged = computed(() => !!props.order.packagedAt);
const packingRows = computed<{ label: string; value: string }[]>(() => {
  const o = props.order;
  if (!o.packagedAt) return [];
  const rows = [
    { label: t("admin.pages.pickingOrders.packingRecord.weight"), value: `${o.packedWeight ?? "—"} kg` },
    { label: t("admin.pages.pickingOrders.packingRecord.mode"), value: o.packedCarts?.length ? t("admin.pages.pickingOrders.packingRecord.modeCart") : t("admin.pages.pickingOrders.packingRecord.modeBox") },
    { label: t("admin.pages.pickingOrders.packingRecord.inputBoxes"), value: o.packedInputBoxCount != null ? String(o.packedInputBoxCount) : "—" },
    { label: t("admin.pages.pickingOrders.pickingFinished.statBoxes"), value: String(o.packedBoxCount ?? "—") },
  ];
  if (o.packedPalletCount != null) {
    rows.push({ label: t("admin.pages.pickingOrders.packingRecord.carts"), value: String(o.packedPalletCount) });
  }
  rows.push({ label: t("admin.pages.pickingOrders.packingRecord.at"), value: formatDateTime(o.packagedAt) });
  rows.push({ label: t("admin.pages.pickingOrders.packingRecord.by"), value: o.packagedByName ?? o.packagedBy ?? "—" });
  return rows;
});

// ---------------------------------------------------------------------------
// Real scan data table — one row per package (the actual scanned pick)
// ---------------------------------------------------------------------------

interface ScanRow {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  line: string;
  qty: number;
  rescannedQty: number;
  /** Effective date code: pick-time scanned value wins over the source. */
  dc: string;
  /** True when the pick-time scan overrode the source snapshot. */
  dcOverridden: boolean;
  lot: string;
  lotOverridden: boolean;
  coo: string;
  cooOverridden: boolean;
  cow: string;
  cowOverridden: boolean;
  shippingBoxId: string | null;
  verified: boolean;
  verifyVerified: boolean;
  labelBarcode: string | null;
  sourceType: string;
}

function overrideMark(scanned: string | null, source: string | null): { value: string; overridden: boolean } {
  const value = scanned ?? source ?? "";
  return { value: value || "—", overridden: !!scanned && scanned !== (source ?? "") };
}

const scanRows = computed<ScanRow[]>(() =>
  activeItems.value.flatMap((item) =>
    (item.packages ?? []).map((p) => {
      const dc = overrideMark(p.scannedDateCode, p.dateCode);
      const lot = overrideMark(p.scannedLotCode, p.lotCode);
      const coo = overrideMark(p.scannedCoo, p.coo);
      const cow = overrideMark(p.scannedCow, p.cow);
      return {
        id: p.id,
        partNo: item.partNo,
        wclItemNo: item.wclItemNo,
        line: `${item.lineNumber ?? "—"} / ${item.shipmentNumber ?? "—"}`,
        qty: p.qty,
        rescannedQty: p.rescannedQty ?? 0,
        dc: formatDcLabel({ dateCode: dc.value === "—" ? null : dc.value }) || "—",
        dcOverridden: dc.overridden,
        lot: lot.value,
        lotOverridden: lot.overridden,
        coo: coo.value,
        cooOverridden: coo.overridden,
        cow: cow.value,
        cowOverridden: cow.overridden,
        shippingBoxId: p.shippingBoxId,
        verified: p.verified,
        verifyVerified: p.verifyVerified,
        labelBarcode: p.labelBarcode,
        sourceType: p.sourceType,
      };
    })
  )
);

const scanColumnDefs = computed<AdminColumnDef<ScanRow>[]>(() => [
  { key: "partNo", label: t("admin.fields.partNo"), accessor: (r) => r.wclItemNo ?? r.partNo, size: 150 },
  { key: "line", label: t("admin.pages.pickingOrders.line"), accessor: (r) => r.line, size: 100 },
  { key: "qty", label: t("admin.pages.pickingOrders.required"), size: 80 },
  { key: "rescannedQty", label: t("admin.pages.pickingOrders.pickingFinished.rescanned"), size: 90 },
  { key: "dc", label: t("admin.pages.pickingOrders.pickingFinished.dc"), accessor: (r) => r.dc, size: 100 },
  { key: "lot", label: t("admin.pages.pickingOrders.pickingFinished.lot"), accessor: (r) => r.lot, size: 120 },
  { key: "coo", label: t("admin.pages.pickingOrders.pickingFinished.coo"), accessor: (r) => r.coo, size: 80 },
  { key: "cow", label: t("admin.pages.pickingOrders.pickingFinished.cow"), accessor: (r) => r.cow, size: 80 },
  { key: "shippingBoxId", label: t("admin.pages.pickingOrders.boxId"), accessor: (r) => r.shippingBoxId ?? "—", size: 130 },
  { key: "verified", label: t("admin.pages.pickingOrders.pickingFinished.verified"), accessor: (r) => r.verified, size: 110 },
  { key: "labelBarcode", label: t("admin.pages.pickingOrders.pickingFinished.labelBarcode"), accessor: (r) => r.labelBarcode ?? "—", size: 220 },
]);

const { table: scanTable, resetColumnState: resetScanColumns } = useAdminTable({
  tableId: "picking-detail-finished-scans",
  columns: scanColumnDefs,
  rows: scanRows,
  getRowId: (r) => r.id,
  defaultPageSize: 100,
});

// ---------------------------------------------------------------------------
// Boxes summary — packages per box + measuring / verify assignees
// ---------------------------------------------------------------------------

const boxesColumnDefs = computed<AdminColumnDef<PickingOrderDetail["boxes"][number]>[]>(() => [
  { key: "id", label: t("admin.pages.pickingOrders.boxId"), size: 130 },
  { key: "status", label: t("admin.pages.pickingOrders.status"), size: 140 },
  { key: "boxSize", label: t("admin.pages.pickingOrders.size"), size: 80 },
  { key: "packageCount", label: t("admin.pages.pickingOrders.packages"), size: 100 },
  { key: "destinationCountry", label: t("admin.pages.pickingOrders.destination"), size: 130 },
  {
    key: "measuringAssignee",
    label: t("admin.pages.pickingOrders.measuringAssignee"),
    accessor: (b) => b.assignee ?? "",
    size: 170,
  },
  {
    key: "verifyAssignee",
    label: t("admin.pages.pickingOrders.verifyAssignee"),
    accessor: (b) => b.verifyAssignee ?? "",
    size: 170,
  },
]);

const boxesRows = computed(() => props.order.boxes ?? []);

const { table: boxesTable, resetColumnState: resetBoxesColumns } = useAdminTable({
  tableId: "picking-detail-finished-boxes",
  columns: boxesColumnDefs,
  rows: boxesRows,
  getRowId: (b) => b.id,
  defaultPageSize: 100,
});

onMounted(() => {
  loadUsers();
});

watch(
  () => props.order,
  (o) => initFromOrder(o),
  { immediate: true }
);

defineExpose({
  changeBusy: computed(() => false),
});
</script>

<template>
  <div>
    <div v-if="error" class="error-banner">{{ error }}</div>

    <!-- Summary: packaged orders show the PACKING record table (the 打包
         figures); otherwise the scan-stat cards. -->
    <template v-if="packaged">
      <h2 class="section-title">{{ $t("admin.pages.pickingOrders.packingRecord.title") }}</h2>
      <table class="data packing-table">
        <tbody>
          <tr v-for="r in packingRows" :key="r.label">
            <td class="packing-table__label">{{ r.label }}</td>
            <td>{{ r.value }}</td>
          </tr>
        </tbody>
      </table>
      <!-- Cart mode: the per-cart breakdown. -->
      <table v-if="order.packedCarts && order.packedCarts.length" class="data packing-table">
        <thead>
          <tr>
            <th>{{ $t("admin.pages.pickingOrders.packingRecord.cart") }}</th>
            <th>{{ $t("admin.pages.pickingOrders.packingRecord.cartBoxes") }}</th>
            <th>{{ $t("admin.pages.pickingOrders.packingRecord.cartWeight") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(cart, i) in order.packedCarts" :key="i">
            <td>{{ $t("admin.pages.pickingOrders.packagingCartNo", { no: i + 1 }) }}</td>
            <td>{{ cart.boxCount }}</td>
            <td>{{ cart.weight }} kg</td>
          </tr>
        </tbody>
      </table>
    </template>
    <div v-else class="stats-row">
      <div v-for="s in stats" :key="s.label" class="stat-card">
        <div class="stat-value">{{ s.value }}</div>
        <div class="stat-label">{{ s.label }}</div>
      </div>
    </div>

    <!-- Real scan data: one row per picked package -->
    <h2 class="section-title">{{ $t("admin.pages.pickingOrders.pickingFinished.scanDataTitle") }}</h2>
    <DataTable :table="scanTable" :on-reset-columns="resetScanColumns">
      <template #cell-dc="{ row }">
        <span :class="{ overridden: row.dcOverridden }" :title="row.dcOverridden ? $t('admin.pages.pickingOrders.pickingFinished.overriddenHint') : undefined">
          {{ row.dc }}<template v-if="row.dcOverridden"> ✎</template>
        </span>
      </template>
      <template #cell-lot="{ row }">
        <span :class="{ overridden: row.lotOverridden }" :title="row.lotOverridden ? $t('admin.pages.pickingOrders.pickingFinished.overriddenHint') : undefined">
          {{ row.lot }}<template v-if="row.lotOverridden"> ✎</template>
        </span>
      </template>
      <template #cell-coo="{ row }">
        <span :class="{ overridden: row.cooOverridden }">{{ row.coo }}<template v-if="row.cooOverridden"> ✎</template></span>
      </template>
      <template #cell-cow="{ row }">
        <span :class="{ overridden: row.cowOverridden }">{{ row.cow }}<template v-if="row.cowOverridden"> ✎</template></span>
      </template>
      <template #cell-verified="{ row }">
        <template v-if="row.verified">{{ $t("admin.pages.pickingOrders.verified") }}</template>
        <span v-else class="muted">—</span>
      </template>
      <template #cell-labelBarcode="{ row }">
        <span v-if="row.labelBarcode" class="barcode-cell" :title="row.labelBarcode">{{ row.labelBarcode }}</span>
        <span v-else class="muted">—</span>
      </template>
    </DataTable>

    <!-- Boxes: which packages went into which box -->
    <h2 class="section-title">{{ $t("admin.pages.pickingOrders.shippingBoxes") }}</h2>
    <DataTable
      :table="boxesTable"
      :empty-text="$t('admin.pages.pickingOrders.noBoxes')"
      :on-reset-columns="resetBoxesColumns"
    >
      <template #cell-status="{ row }">
        {{ $t(`status.box.${row.status}`) }}
        <div v-if="row.shippedAt" class="muted">{{ formatDateTime(row.shippedAt) }}</div>
      </template>
      <template #cell-boxSize="{ row }">{{ row.boxSize ?? "—" }}</template>
      <template #cell-destinationCountry="{ row }">{{ row.destinationCountry ?? "—" }}</template>
      <template #cell-measuringAssignee="{ row }">
        <SearchableSelect
          :model-value="assigneeValue('measuring', row.id)"
          :options="assigneeOptions"
          :all-label="$t('taskAssignments.unassigned')"
          :aria-label="$t('admin.pages.pickingOrders.measuringAssignee')"
          :multiple="false"
          :disabled="!!assigneeSaving['measuring:' + row.id]"
          @update:model-value="saveStepAssignee('measuring', row.id, $event, (m) => (error = m), onAssigneeSaved)"
        />
      </template>
      <template #cell-verifyAssignee="{ row }">
        <SearchableSelect
          v-if="row.verifyTaskId"
          :model-value="assigneeValue('verify', row.verifyTaskId)"
          :options="assigneeOptions"
          :all-label="$t('taskAssignments.unassigned')"
          :aria-label="$t('admin.pages.pickingOrders.verifyAssignee')"
          :multiple="false"
          :disabled="!!assigneeSaving['verify:' + row.verifyTaskId]"
          @update:model-value="saveStepAssignee('verify', row.verifyTaskId, $event, (m) => (error = m), onAssigneeSaved)"
        />
        <span v-else class="muted">—</span>
      </template>
    </DataTable>

    <AuditLogTable :fetch-logs="fetchLogs" :refresh-key="logsKey" />
  </div>
</template>

<style scoped>
.stats-row {
  display: flex;
  gap: 0.625rem;
  flex-wrap: wrap;
  margin-bottom: 0.875rem;
}
.stat-card {
  min-width: 8.75rem;
  padding: 0.5625rem 0.875rem;
  border: 1px solid #d3dde5;
  border-radius: 0.375rem;
  background: #f7fafc;
}
.stat-value {
  font-size: 1.125rem;
  font-weight: 600;
  color: #243b53;
}
.stat-label {
  font-size: 0.75rem;
  color: #52606d;
  margin-top: 0.125rem;
}
.packing-table {
  max-width: 30rem;
  margin-bottom: 0.875rem;
}
.packing-table__label {
  color: #52606d;
  width: 12rem;
}
.section-title {
  font-size: 0.9375rem;
  margin: 1.125rem 0 0.5rem;
  color: #52606d;
}
.overridden {
  color: #0b5cab;
  font-weight: 600;
}
.barcode-cell {
  display: inline-block;
  max-width: 13.75rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
  font-family: monospace;
}
</style>
