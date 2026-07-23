<script setup lang="ts">
import type { MeasuringTaskRow } from "~/utils/flowApi";

const flow = useFlowApi();
const rows = ref<MeasuringTaskRow[]>([]);
const loading = ref(false);
const error = ref("");
const search = ref("");
const selected = ref<Record<string, boolean>>({});

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(
    (r) => r.orderNo.toLowerCase().includes(q) || (r.shipTo ?? "").toLowerCase().includes(q)
  );
});

const { page, pageSize, total, paged } = usePaging(filtered);

const selectedIds = computed(() => Object.keys(selected.value).filter((id) => selected.value[id]));

async function load() {
  loading.value = true;
  error.value = "";
  try {
    // A shipping order = a completed measuring task (per the admin TOC review).
    rows.value = await flow.listMeasuringTasks("completed");
    selected.value = {};
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
      <h1>Shipping Orders</h1>
      <button
        class="btn"
        :disabled="selectedIds.length === 0"
        :title="`Format pending — available in a later update (${selectedIds.length} selected)`"
      >
        Download shipper{{ selectedIds.length ? ` (${selectedIds.length})` : "" }}
      </button>
    </div>

    <div class="filters">
      <input v-model="search" placeholder="Search order no / ship-to" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">Loading…</div>

    <div v-else class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th></th>
            <th>Order No</th>
            <th>Ship To</th>
            <th>Boxes</th>
            <th>Completed</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in paged" :key="r.id">
            <td @click.stop>
              <input v-model="selected[r.id]" type="checkbox" />
            </td>
            <td class="clickable" @click="navigateTo(`/shipping/${r.id}`)">{{ r.orderNo }}</td>
            <td>{{ r.shipTo ?? "—" }}</td>
            <td>{{ r.closedBoxCount }} / {{ r.boxCount }} closed</td>
            <td>{{ new Date(r.createdAt).toLocaleDateString() }}</td>
          </tr>
          <tr v-if="total === 0">
            <td colspan="5" class="muted">No completed shipping orders.</td>
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
.filters input {
  flex: 1;
  padding: 7px 9px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
  font-size: 14px;
}
.clickable {
  cursor: pointer;
  color: #0b5cab;
}
</style>
