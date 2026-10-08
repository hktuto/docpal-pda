<script setup lang="ts">
const { t } = useI18n();
const api = useApi();
const route = useRoute();

const batch = ref<any | null>(null);
const loading = ref(false);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    batch.value = await api.get(`/admin/ad-hoc-put-aways/${route.params.id}`);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.adHocPutAways.detailTitle", { id: String(route.params.id).slice(0, 8) }) }}</h1>
      <div class="head-actions">
        <NuxtLink to="/ad-hoc-put-aways" class="btn">
          {{ $t("admin.pages.adHocPutAways.backToList") }}
        </NuxtLink>
        <button class="btn" :disabled="loading" @click="load">
          {{ $t("admin.common.refresh") }}
        </button>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <template v-else-if="batch">
      <!-- Batch header info -->
      <div class="detail-grid">
        <div class="detail-item">
          <span class="dt">{{ $t("admin.pages.adHocPutAways.id") }}</span>
          <span class="dd">{{ batch.id }}</span>
        </div>
        <div class="detail-item">
          <span class="dt">{{ $t("admin.pages.adHocPutAways.supplier") }}</span>
          <span class="dd">{{ batch.supplierCode }}</span>
        </div>
        <div class="detail-item">
          <span class="dt">{{ $t("admin.pages.adHocPutAways.shelf") }}</span>
          <span class="dd">{{ batch.shelfCode }}</span>
        </div>
        <div class="detail-item">
          <span class="dt">{{ $t("admin.pages.adHocPutAways.org") }}</span>
          <span class="dd">{{ batch.orgId }}</span>
        </div>
        <div class="detail-item">
          <span class="dt">{{ $t("admin.pages.adHocPutAways.subInventory") }}</span>
          <span class="dd">{{ batch.subInventoryCode }}</span>
        </div>
        <div class="detail-item">
          <span class="dt">{{ $t("admin.pages.adHocPutAways.itemCount") }}</span>
          <span class="dd">{{ batch.itemCount }}</span>
        </div>
        <div class="detail-item">
          <span class="dt">{{ $t("admin.pages.adHocPutAways.totalQty") }}</span>
          <span class="dd">{{ batch.totalQty }}</span>
        </div>
        <div class="detail-item">
          <span class="dt">{{ $t("admin.pages.adHocPutAways.actor") }}</span>
          <span class="dd">{{ batch.actorId?.slice(0, 8) }}</span>
        </div>
        <div class="detail-item">
          <span class="dt">{{ $t("admin.pages.adHocPutAways.created") }}</span>
          <span class="dd">{{ new Date(batch.createdDate).toLocaleString() }}</span>
        </div>
      </div>

      <!-- Items table -->
      <h2 class="items-title">{{ $t("admin.pages.adHocPutAways.items") }}</h2>
      <table class="items-table">
        <thead>
          <tr>
            <th>{{ $t("admin.pages.adHocPutAways.partNo") }}</th>
            <th>{{ $t("admin.pages.adHocPutAways.wclItemNo") }}</th>
            <th>{{ $t("admin.pages.adHocPutAways.qty") }}</th>
            <th>{{ $t("admin.pages.adHocPutAways.dateCode") }}</th>
            <th>{{ $t("admin.pages.adHocPutAways.lotCode") }}</th>
            <th>{{ $t("admin.pages.adHocPutAways.coo") }}</th>
            <th>{{ $t("admin.pages.adHocPutAways.cow") }}</th>
            <th>{{ $t("admin.pages.adHocPutAways.serialNo") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, idx) in batch.items" :key="idx">
            <td>{{ item.partNo }}</td>
            <td>{{ item.wclItemNo || "—" }}</td>
            <td>{{ item.qty }}</td>
            <td>{{ item.dateCode || "—" }}</td>
            <td>{{ item.lotCode || "—" }}</td>
            <td>{{ item.coo || "—" }}</td>
            <td>{{ item.cow || "—" }}</td>
            <td>{{ item.serialNo || "—" }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>

<style scoped>
.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
}
.detail-item {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.detail-item .dt {
  font-size: 0.8125rem;
  color: var(--muted-foreground, #64748b);
}
.detail-item .dd {
  font-size: 0.9375rem;
  font-weight: 600;
}
.items-title {
  font-size: 1rem;
  margin-bottom: 0.5rem;
}
.items-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}
.items-table th,
.items-table td {
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border, #e2e8f0);
  text-align: left;
}
.items-table th {
  font-weight: 600;
  background: var(--surface, #f8fafc);
}
</style>
