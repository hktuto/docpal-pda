<script setup lang="ts">
import type { AdminColumnDef } from "~/composables/useAdminTable";

const route = useRoute();
const api = useApi();
const { t } = useI18n();

const box = ref<any | null>(null);
const error = ref("");
const loading = ref(true);

const items = computed<any[]>(() => box.value?.items ?? []);

const columnDefs = computed<AdminColumnDef[]>(() => [
  {
    key: "partNo",
    label: t("admin.pages.shelfBoxes.partNo"),
    accessor: (item) => item.wclItemNo ?? item.partNo,
    size: 160,
  },
  { key: "qty", label: t("admin.pages.shelfBoxes.qty"), size: 80 },
  { key: "verified", label: t("admin.pages.shelfBoxes.verified"), size: 100 },
  { key: "verifiedAt", label: t("admin.pages.shelfBoxes.verifiedAt"), size: 170 },
]);

const { table, resetColumnState } = useAdminTable({
  tableId: "shelf-box-detail-items",
  columns: columnDefs,
  rows: items,
  getRowId: (item) => item.id,
});

onMounted(async () => {
  try {
    box.value = await api.get(`/admin/shelf-boxes/${route.params.id}`);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.shelfBoxes.detailTitle", { id: route.params.id.slice(0, 8) }) }}</h1>
      <NuxtLink to="/shelf-boxes" class="btn">{{ $t("admin.pages.shelfBoxes.backToList") }}</NuxtLink>
    </div>
    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>
    <template v-else-if="box">
      <div class="detail-grid">
        <div>
          <div class="dt">{{ $t("admin.pages.shelfBoxes.id") }}</div>
          <div class="dd">{{ box.id }}</div>
        </div>
        <div>
          <div class="dt">{{ $t("admin.pages.shelfBoxes.shelf") }}</div>
          <div class="dd">{{ formatCell(box.shelfCode) }}</div>
        </div>
        <div>
          <div class="dt">{{ $t("admin.pages.shelfBoxes.orgId") }}</div>
          <div class="dd">{{ formatCell(box.orgId) }}</div>
        </div>
        <div>
          <div class="dt">{{ $t("admin.pages.shelfBoxes.subInventory") }}</div>
          <div class="dd">{{ formatCell(box.subInventoryCode) }}</div>
        </div>
        <div>
          <div class="dt">{{ $t("admin.pages.shelfBoxes.status") }}</div>
          <div class="dd">{{ box.status }}</div>
        </div>
        <div>
          <div class="dt">{{ $t("admin.pages.shelfBoxes.created") }}</div>
          <div class="dd">{{ formatCell(box.createdDate) }}</div>
        </div>
      </div>
      <h2 style="font-size: 16px">{{ $t("admin.pages.shelfBoxes.items") }}</h2>
      <DataTable
        :table="table"
        :empty-text="$t('admin.pages.shelfBoxes.noItems')"
        :on-reset-columns="resetColumnState"
      />
    </template>
  </div>
</template>
