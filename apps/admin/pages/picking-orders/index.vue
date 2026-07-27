<script setup lang="ts">
import type { PickingOrderRow } from "~/utils/flowApi";

const flow = useFlowApi();
const rows = ref<PickingOrderRow[]>([]);
const loading = ref(false);
const error = ref("");
const status = ref("");
const search = ref("");

const STATUSES = ["", "pending", "picking", "finished", "issue"];

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

const { page, pageSize, total, paged } = usePaging(filtered);

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
      <h1>Picking Orders</h1>
      <NuxtLink to="/picking/reorder" class="btn">Reorder priority</NuxtLink>
    </div>

    <div class="filters">
      <select v-model="status">
        <option v-for="s in STATUSES" :key="s" :value="s">{{ s || "All statuses" }}</option>
      </select>
      <input v-model="search" placeholder="Search order no / customer / PO / ship-to" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">Loading…</div>

    <div v-else class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>#</th>
            <th>Order No</th>
            <th>Status</th>
            <th>Customer</th>
            <th>PO No</th>
            <th>Ship To</th>
            <th>Delivery Date</th>
            <th>Items</th>
            <th>Picked / Total</th>
            <th>Locked By</th>
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
            <td>{{ r.workingByName ?? "" }}</td>
          </tr>
          <tr v-if="total === 0">
            <td colspan="10" class="muted">No picking orders.</td>
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
</style>
