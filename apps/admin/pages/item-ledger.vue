<script setup lang="ts">
import type { PartLedger, PartLedgerTransaction, PartMasterRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";

// Item ledger ("item angel" view): pick a part, see its current stock lots +
// totals and every in/out movement (which receiving order brought it in,
// which picking order took it out) with the lot's date code / COO / COW.
const flow = useFlowApi();
const { t, te } = useI18n();
const route = useRoute();
const router = useRouter();

// --- part picker (debounced parts-master search, or type + Enter) ----------
const query = ref("");
const suggestions = ref<PartMasterRow[]>([]);
const suggestOpen = ref(false);
let suggestTimer: ReturnType<typeof setTimeout> | undefined;

const selected = ref<{ partNo: string; wclItemNo: string | null } | null>(null);

watch(query, (q) => {
  clearTimeout(suggestTimer);
  const text = q.trim();
  if (text === "" || (selected.value && text === (selected.value.wclItemNo ?? selected.value.partNo))) {
    suggestions.value = [];
    suggestOpen.value = false;
    return;
  }
  suggestTimer = setTimeout(async () => {
    try {
      const res = await flow.searchParts({ q: text, pageSize: 8 });
      // Only keep the dropdown when the input hasn't moved on meanwhile.
      if (query.value.trim() === text) {
        suggestions.value = res.rows;
        suggestOpen.value = true;
      }
    } catch {
      suggestions.value = [];
    }
  }, 250);
});

function selectPart(p: PartMasterRow) {
  selected.value = { partNo: p.partNo, wclItemNo: p.wclItemNo };
  query.value = p.wclItemNo || p.partNo;
  suggestions.value = [];
  suggestOpen.value = false;
  load();
}

function hideSuggestions() {
  // Delay so a click on a suggestion still lands before the dropdown closes.
  setTimeout(() => (suggestOpen.value = false), 150);
}

// Free-text search: the backend matches the value against part_no OR
// wcl_item_no, so pass it as both.
function runTypedSearch() {
  const text = query.value.trim();
  if (text === "") return;
  selected.value = { partNo: text, wclItemNo: text };
  suggestions.value = [];
  suggestOpen.value = false;
  load();
}

// --- ledger data -------------------------------------------------------------
const result = ref<PartLedger | null>(null);
const searched = ref(false);
const loading = ref(false);
const error = ref("");

async function load() {
  const sel = selected.value;
  if (!sel) return;
  router.replace({ query: { ...route.query, partNo: sel.partNo, ...(sel.wclItemNo ? { wclItemNo: sel.wclItemNo } : {}) } });
  loading.value = true;
  error.value = "";
  try {
    result.value = await flow.getPartLedger(sel.partNo, sel.wclItemNo);
    searched.value = true;
  } catch (e: any) {
    error.value = e.message;
    result.value = null;
  } finally {
    loading.value = false;
  }
}

// Deep link: /item-ledger?partNo=...&wclItemNo=...
onMounted(() => {
  const partNo = typeof route.query.partNo === "string" ? route.query.partNo : "";
  const wclItemNo = typeof route.query.wclItemNo === "string" ? route.query.wclItemNo : "";
  if (partNo !== "" || wclItemNo !== "") {
    selected.value = { partNo, wclItemNo: wclItemNo || null };
    query.value = wclItemNo || partNo;
    load();
  }
});

// --- transactions table ------------------------------------------------------
const txns = computed(() => result.value?.transactions ?? []);

function txnTypeLabel(txnType: string): string {
  const key = `admin.pages.itemLedger.txnTypes.${txnType}`;
  return te(key) ? t(key) : txnType;
}
function qtyTypeLabel(qtyType: string): string {
  const key = `admin.pages.itemLedger.qtyTypes.${qtyType}`;
  return te(key) ? t(key) : qtyType;
}

const txnColumnDefs = computed<AdminColumnDef<PartLedgerTransaction>[]>(() => [
  { key: "txnAt", label: t("admin.pages.itemLedger.colTime"), accessor: (r) => r.txnAt, size: 150 },
  { key: "direction", label: t("admin.pages.itemLedger.colDirection"), sortable: false, size: 90 },
  { key: "txnType", label: t("admin.pages.itemLedger.colType"), accessor: (r) => txnTypeLabel(r.txnType), size: 120 },
  { key: "qtyDelta", label: t("admin.pages.itemLedger.colQty"), accessor: (r) => r.qtyDelta, size: 90 },
  {
    key: "order",
    label: t("admin.pages.itemLedger.colOrder"),
    accessor: (r) => r.pickingOrderNo ?? r.receivingBatchNo ?? "",
    size: 170,
  },
  { key: "qtyType", label: t("admin.pages.itemLedger.colQtyType"), accessor: (r) => qtyTypeLabel(r.qtyType), size: 90 },
  { key: "shelfCode", label: t("stockSearch.shelf"), accessor: (r) => formatShelf(r.shelfCode, r.shelfDisplayName), size: 100 },
  { key: "boxId", label: t("stockSearch.box"), accessor: (r) => r.boxId ?? "", size: 110 },
  { key: "dateCode", label: t("stockSearch.dateCode"), accessor: (r) => r.dateCode ?? "", size: 90 },
  { key: "lotCode", label: t("stockSearch.lotCode"), accessor: (r) => r.lotCode ?? "", size: 110 },
  { key: "coo", label: t("stockSearch.coo"), accessor: (r) => r.coo ?? "", size: 80 },
  { key: "cow", label: t("stockSearch.cow"), accessor: (r) => r.cow ?? "", size: 80 },
  { key: "actorName", label: t("admin.pages.itemLedger.colActor"), accessor: (r) => r.actorName ?? "", size: 120 },
  { key: "txnReason", label: t("admin.pages.itemLedger.colReason"), accessor: (r) => r.txnReason ?? "", size: 160 },
]);

const { table: txnTable, resetColumnState: resetTxnColumns } = useAdminTable({
  tableId: "item-ledger-txns",
  columns: txnColumnDefs,
  rows: txns,
  getRowId: (r) => r.id,
  defaultPageSize: 50,
});
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.itemLedger.title") }}</h1>
    </div>

    <div class="part-picker">
      <input
        v-model="query"
        type="text"
        class="part-input"
        :placeholder="$t('admin.pages.itemLedger.searchPlaceholder')"
        @keydown.enter="runTypedSearch"
        @focus="suggestions.length > 0 && (suggestOpen = true)"
        @blur="hideSuggestions"
      />
      <div v-if="suggestOpen" class="suggest-list">
        <button
          v-for="p in suggestions"
          :key="p.id"
          type="button"
          class="suggest-item"
          @click="selectPart(p)"
        >
          <span class="suggest-main">{{ p.wclItemNo }}</span>
          <span class="muted suggest-sub">
            {{ p.partNo }}<template v-if="p.brand"> · {{ p.brand }}</template>
            <template v-if="p.description"> — {{ p.description }}</template>
          </span>
        </button>
        <div v-if="suggestions.length === 0" class="suggest-empty muted">
          {{ $t("admin.pages.itemLedger.noParts") }}
        </div>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <template v-else-if="result">
      <div class="summary-card">
        <div class="summary-part">
          <div class="summary-partno">{{ result.part?.wclItemNo ?? selected?.wclItemNo ?? selected?.partNo }}</div>
          <div v-if="result.part" class="muted">
            {{ result.part.partNo }} · {{ result.part.brand }}
            <template v-if="result.part.description"> — {{ result.part.description }}</template>
          </div>
        </div>
        <div class="summary-totals">
          <div class="stat">
            <div class="stat-value">{{ result.totals.totalQty }}</div>
            <div class="stat-label">{{ $t("stockSearch.totalQty") }}</div>
          </div>
          <div class="stat">
            <div class="stat-value">{{ result.totals.allocatedQty }}</div>
            <div class="stat-label">{{ $t("stockSearch.allocatedQty") }}</div>
          </div>
          <div class="stat">
            <div class="stat-value">{{ result.totals.availableQty }}</div>
            <div class="stat-label">{{ $t("stockSearch.availableQty") }}</div>
          </div>
        </div>
      </div>

      <h2 class="section-title">{{ $t("admin.pages.itemLedger.currentStock") }}</h2>
      <table v-if="result.stock.length > 0" class="stock-table">
        <thead>
          <tr>
            <th>{{ $t("admin.pages.shelfBoxes.orgId") }}</th>
            <th>{{ $t("admin.pages.shelfBoxes.subInventory") }}</th>
            <th>{{ $t("stockSearch.shelf") }}</th>
            <th>{{ $t("stockSearch.box") }}</th>
            <th>{{ $t("stockSearch.dateCode") }}</th>
            <th>{{ $t("stockSearch.lotCode") }}</th>
            <th>{{ $t("stockSearch.coo") }}</th>
            <th>{{ $t("stockSearch.cow") }}</th>
            <th class="num">{{ $t("stockSearch.totalQty") }}</th>
            <th class="num">{{ $t("stockSearch.allocatedQty") }}</th>
            <th class="num">{{ $t("stockSearch.availableQty") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in result.stock" :key="s.lotId">
            <td>{{ s.orgId ?? "—" }}</td>
            <td>{{ s.subInventoryCode ?? "—" }}</td>
            <td>{{ formatShelf(s.shelfCode, s.shelfDisplayName) || "—" }}</td>
            <td>{{ s.boxId ?? "—" }}</td>
            <td>{{ s.dateCode ?? "—" }}</td>
            <td>{{ s.lotCode ?? "—" }}</td>
            <td>{{ s.coo ?? "—" }}</td>
            <td>{{ s.cow ?? "—" }}</td>
            <td class="num">{{ s.totalQty }}</td>
            <td class="num">{{ s.allocatedQty }}</td>
            <td class="num">{{ s.availableQty }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="muted">{{ $t("admin.pages.itemLedger.noneStock") }}</div>

      <h2 class="section-title">{{ $t("admin.pages.itemLedger.transactionsTitle") }}</h2>
      <DataTable
        :table="txnTable"
        :empty-text="$t('admin.pages.itemLedger.noneTransactions')"
        :on-reset-columns="resetTxnColumns"
      >
        <template #cell-txnAt="{ row }">{{ formatDateTime(row.txnAt) }}</template>
        <template #cell-direction="{ row }">
          <span class="dir-badge" :class="row.qtyDelta >= 0 ? 'dir-in' : 'dir-out'">
            {{ $t(row.qtyDelta >= 0 ? "admin.pages.itemLedger.dirIn" : "admin.pages.itemLedger.dirOut") }}
          </span>
        </template>
        <template #cell-txnType="{ row }">{{ txnTypeLabel(row.txnType) }}</template>
        <template #cell-qtyDelta="{ row }">
          <span class="qty" :class="row.qtyDelta >= 0 ? 'qty-in' : 'qty-out'">
            {{ row.qtyDelta > 0 ? `+${row.qtyDelta}` : row.qtyDelta }}
          </span>
        </template>
        <template #cell-order="{ row }">
          <NuxtLink v-if="row.pickingOrderId" :to="`/picking-orders/${row.pickingOrderId}`">
            {{ row.pickingOrderNo ?? row.pickingOrderId }}
          </NuxtLink>
          <NuxtLink v-else-if="row.receivingOrderId" :to="`/receiving/${row.receivingOrderId}`">
            {{ row.receivingBatchNo ?? row.receivingOrderId }}
          </NuxtLink>
          <span v-else class="muted">{{ row.referenceType ?? "—" }}</span>
        </template>
        <template #cell-qtyType="{ row }">{{ qtyTypeLabel(row.qtyType) }}</template>
        <template #cell-dateCode="{ row }">{{ row.dateCode ?? "—" }}</template>
        <template #cell-lotCode="{ row }">{{ row.lotCode ?? "—" }}</template>
        <template #cell-coo="{ row }">{{ row.coo ?? "—" }}</template>
        <template #cell-cow="{ row }">{{ row.cow ?? "—" }}</template>
        <template #cell-actorName="{ row }">{{ row.actorName ?? "—" }}</template>
        <template #cell-txnReason="{ row }">{{ row.txnReason ?? "—" }}</template>
      </DataTable>
    </template>

    <div v-else-if="!searched" class="muted pick-prompt">{{ $t("admin.pages.itemLedger.pickPrompt") }}</div>
  </div>
</template>

<style scoped>
.part-picker {
  position: relative;
  width: 26rem;
  max-width: 100%;
  margin-bottom: 0.75rem;
}
.part-input {
  width: 100%;
  padding: 0.4375rem 0.5625rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  font-size: 0.875rem;
}
.suggest-list {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 20;
  background: #fff;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  box-shadow: 0 8px 20px rgba(15, 23, 32, 0.15);
  max-height: 18rem;
  overflow-y: auto;
}
.suggest-item {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  width: 100%;
  padding: 0.4375rem 0.5625rem;
  border: 0;
  background: none;
  text-align: left;
  font-size: 0.875rem;
  cursor: pointer;
}
.suggest-item:hover {
  background: #f0f4f8;
}
.suggest-main {
  font-weight: 600;
}
.suggest-sub {
  font-size: 0.75rem;
}
.suggest-empty {
  padding: 0.5rem 0.5625rem;
  font-size: 0.8125rem;
}
.summary-card {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  border: 1px solid #d5dee6;
  border-radius: 0.5rem;
  background: #f8fafc;
}
.summary-partno {
  font-size: 1.0625rem;
  font-weight: 700;
}
.summary-totals {
  display: flex;
  gap: 1.5rem;
}
.stat {
  text-align: right;
}
.stat-value {
  font-size: 1.25rem;
  font-weight: 700;
}
.stat-label {
  font-size: 0.75rem;
  color: #52606d;
}
.section-title {
  margin: 1rem 0 0.5rem;
  font-size: 0.9375rem;
}
.stock-table {
  border-collapse: collapse;
  font-size: 0.8125rem;
  background: #fff;
}
.stock-table th,
.stock-table td {
  padding: 0.375rem 0.5625rem;
  border: 1px solid #d5dee6;
  text-align: left;
  white-space: nowrap;
}
.stock-table th {
  background: #f0f4f8;
  font-weight: 600;
}
.stock-table .num {
  text-align: right;
}
.dir-badge {
  display: inline-block;
  padding: 0.0625rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
}
.dir-in {
  background: #e9f7ef;
  border: 1px solid #b5e2c8;
  color: #1e7a46;
}
.dir-out {
  background: #fdecec;
  border: 1px solid #f0b9b9;
  color: #b3382c;
}
.qty {
  font-weight: 600;
}
.qty-in {
  color: #1e7a46;
}
.qty-out {
  color: #b3382c;
}
.pick-prompt {
  margin-top: 1rem;
}
</style>
