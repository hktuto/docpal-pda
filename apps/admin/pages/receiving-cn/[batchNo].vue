<script setup lang="ts">
import type { CnOrderDetail, CnOrderItemRow, OrderLogsPage, OrderLogsParams, SubInventoryRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

// CN receiving order detail (receiving_orders_cn + invoices/items/put-away
// task). 404 receiving_cn_order_not_found = the workflow hasn't synced the
// order yet — friendly empty state instead of a crash.
//
// Item editing mirrors the standard receiving detail: items grouped by
// invoice, one selectable DataTable per invoice, per-row edit + batch bar,
// all through the shared ReceivingItemEditModal (single edit = clear-blanks,
// batch edit = blanks leave values unchanged) and a per-item PATCH loop.

const route = useRoute();
const batchNo = route.params.batchNo as string;
const flow = useFlowApi();
const api = useApi();
const { t } = useI18n();

const detail = ref<CnOrderDetail | null>(null);
const loading = ref(true);
const notFound = ref(false);
const error = ref("");
// The audit-log table fetches itself; bump this key after mutations that
// write logs (item edits) so it reloads.
const logsKey = ref(0);
const fetchLogs = async (p: OrderLogsParams): Promise<OrderLogsPage> => flow.listCnOrderLogs(batchNo, p);

// Sub-inventory dropdown options for the item edit modal (CN only) —
// sourced from the org/sub-inventory master like the picking order page.
const subInventoryRows = ref<SubInventoryRow[]>([]);
const subInventoryOptions = computed<SearchableSelectOption[]>(() =>
  subInventoryRows.value.map((r) => ({
    value: r.secondaryInventoryName,
    label: r.subinvDescription ? `${r.secondaryInventoryName} — ${r.subinvDescription}` : r.secondaryInventoryName,
  }))
);

// Suggested-shelf dropdown options for the item edit modal — the shelf
// master, same source the shelves page uses.
const shelfRows = ref<{ code: string; displayName?: string | null }[]>([]);
const shelfOptions = computed<SearchableSelectOption[]>(() =>
  shelfRows.value.map((s) => ({ value: s.code, label: s.displayName || s.code }))
);

// Regenerate the 收貨確認及付款通知書 from the latest order data and download it.
// Built with exceljs (not SheetJS) because the community xlsx build cannot
// embed images: when the order has a put-away task, a QR code linking straight
// into it on the PDA is anchored in the title block, left of the 編號 label.
const downloading = ref(false);
async function downloadExcel() {
  if (!detail.value || downloading.value) return;
  downloading.value = true;
  try {
    const { buildCnReceivingExportAoa, cnPutAwayQrPayload } = await import("~/utils/cnReceivingExcelExport");
    const { Workbook } = await import("exceljs");
    const QRCode = (await import("qrcode")).default;
    const { aoa, merges } = buildCnReceivingExportAoa(detail.value);

    const workbook = new Workbook();
    const worksheet = workbook.addWorksheet("Sheet1");
    for (const row of aoa) worksheet.addRow(row);
    for (const m of merges ?? []) {
      worksheet.mergeCells(m.s.r + 1, m.s.c + 1, m.e.r + 1, m.e.c + 1);
    }

    const payload = cnPutAwayQrPayload(detail.value);
    if (payload) {
      const dataUrl = await QRCode.toDataURL(payload, { margin: 1, width: 160 });
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      const imageId = workbook.addImage({ base64, extension: "png" });
      worksheet.addImage(imageId, {
        tl: { col: 6, row: 0.2 },
        ext: { width: 120, height: 120 },
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${detail.value.order.batchNo}.xlsx`;
    anchor.click();
    URL.revokeObjectURL(url);
  } finally {
    downloading.value = false;
  }
}

async function load() {
  loading.value = true;
  error.value = "";
  notFound.value = false;
  try {
    detail.value = await flow.getCnOrder(batchNo);
    selected.value = new Set();
  } catch (e: any) {
    const message = e?.message ?? String(e);
    if (message.includes("receiving_cn_order_not_found")) {
      notFound.value = true;
    } else {
      error.value = message;
    }
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  load();
  flow
    .listSubInventories()
    .then((rows) => (subInventoryRows.value = rows))
    .catch(() => {}); // picker options stay empty; the order still loads
  api
    .get<{ code: string; displayName?: string | null }[]>("/admin/shelves")
    .then((rows) => (shelfRows.value = rows))
    .catch(() => {}); // picker options stay empty; the order still loads
});

// ---- items grouped by invoice ----

interface CnItemGroup {
  key: string;
  invoiceNo: string;
  totalQty: number | null;
  totalCtn: number | null;
  items: CnOrderItemRow[];
}

const groups = computed<CnItemGroup[]>(() => {
  const inv = detail.value?.invoices ?? [];
  const byId = new Map(inv.map((i) => [i.id, i]));
  const buckets = new Map<string, CnOrderItemRow[]>();
  for (const it of detail.value?.items ?? []) {
    const arr = buckets.get(it.receivingInvoiceId);
    if (arr) arr.push(it);
    else buckets.set(it.receivingInvoiceId, [it]);
  }
  return inv
    .slice()
    .sort((a, b) => a.invoiceNo.localeCompare(b.invoiceNo, undefined, { numeric: true, sensitivity: "base" }))
    .map((i) => ({
      key: i.id,
      invoiceNo: i.invoiceNo,
      totalQty: i.totalQty,
      totalCtn: i.totalCtn,
      items: buckets.get(i.id) ?? [],
    }));
});

// ---- keyword filter (mirrors the standard receiving detail): an invoice
// group matches when its invoiceNo contains the keyword (all items shown) or
// any item's partNo/wclItemNo/poNo/ctnNo does ----

const invoiceFilter = ref("");

const filteredGroups = computed<CnItemGroup[]>(() => {
  const needle = invoiceFilter.value.trim().toLowerCase();
  if (!needle) return groups.value;
  return groups.value
    .map((g) => {
      if (g.invoiceNo.toLowerCase().includes(needle)) return g;
      const items = g.items.filter(
        (it) =>
          it.partNo.toLowerCase().includes(needle) ||
          (it.wclItemNo ?? "").toLowerCase().includes(needle) ||
          (it.poNo ?? "").toLowerCase().includes(needle) ||
          (it.ctnNo ?? "").toLowerCase().includes(needle)
      );
      return items.length > 0 ? { ...g, items } : null;
    })
    .filter((g): g is CnItemGroup => g !== null);
});

// ---- item selection (shared across the per-invoice tables) ----

const selected = ref<Set<string>>(new Set());
const selectedItems = computed(() => (detail.value?.items ?? []).filter((it) => selected.value.has(it.id)));

const visibleItemIds = computed(() => filteredGroups.value.flatMap((g) => g.items.map((it) => it.id)));
const allVisibleSelected = computed(
  () => visibleItemIds.value.length > 0 && visibleItemIds.value.every((id) => selected.value.has(id))
);

function toggleSelectAll() {
  const next = new Set(selected.value);
  if (allVisibleSelected.value) {
    for (const id of visibleItemIds.value) next.delete(id);
  } else {
    for (const id of visibleItemIds.value) next.add(id);
  }
  selected.value = next;
}

// ---- per-invoice tables (same shape, shared column state via syncKey) ----

const itemColumnDefs = computed<AdminColumnDef<CnOrderItemRow>[]>(() => [
  {
    key: "partNo",
    label: t("admin.pages.receivingCn.itemsTable.partNo"),
    size: 190,
  },
  {
    key: "wclItemNo",
    label: t("admin.pages.receivingCn.itemsTable.wclItemNo"),
    accessor: (it) => it.wclItemNo ?? "",
    size: 190,
  },
  {
    key: "poNo",
    label: t("admin.pages.receivingCn.itemsTable.poNo"),
    accessor: (it) => it.poNo ?? "",
    size: 120,
  },
  { key: "poLine", label: t("admin.pages.receivingCn.itemsTable.poLine"), size: 80 },
  { key: "lineQty", label: t("admin.pages.receivingCn.itemsTable.lineQty"), size: 90 },
  { key: "receivedQty", label: t("admin.pages.receivingCn.itemsTable.receivedQty"), size: 90 },
  {
    key: "putAway",
    label: t("admin.pages.receivingCn.itemsTable.putAwayStatus"),
    accessor: (it) => it.putAwayQty,
    size: 150,
  },
  { key: "putAwayQty", label: t("admin.pages.receivingCn.itemsTable.putAwayQty"), size: 90 },
  { key: "ctnNo", label: t("admin.pages.receivingCn.itemsTable.ctnNo"), size: 80 },
  { key: "dateCode", label: t("admin.pages.receivingCn.itemsTable.dateCode"), size: 90 },
  { key: "lotCode", label: t("admin.pages.receivingCn.itemsTable.lotCode"), size: 90 },
  { key: "coo", label: t("admin.pages.receivingCn.itemsTable.coo"), size: 70 },
  { key: "cow", label: t("admin.pages.receivingCn.itemsTable.cow"), size: 70 },
  { key: "subInventoryCode", label: t("admin.pages.receivingCn.itemsTable.subInventory"), size: 110 },
  { key: "suggestedShelf", label: t("admin.pages.receivingCn.itemsTable.suggestedShelf"), size: 110 },
]);

type GroupTable = ReturnType<typeof useAdminTable<CnOrderItemRow>>;
const groupTables = new Map<string, GroupTable>();

function tableForGroup(key: string): GroupTable {
  let inst = groupTables.get(key);
  if (!inst) {
    inst = useAdminTable<CnOrderItemRow>({
      tableId: "receiving-cn-detail-items",
      syncKey: "receiving-cn-detail-items",
      columns: itemColumnDefs,
      rows: computed(() => filteredGroups.value.find((g) => g.key === key)?.items ?? []),
      getRowId: (it) => it.id,
      // Default sort: PO line, then part no (persisted sort state wins).
      initialSorting: [
        { id: "poLine", desc: false },
        { id: "partNo", desc: false },
      ],
      // Group item lists are never paged — one page renders every row.
      defaultPageSize: 1000,
    });
    groupTables.set(key, inst);
  }
  return inst;
}

// ---- item editing (shared modal, per-item PATCH loop) ----

const editItems = ref<CnOrderItemRow[] | null>(null);
const savingEdit = ref(false);

// Pending orders (pdf path, awaiting the admin confirm) edit inline in the
// table — same fields as the modal, saved per cell on change.
const isPending = computed(() => detail.value?.order.status === "pending");

type InlineField =
  | "partNo"
  | "wclItemNo"
  | "poNo"
  | "lineQty"
  | "ctnNo"
  | "dateCode"
  | "lotCode"
  | "coo"
  | "cow"
  | "subInventoryCode";

const INLINE_FIELD_BODY: Record<InlineField, (row: CnOrderItemRow) => Record<string, string | null | number>> = {
  partNo: (row) => ({ partNo: row.partNo }),
  // The backend applies the matched part's part_no alongside a wcl change.
  wclItemNo: (row) => ({ wclItemNo: row.wclItemNo }),
  poNo: (row) => ({ poNo: row.poNo }),
  lineQty: (row) => ({ lineQty: Number(row.lineQty) }),
  ctnNo: (row) => ({ ctnNo: row.ctnNo }),
  dateCode: (row) => ({ dateCode: row.dateCode }),
  lotCode: (row) => ({ lotCode: row.lotCode }),
  coo: (row) => ({ coo: row.coo }),
  cow: (row) => ({ cow: row.cow }),
  subInventoryCode: (row) => ({ subInventory: row.subInventoryCode }),
};

async function saveInline(item: CnOrderItemRow, field: InlineField) {
  if (!detail.value) return;
  if (field === "lineQty") {
    const qty = Number(item.lineQty);
    if (!Number.isInteger(qty) || qty <= 0) {
      error.value = t("admin.pages.receivingCn.invalidQty");
      await load();
      return;
    }
  }
  error.value = "";
  try {
    const updated = await flow.updateCnItem(item.id, INLINE_FIELD_BODY[field](item));
    const idx = detail.value.items.findIndex((i) => i.id === item.id);
    if (idx >= 0) detail.value.items.splice(idx, 1, { ...item, ...updated });
    logsKey.value++;
  } catch (e: any) {
    error.value = e?.message ?? String(e);
    await load();
  }
}

// ---- confirm receipt (pending → in_hand + put-away task) ----

const confirming = ref(false);

async function confirmOrder() {
  if (!detail.value || confirming.value) return;
  if (!window.confirm(t("admin.pages.receivingCn.confirmOrderConfirm", { batchNo: detail.value.order.batchNo }))) return;
  confirming.value = true;
  error.value = "";
  try {
    await flow.confirmCnOrder(batchNo);
    await load();
    logsKey.value++;
  } catch (e: any) {
    error.value = `${t("admin.pages.receivingCn.confirmFailed")}: ${e?.message ?? String(e)}`;
  } finally {
    confirming.value = false;
  }
}

function openEdit(item: CnOrderItemRow) {
  editItems.value = [item];
}

function openBatchEdit() {
  if (selectedItems.value.length > 0) editItems.value = selectedItems.value;
}

async function saveEdit(
  fields: Partial<
    Record<"dateCode" | "lotCode" | "coo" | "cow" | "ctnNo" | "subInventory" | "suggestedShelf", string | null>
  >
) {
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
      await flow.updateCnItem(item.id, fields);
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

function orderStatusClass(s: string): string {
  return {
    pending: "chip chip-muted",
    in_hand: "chip chip-info",
    clear: "chip chip-ok",
  }[s] ?? "chip";
}

function putAwayStatusClass(s: string): string {
  return {
    pending: "chip chip-info",
    completed: "chip chip-ok",
  }[s] ?? "chip";
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.receivingCn.detailTitle", { batchNo }) }}</h1>
      <div class="head-actions">
        <button
          v-if="isPending"
          class="btn btn-primary"
          :disabled="confirming || loading"
          @click="confirmOrder"
        >
          {{ confirming ? $t("admin.common.saving") : $t("admin.pages.receivingCn.confirmOrder") }}
        </button>
        <button class="btn" :disabled="downloading || loading" @click="downloadExcel">
          {{ downloading ? $t("admin.common.loading") : $t("admin.pages.receivingCn.downloadExcel") }}
        </button>
        <button class="btn" @click="navigateTo('/receiving-cn')">{{ $t("admin.common.back") }}</button>
      </div>
    </div>

    <p v-if="loading">{{ $t("admin.common.loading") }}</p>

    <div v-else-if="notFound" class="card not-found">
      <h2>{{ $t("admin.pages.receivingCn.notFoundTitle") }}</h2>
      <p>{{ $t("admin.pages.receivingCn.notFoundBody") }}</p>
      <button class="btn" @click="navigateTo('/receiving-cn')">
        {{ $t("admin.common.back") }}
      </button>
    </div>

    <div v-else-if="error" class="error-banner">{{ error }}</div>

    <template v-else-if="detail">
      <div class="card head-card">
        <div class="head-grid">
          <div>
            <span class="dt">{{ $t("admin.pages.receivingCn.status") }}:</span>
            <span :class="orderStatusClass(detail.order.status)">{{ $t(`status.receiving.${detail.order.status}`) }}</span>
          </div>
          <div>
            <span class="dt">{{ $t("admin.pages.receivingCn.putAway") }}:</span>
            <span v-if="detail.putAway" :class="putAwayStatusClass(detail.putAway.status)">
              {{ $t(`status.putAway.${detail.putAway.status}`) }}
            </span>
            <span v-else>—</span>
          </div>
          <div>
            <span class="dt">{{ $t("admin.pages.receivingCn.deliveryDate") }}:</span>
            {{ detail.order.deliveryDate ? formatDate(detail.order.deliveryDate) : "—" }}
          </div>
          <div>
            <span class="dt">{{ $t("admin.pages.receivingCn.arrivedAt") }}:</span>
            {{ detail.order.arrivedAt ? formatDateTime(detail.order.arrivedAt) : "—" }}
          </div>
          <div>
            <span class="dt">{{ $t("admin.pages.receivingCn.arrivedBy") }}:</span>
            {{ detail.order.arrivedByName ?? detail.order.arrivedBy ?? "—" }}
          </div>
          <div>
            <span class="dt">{{ $t("admin.pages.receivingCn.itemsTable.dateCode") }}:</span>
            {{ detail.order.dateCode ?? "—" }}
          </div>
          <div>
            <span class="dt">{{ $t("admin.pages.receivingCn.org") }}:</span>
            {{ detail.order.orgId }}
          </div>
          <div>
            <span class="dt">{{ $t("admin.fields.createdDate") }}:</span>
            {{ formatDateTime(detail.order.createdDate) }}
          </div>
        </div>
      </div>

      <div class="items-toolbar">
        <input
          v-model="invoiceFilter"
          type="search"
          class="search-input"
          :placeholder="$t('admin.pages.receiving.invoiceFilterPlaceholder')"
        />
        <label class="select-all-toggle">
          <input type="checkbox" :checked="allVisibleSelected" @change="toggleSelectAll" />
          {{ $t("admin.pages.receiving.selectAll") }}
        </label>
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

      <template v-for="group in filteredGroups" :key="group.key">
        <h2 class="section-title">
          {{ $t("admin.pages.receiving.invoiceTitle", { invoiceNo: group.invoiceNo }) }}
          <span class="muted">
            — {{ $t("admin.pages.receiving.itemsCount", { count: group.items.length }) }}
            <template v-if="group.totalQty != null">
              · {{ $t("admin.pages.receivingCn.itemsTable.totalQty") }}: {{ group.totalQty }}</template>
            <template v-if="group.totalCtn != null">
              · {{ $t("admin.pages.receivingCn.itemsTable.totalCtn") }}: {{ group.totalCtn }}</template>
          </span>
        </h2>
        <DataTable
          v-model:selected="selected"
          :table="tableForGroup(group.key).table"
          selectable
          sync-scroll-key="receiving-cn-detail-items"
          :empty-text="$t('admin.common.noRecords')"
          :on-reset-columns="tableForGroup(group.key).resetColumnState"
        >
          <template #cell-partNo="{ row }">
            <input
              v-if="isPending"
              v-model="row.partNo"
              class="cell-input"
              type="text"
              @change="saveInline(row, 'partNo')"
            />
            <span v-else>{{ row.partNo }}</span>
          </template>
          <template #cell-wclItemNo="{ row }">
            <ReceivingCnPartNoSelect
              v-if="isPending"
              :model-value="row.wclItemNo ?? ''"
              :aria-label="$t('admin.pages.receivingCn.itemsTable.wclItemNo')"
              @update:model-value="row.wclItemNo = $event"
              @pick="row.partNo = $event.partNo"
              @commit="saveInline(row, 'wclItemNo')"
            />
            <span v-else>{{ row.wclItemNo ?? "—" }}</span>
          </template>
          <template #cell-poNo="{ row }">
            <input
              v-if="isPending"
              v-model="row.poNo"
              class="cell-input"
              type="text"
              @change="saveInline(row, 'poNo')"
            />
            <span v-else>{{ row.poNo ?? "—" }}</span>
          </template>
          <template #cell-lineQty="{ row }">
            <input
              v-if="isPending"
              v-model.number="row.lineQty"
              class="cell-input"
              type="number"
              min="1"
              step="1"
              @change="saveInline(row, 'lineQty')"
            />
            <span v-else>{{ row.lineQty ?? "—" }}</span>
          </template>
          <template #cell-ctnNo="{ row }">
            <input
              v-if="isPending"
              v-model="row.ctnNo"
              class="cell-input"
              type="text"
              @change="saveInline(row, 'ctnNo')"
            />
            <span v-else>{{ row.ctnNo ?? "—" }}</span>
          </template>
          <template #cell-dateCode="{ row }">
            <input
              v-if="isPending"
              v-model="row.dateCode"
              class="cell-input"
              type="text"
              @change="saveInline(row, 'dateCode')"
            />
            <span v-else>{{ row.dateCode ?? "—" }}</span>
          </template>
          <template #cell-lotCode="{ row }">
            <input
              v-if="isPending"
              v-model="row.lotCode"
              class="cell-input"
              type="text"
              @change="saveInline(row, 'lotCode')"
            />
            <span v-else>{{ row.lotCode ?? "—" }}</span>
          </template>
          <template #cell-coo="{ row }">
            <input
              v-if="isPending"
              v-model="row.coo"
              class="cell-input"
              type="text"
              @change="saveInline(row, 'coo')"
            />
            <span v-else>{{ row.coo ?? "—" }}</span>
          </template>
          <template #cell-cow="{ row }">
            <input
              v-if="isPending"
              v-model="row.cow"
              class="cell-input"
              type="text"
              @change="saveInline(row, 'cow')"
            />
            <span v-else>{{ row.cow ?? "—" }}</span>
          </template>
          <template #cell-subInventoryCode="{ row }">
            <select
              v-if="isPending"
              v-model="row.subInventoryCode"
              class="cell-input"
              @change="saveInline(row, 'subInventoryCode')"
            >
              <option :value="null">—</option>
              <option v-for="opt in subInventoryOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
            <span v-else>{{ row.subInventoryCode ?? "—" }}</span>
          </template>
          <template #cell-putAway="{ row }">
            <span v-if="row.putAwayQty > 0 || row.putAwayLocations.length > 0">
              {{ row.putAwayQty }}/{{ row.receivedQty }}
              <span v-if="row.putAwayLocations.length > 0" class="muted locations">
                {{ row.putAwayLocations.map((l) => l.shelfCode ?? l.boxId).filter(Boolean).join(", ") }}
              </span>
            </span>
            <span v-else>—</span>
          </template>
          <template #cell-suggestedShelf="{ row }">
            {{ row.suggestedShelf ?? "—" }}
          </template>
          <template #actions="{ row }">
            <button class="btn btn-small" @click="openEdit(row)">{{ $t("admin.common.edit") }}</button>
          </template>
        </DataTable>
      </template>
      <p v-if="filteredGroups.length === 0" class="muted">{{ $t("admin.common.noRecords") }}</p>

      <AuditLogTable :fetch-logs="fetchLogs" :refresh-key="logsKey" />
    </template>

    <ReceivingItemEditModal
      v-if="editItems"
      :items="editItems"
      :saving="savingEdit"
      :sub-inventory-options="subInventoryOptions"
      :shelf-options="shelfOptions"
      @close="editItems = null"
      @save="saveEdit"
    />
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 0.625rem;
}
.card {
  margin-bottom: 1rem;
}
.card h2 {
  margin: 0 0 0.75rem;
  font-size: 1rem;
}
.head-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 0.5rem 1rem;
  font-size: 0.875rem;
}
.dt {
  font-weight: 600;
}
.not-found p {
  color: #52606d;
}
.items-toolbar {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.25rem 0;
}
.select-all-toggle {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  cursor: pointer;
  user-select: none;
}
.batch-bar {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin: 0.625rem 0;
  padding: 0.5rem 0.625rem;
  background: #eef2f7;
  border: 1px solid #d5dee7;
  border-radius: 0.375rem;
}
.section-title {
  margin: 1rem 0 0.375rem;
  font-size: 0.9375rem;
}
.section-title .muted {
  font-weight: 400;
  font-size: 0.8125rem;
}
.locations {
  display: block;
  font-size: 0.75rem;
}
.cell-input {
  width: 100%;
  min-width: 4rem;
  padding: 0.125rem 0.375rem;
  font-size: 0.8125rem;
  border: 1px solid #d5dee7;
  border-radius: 0.25rem;
  box-sizing: border-box;
}
.chip {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  white-space: nowrap;
}
.chip-info {
  background: #dbeafe;
  color: #1d4ed8;
}
.chip-ok {
  background: #dcfce7;
  color: #15803d;
}
.chip-muted {
  background: #e5e7eb;
  color: #52606d;
}
</style>
