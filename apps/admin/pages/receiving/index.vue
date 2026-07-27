<script setup lang="ts">
import type { ReceivingOrderRow } from "~/utils/flowApi";

const flow = useFlowApi();
const rows = ref<ReceivingOrderRow[]>([]);
const loading = ref(false);
const error = ref("");
const status = ref("");
const search = ref("");

const STATUSES = ["", "pending", "in_hand", "provisional_received", "clear"];

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

const { page, pageSize, total, paged } = usePaging(filtered);

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
            <th>{{ $t("admin.pages.receiving.batchNo") }}</th>
            <th>{{ $t("admin.pages.receiving.status") }}</th>
            <th>{{ $t("admin.pages.receiving.supplier") }}</th>
            <th>{{ $t("admin.pages.receiving.deliveryDate") }}</th>
            <th>{{ $t("admin.pages.receiving.invoices") }}</th>
            <th>{{ $t("admin.pages.receiving.items") }}</th>
            <th>{{ $t("admin.pages.receiving.remaining") }}</th>
            <th>{{ $t("admin.pages.receiving.pendingPicking") }}</th>
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
          </tr>
          <tr v-if="total === 0">
            <td colspan="8" class="muted">{{ $t("admin.pages.receiving.none") }}</td>
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
