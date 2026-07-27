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
            <th>#</th>
            <th>{{ $t("admin.pages.pickingOrders.orderNo") }}</th>
            <th>{{ $t("admin.pages.pickingOrders.status") }}</th>
            <th>{{ $t("admin.pages.pickingOrders.customer") }}</th>
            <th>{{ $t("admin.pages.pickingOrders.poNo") }}</th>
            <th>{{ $t("admin.pages.pickingOrders.shipTo") }}</th>
            <th>{{ $t("admin.pages.pickingOrders.deliveryDate") }}</th>
            <th>{{ $t("admin.pages.pickingOrders.items") }}</th>
            <th>{{ $t("admin.pages.pickingOrders.pickedTotal") }}</th>
            <th>{{ $t("admin.pages.pickingOrders.lockedBy") }}</th>
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
            <td colspan="10" class="muted">{{ $t("admin.pages.pickingOrders.none") }}</td>
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
