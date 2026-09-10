<script setup lang="ts">
import type { PickingOrderRow } from "~/utils/flowApi";

const flow = useFlowApi();
const rows = ref<PickingOrderRow[]>([]);
const loading = ref(false);
const error = ref("");
const status = ref("");
const search = ref("");

const STATUSES = ["", "pending", "picking", "finished", "issue", "shipped"];

const { sortKey, sortDir, toggleSort, sortRows } = useColumnSort("admin-sort:picking-list");

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(
    (r) =>
      r.orderNo.toLowerCase().includes(q) ||
      (r.customerCode ?? "").toLowerCase().includes(q) ||
      (r.poNo ?? "").toLowerCase().includes(q) ||
      (r.shipTo ?? "").toLowerCase().includes(q)
  );
});

// Display values for derived columns (mirror what the <td> renders).
function getVal(r: PickingOrderRow, key: string): unknown {
  switch (key) {
    case "pickedRatio":
      return r.totalQty > 0 ? r.pickedQty / r.totalQty : 0;
    case "allocation":
      return r.totalQty > 0 ? r.allocatedQty / r.totalQty : 0;
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
    rows.value = await flow.listPickingOrders(status.value || undefined);
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
      <h1>{{ $t("admin.pages.pickingOrders.title") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
        <NuxtLink to="/picking/reorder" class="btn">{{ $t("admin.pages.pickingOrders.reorderPriority") }}</NuxtLink>
      </div>
    </div>

    <div class="filters">
      <select v-model="status">
        <option v-for="s in STATUSES" :key="s" :value="s">{{ s || $t("admin.common.allStatuses") }}</option>
      </select>
      <input v-model="search" :placeholder="$t('admin.pages.pickingOrders.searchPlaceholder')" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <div v-else class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th class="sortable" @click="toggleSort('prioritySeq')">
              #
              <span v-if="sortKey === 'prioritySeq'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('orderNo')">
              {{ $t("admin.pages.pickingOrders.orderNo") }}
              <span v-if="sortKey === 'orderNo'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('status')">
              {{ $t("admin.pages.pickingOrders.status") }}
              <span v-if="sortKey === 'status'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('customerCode')">
              {{ $t("admin.pages.pickingOrders.customer") }}
              <span v-if="sortKey === 'customerCode'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('poNo')">
              {{ $t("admin.pages.pickingOrders.poNo") }}
              <span v-if="sortKey === 'poNo'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('shipTo')">
              {{ $t("admin.pages.pickingOrders.shipTo") }}
              <span v-if="sortKey === 'shipTo'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('deliveryDate')">
              {{ $t("admin.pages.pickingOrders.deliveryDate") }}
              <span v-if="sortKey === 'deliveryDate'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('itemCount')">
              {{ $t("admin.pages.pickingOrders.items") }}
              <span v-if="sortKey === 'itemCount'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('pickedRatio')">
              {{ $t("admin.pages.pickingOrders.pickedTotal") }}
              <span v-if="sortKey === 'pickedRatio'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('allocation')">
              {{ $t("admin.pages.pickingOrders.allocation") }}
              <span v-if="sortKey === 'allocation'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('workingByName')">
              {{ $t("admin.pages.pickingOrders.lockedBy") }}
              <span v-if="sortKey === 'workingByName'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
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
          <tr v-for="r in paged" :key="r.id" class="clickable" @click="navigateTo(`/picking-orders/${r.id}`)">
            <td class="muted">{{ r.prioritySeq }}</td>
            <td>{{ r.orderNo }}</td>
            <td>{{ r.status }}</td>
            <td>{{ r.customerCode ?? "—" }}</td>
            <td>{{ r.poNo ?? "—" }}</td>
            <td>{{ r.shipTo ?? "—" }}</td>
            <td>{{ r.deliveryDate ? new Date(r.deliveryDate).toLocaleDateString() : "—" }}</td>
            <td>{{ r.itemCount }}</td>
            <td>{{ r.pickedQty }} / {{ r.totalQty }}</td>
            <td>
              {{ $t(`admin.pages.pickingOrders.allocationLabels.${r.allocationStatus}`) }}
              ({{ r.allocatedQty }} / {{ r.totalQty }})
            </td>
            <td>{{ r.workingByName ?? "" }}</td>
            <td>{{ new Date(r.createdDate).toLocaleString() }}</td>
            <td>{{ new Date(r.lastUpdateDate).toLocaleString() }}</td>
          </tr>
          <tr v-if="total === 0">
            <td colspan="13" class="muted">{{ $t("admin.pages.pickingOrders.none") }}</td>
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
