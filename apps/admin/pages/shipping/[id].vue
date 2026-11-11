<script setup lang="ts">
import type { ShippingBoxDetail } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";

const route = useRoute();
const boxId = route.params.id as string;
const flow = useFlowApi();
const { t } = useI18n();

const detail = ref<ShippingBoxDetail | null>(null);
const loading = ref(true);
const error = ref("");
const shipping = ref(false);

type OrderRow = ShippingBoxDetail["orders"][number];
type PackageRow = ShippingBoxDetail["packages"][number];

const orderRows = computed(() => detail.value?.orders ?? []);
const packageRows = computed(() => detail.value?.packages ?? []);

const orderColumnDefs = computed<AdminColumnDef<OrderRow>[]>(() => [
  { key: "orderNo", label: t("admin.pages.shipping.orderNo"), size: 140 },
  { key: "status", label: t("admin.pages.shipping.orderStatus"), size: 110 },
  { key: "shipTo", label: t("admin.pages.shipping.shipTo"), accessor: (o) => o.shipTo ?? "", size: 160 },
  { key: "customerCode", label: t("admin.pages.shipping.customer"), accessor: (o) => o.customerCode ?? "", size: 110 },
  { key: "poNo", label: t("admin.pages.shipping.poNo"), accessor: (o) => o.poNo ?? "", size: 140 },
  // Packaging stage (spec 2026-11-10): recorded weight / box / pallet counts.
  { key: "packaged", label: t("admin.pages.shipping.packaged"), accessor: (o) => (o.packagedAt ? 1 : 0), size: 160 },
]);

const packageColumnDefs = computed<AdminColumnDef<PackageRow>[]>(() => [
  {
    key: "partNo",
    label: t("admin.pages.shipping.partNo"),
    accessor: (p) => p.wclItemNo ?? p.partNo,
    size: 160,
  },
  { key: "qty", label: t("admin.pages.shipping.qty"), size: 80 },
  { key: "dateCode", label: t("admin.pages.shipping.dateCode"), accessor: (p) => p.dateCode ?? "", size: 110 },
  { key: "lotCode", label: t("admin.pages.shipping.lot"), accessor: (p) => p.lotCode ?? "", size: 110 },
  {
    key: "cooCow",
    label: t("admin.pages.shipping.cooCow"),
    accessor: (p) => `${p.coo ?? "—"} / ${p.cow ?? "—"}`,
    size: 120,
  },
  { key: "verified", label: t("admin.pages.shipping.verified"), accessor: (p) => (p.verified ? 1 : 0), size: 90 },
]);

const { table: orderTable, resetColumnState: resetOrderColumns } = useAdminTable({
  tableId: "shipping-detail-orders",
  columns: orderColumnDefs,
  rows: orderRows,
  getRowId: (o) => o.id,
});

const { table: packageTable, resetColumnState: resetPackageColumns } = useAdminTable({
  tableId: "shipping-detail-packages",
  columns: packageColumnDefs,
  rows: packageRows,
  getRowId: (p) => p.id,
});

async function shipBox() {
  if (shipping.value) return;
  if (!window.confirm(t("admin.pages.shipping.shipBoxConfirm", { boxId }))) return;
  shipping.value = true;
  error.value = "";
  try {
    await flow.shipShippingBoxes([boxId]);
    navigateTo("/shipping");
  } catch (e: any) {
    error.value = e.message;
  } finally {
    shipping.value = false;
  }
}

// Packaging review (spec 2026-11-10-packaging-shipping-steps-design.md): the
// packaged orders' recorded numbers as one copyable block for the delivery
// provider's form.
const summaryText = computed(() => {
  const d = detail.value;
  if (!d) return "";
  return d.orders
    .filter((o) => o.packagedAt)
    .map((o) =>
      [
        o.orderNo,
        o.customerCode ?? "",
        o.shipTo ?? "",
        `${o.packedWeight ?? ""} kg`,
        t("admin.pages.shipping.summaryBoxes", { count: o.packedBoxCount ?? 0 }),
        ...(o.packedPalletCount != null ? [t("admin.pages.shipping.summaryPallets", { count: o.packedPalletCount })] : []),
      ].filter(Boolean).join(" | ")
    )
    .join("\n");
});

