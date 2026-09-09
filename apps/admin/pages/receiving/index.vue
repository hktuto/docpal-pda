<script setup lang="ts">
import type { ReceivingOrderRow } from "~/utils/flowApi";

const flow = useFlowApi();
const rows = ref<ReceivingOrderRow[]>([]);
const loading = ref(false);
const error = ref("");
const status = ref("");
const search = ref("");

const STATUSES = ["", "pending", "in_hand", "provisional_received", "clear"];

const { sortKey, sortDir, toggleSort, sortRows } = useColumnSort("admin-sort:receiving-list");

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(
    (r) =>
      r.batchNo.toLowerCase().includes(q) ||
      (r.supplierCode ?? "").toLowerCase().includes(q) ||
      (r.supplierName ?? "").toLowerCase().includes(q)
  );
});

// Display values for derived columns (mirror what the <td> renders).
function getVal(r: ReceivingOrderRow, key: string): unknown {
  switch (key) {
    case "supplier":
      return r.supplierName ?? r.supplierCode ?? "";
    case "deliveryDate":
      return r.deliveryDate ?? "";
    case "createdDate":
      return r.createdDate;
    case "lastUpdateDate":
      return r.lastUpdateDate;
    default:
      return (r as any)[key];
  }
}

const sorted = computed(() => sortRows(filtered.value, getVal));

const { page, pageSize, total, paged } = usePaging(sorted);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = await flow.listReceivingOrders(status.value || undefined);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

watch(status, load);
onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.receiving.title") }}</h1>
      <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
    </div>

    <div class="filters">
      <select v-model="status">
        <option v-for="s in STATUSES" :key="s" :value="s">{{ s || $t("admin.common.allStatuses") }}</option>
      </select>
      <input v-model="search" :placeholder="$t('admin.pages.receiving.searchPlaceholder')" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <div v-else class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th class="sortable" @click="toggleSort('batchNo')">
              {{ $t("admin.pages.receiving.batchNo") }}
              <span v-if="sortKey === 'batchNo'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('status')">
              {{ $t("admin.pages.receiving.status") }}
              <span v-if="sortKey === 'status'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('supplier')">
              {{ $t("admin.pages.receiving.supplier") }}
              <span v-if="sortKey === 'supplier'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('deliveryDate')">
              {{ $t("admin.pages.receiving.deliveryDate") }}
              <span v-if="sortKey === 'deliveryDate'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('invoiceCount')">
              {{ $t("admin.pages.receiving.invoices") }}
              <span v-if="sortKey === 'invoiceCount'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('itemCount')">
              {{ $t("admin.pages.receiving.items") }}
              <span v-if="sortKey === 'itemCount'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('remainingItems')">
              {{ $t("admin.pages.receiving.remaining") }}
              <span v-if="sortKey === 'remainingItems'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('pendingPickingOrders')">
              {{ $t("admin.pages.receiving.pendingPicking") }}
              <span v-if="sortKey === 'pendingPickingOrders'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('createdDate')">
              {{ $t("admin.common.createdDate") }}
              <span v-if="sortKey === 'createdDate'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('lastUpdateDate')">
              {{ $t("admin.common.lastUpdateDate") }}
              <span v-if="sortKey === 'lastUpdateDate'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in paged" :key="r.id" class="clickable" @click="navigateTo(`/receiving/${r.id}`)">
            <td>{{ r.batchNo }}</td>
            <td>{{ r.status }}</td>
            <td>{{ r.supplierName ?? r.supplierCode ?? "—" }}</td>
            <td>{{ r.deliveryDate ? new Date(r.deliveryDate).toLocaleDateString() : "—" }}</td>
            <td>{{ r.invoiceCount }}</td>
            <td>{{ r.itemCount }}</td>
            <td>{{ r.remainingItems }}</td>
            <td>{{ r.pendingPickingOrders }}</td>
            <td>{{ new Date(r.createdDate).toLocaleString() }}</td>
            <td>{{ new Date(r.lastUpdateDate).toLocaleString() }}</td>
          </tr>
          <tr v-if="total === 0">
            <td colspan="10" class="muted">{{ $t("admin.pages.receiving.none") }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}
.filters select,
.filters input {
  padding: 7px 9px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
  font-size: 14px;
}
.filters input {
  flex: 1;
}
tr.clickable {
  cursor: pointer;
}
th.sortable {
  cursor: pointer;
  user-select: none;
}
th.sortable:hover {
  color: var(--brand-teal-dark);
}
.sort-arrow {
  font-size: 9px;
  margin-left: 3px;
}
</style>
