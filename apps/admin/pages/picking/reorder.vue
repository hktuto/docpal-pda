<script setup lang="ts">
import type { PickingOrderRow } from "~/utils/flowApi";

const flow = useFlowApi();
const rows = ref<PickingOrderRow[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const saved = ref("");
const dirty = ref(false);

/** Open orders in current priority order (editable local copy). */
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const all = await flow.listPickingOrders();
    rows.value = all.filter((r) => r.status === "pending" || r.status === "picking");
    dirty.value = false;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function move(index: number, delta: -1 | 1) {
  const target = index + delta;
  if (target < 0 || target >= rows.value.length) return;
  const copy = [...rows.value];
  [copy[index], copy[target]] = [copy[target], copy[index]];
  rows.value = copy;
  dirty.value = true;
  saved.value = "";
}

function moveToTop(index: number) {
  if (index <= 0) return;
  const copy = [...rows.value];
  const [row] = copy.splice(index, 1);
  copy.unshift(row);
  rows.value = copy;
  dirty.value = true;
  saved.value = "";
}

async function save() {
  saving.value = true;
  error.value = "";
  saved.value = "";
  try {
    const res = await flow.reorderPickingOrders(rows.value.map((r) => r.id));
    saved.value = `Saved — ${res.reordered} orders re-prioritized; allocations recomputed.`;
    await load();
    saved.value = `Saved — ${res.reordered} orders re-prioritized; allocations recomputed.`;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>Reorder Picking Priority</h1>
      <div>
        <NuxtLink to="/picking-orders" class="btn">Back to list</NuxtLink>
        <button class="btn btn-primary" :disabled="!dirty || saving" @click="save">
          {{ saving ? "Saving…" : "Save order" }}
        </button>
      </div>
    </div>

    <p class="muted">
      Top of the list is allocated stock first. Saving re-prioritizes all open orders and
      immediately re-runs allocation (orders being worked on a PDA keep their allocations).
    </p>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="saved" class="ok-banner">{{ saved }}</div>
    <div v-if="loading" class="loading">Loading…</div>

    <div v-else class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 90px">Move</th>
            <th>Order No</th>
            <th>Status</th>
            <th>Customer</th>
            <th>Delivery Date</th>
            <th>Picked / Total</th>
            <th>Locked By</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in rows" :key="r.id">
            <td class="actions">
              <button class="btn btn-small" :disabled="i === 0" title="Move to top" @click="moveToTop(i)">⇤</button>
              <button class="btn btn-small" :disabled="i === 0" @click="move(i, -1)">↑</button>
              <button class="btn btn-small" :disabled="i === rows.length - 1" @click="move(i, 1)">↓</button>
            </td>
            <td>{{ r.orderNo }}</td>
            <td>{{ r.status }}</td>
            <td>{{ r.customerCode ?? "—" }}</td>
            <td>{{ r.deliveryDate ? new Date(r.deliveryDate).toLocaleDateString() : "—" }}</td>
            <td>{{ r.pickedQty }} / {{ r.totalQty }}</td>
            <td>{{ r.workingByName ?? "" }}</td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="7" class="muted">No open picking orders.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.ok-banner {
  background: #e7f6ec;
  border: 1px solid #9ed9b1;
  color: #1e6b3a;
  border-radius: 4px;
  padding: 8px 12px;
  margin-bottom: 12px;
}
.page-head > div {
  display: flex;
  gap: 10px;
}
</style>