const summaryEl = ref<HTMLTextAreaElement | null>(null);
const copied = ref(false);
async function copySummary() {
  try {
    await navigator.clipboard.writeText(summaryText.value);
  } catch {
    // Insecure-origin fallback (plain http LAN admin hosts): select the block
    // so Ctrl-C copies it.
    summaryEl.value?.select();
  }
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    detail.value = await flow.getShippingBox(boxId);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

// Reload when the box is shipped or its orders change elsewhere.
const {
  pending: changePending,
  justUpdated: changeUpdated,
  refreshNow,
  dismiss,
} = useChangeNotice(["shipping_box.shipped", "picking_order.updated", "picking.packaged"], load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.shipping.detailTitle", { boxId }) }}</h1>
      <div class="head-actions">
        <button
          v-if="detail && !detail.box.shippedAt"
          class="btn"
          :disabled="shipping"
          @click="shipBox"
        >
          {{ $t("admin.pages.shipping.shipBox") }}
        </button>
        <NuxtLink to="/shipping" class="btn">{{ $t("admin.common.back") }}</NuxtLink>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <ChangeNotice :pending="changePending" :just-updated="changeUpdated" @refresh="refreshNow" @dismiss="dismiss" />
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <template v-else-if="detail">
      <div class="detail-grid">
        <div><div class="dt">{{ $t("admin.pages.shipping.boxStatus") }}</div><div class="dd">{{ detail.box.status }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.shipping.size") }}</div><div class="dd">{{ detail.box.boxSize ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.shipping.netWeight") }}</div><div class="dd">{{ detail.box.netWeight ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.shipping.grossWeight") }}</div><div class="dd">{{ detail.box.grossWeight ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.shipping.destination") }}</div><div class="dd">{{ detail.box.destinationCountry ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.shipping.createdAt") }}</div><div class="dd">{{ formatDateTime(detail.box.createdDate) }}</div></div>
        <div v-if="detail.box.shippedAt"><div class="dt">{{ $t("admin.pages.shipping.shippedAt") }}</div><div class="dd">{{ formatDateTime(detail.box.shippedAt) }}</div></div>
        <div v-if="detail.box.shippedBy"><div class="dt">{{ $t("admin.pages.shipping.shippedBy") }}</div><div class="dd">{{ detail.box.shippedBy }}</div></div>
      </div>

      <h2 class="section-title">{{ $t("admin.pages.shipping.ordersInBox") }}</h2>
      <DataTable
        :table="orderTable"
        :on-reset-columns="resetOrderColumns"
      >
        <template #cell-orderNo="{ row }">
          <span class="clickable" @click="navigateTo(`/picking-orders/${row.id}`)">{{ row.orderNo }}</span>
        </template>
        <template #cell-shipTo="{ row }">{{ row.shipTo ?? "—" }}</template>
        <template #cell-customerCode="{ row }">{{ row.customerCode ?? "—" }}</template>
        <template #cell-poNo="{ row }">{{ row.poNo ?? "—" }}</template>
        <template #cell-packaged="{ row }">
          <template v-if="row.packagedAt">
            {{ row.packedWeight }} kg · {{ row.packedBoxCount }}
            <template v-if="row.packedPalletCount != null"> · {{ $t("admin.pages.shipping.summaryPallets", { count: row.packedPalletCount }) }}</template>
          </template>
          <template v-else>—</template>
        </template>
      </DataTable>

      <template v-if="summaryText">
        <h2 class="section-title">
          {{ $t("admin.pages.shipping.packagingSummary") }}
          <button class="btn copy-btn" @click="copySummary">
            {{ copied ? $t("admin.pages.shipping.copied") : $t("admin.pages.shipping.copy") }}
          </button>
        </h2>
        <textarea ref="summaryEl" class="summary-block" rows="4" readonly>{{ summaryText }}</textarea>
      </template>

      <h2 class="section-title">{{ $t("admin.pages.shipping.packages") }}</h2>
      <DataTable
        :table="packageTable"
        :empty-text="$t('admin.pages.shipping.emptyBox')"
        :on-reset-columns="resetPackageColumns"
      >
        <template #cell-partNo="{ row }">{{ row.wclItemNo ?? row.partNo }}</template>
        <template #cell-dateCode="{ row }">{{ row.dateCode ?? "—" }}</template>
        <template #cell-lotCode="{ row }">{{ row.lotCode ?? "—" }}</template>
        <template #cell-cooCow="{ row }">{{ row.coo ?? "—" }} / {{ row.cow ?? "—" }}</template>
        <template #cell-verified="{ row }">{{ row.verified ? "✓" : "" }}</template>
      </DataTable>
    </template>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 0.625rem;
}
.section-title {
  font-size: 0.9375rem;
  margin: 1.125rem 0 0.5rem;
  color: #52606d;
}
.clickable {
  cursor: pointer;
  color: #0b5cab;
}
.copy-btn {
  margin-left: 0.5rem;
  font-size: 0.75rem;
  padding: 0.125rem 0.5rem;
}
.summary-block {
  width: 100%;
  max-width: 40rem;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 0.8125rem;
  padding: 0.5rem 0.625rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  resize: vertical;
}
</style>
