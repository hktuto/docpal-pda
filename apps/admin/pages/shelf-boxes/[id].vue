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
      <h1>Shelf Box {{ route.params.id.slice(0, 8) }}</h1>
      <NuxtLink to="/shelf-boxes" class="btn">← Back to Shelf Boxes</NuxtLink>
    </div>
    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">Loading…</div>
    <template v-else-if="box">
      <div class="detail-grid">
        <div>
          <div class="dt">ID</div>
          <div class="dd">{{ box.id }}</div>
        </div>
        <div>
          <div class="dt">Shelf</div>
          <div class="dd">{{ formatCell(box.shelfCode) }}</div>
        </div>
        <div>
          <div class="dt">Org ID</div>
          <div class="dd">{{ formatCell(box.orgId) }}</div>
        </div>
        <div>
          <div class="dt">Sub-inventory</div>
          <div class="dd">{{ formatCell(box.subInventoryCode) }}</div>
        </div>
        <div>
          <div class="dt">Status</div>
          <div class="dd">{{ box.status }}</div>
        </div>
        <div>
          <div class="dt">Created</div>
          <div class="dd">{{ formatCell(box.createdAt) }}</div>
        </div>
      </div>
      <h2 style="font-size: 16px">Items</h2>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>Part no</th>
              <th>Qty</th>
              <th>Verified</th>
              <th>Verified at</th>
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
              <td colspan="4" class="muted">No items in this box.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
