<script setup lang="ts">
const route = useRoute();
const api = useApi();

const box = ref<any | null>(null);
const error = ref("");
const loading = ref(true);

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
          <div class="dd">{{ formatCell(box.createdAt) }}</div>
        </div>
      </div>
      <h2 style="font-size: 16px">{{ $t("admin.pages.shelfBoxes.items") }}</h2>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("admin.pages.shelfBoxes.partNo") }}</th>
              <th>{{ $t("admin.pages.shelfBoxes.qty") }}</th>
              <th>{{ $t("admin.pages.shelfBoxes.verified") }}</th>
              <th>{{ $t("admin.pages.shelfBoxes.verifiedAt") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in box.items" :key="item.id">
              <td>{{ item.partNo }}</td>
              <td>{{ item.qty }}</td>
              <td>{{ formatCell(item.verified) }}</td>
              <td>{{ formatCell(item.verifiedAt) }}</td>
            </tr>
            <tr v-if="box.items.length === 0">
              <td colspan="4" class="muted">{{ $t("admin.pages.shelfBoxes.noItems") }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
