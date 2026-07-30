<script setup lang="ts">
import type { ShippingOrderRow } from "~/utils/flowApi";

const flow = useFlowApi();
const { t } = useI18n();
const rows = ref<ShippingOrderRow[]>([]);
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

const shipping = ref(false);

function orderNo(id: string) {
  return rows.value.find((r) => r.pickingOrderId === id)?.orderNo ?? id;
}

async function markShipped() {
  const ids = selectedIds.value;
  if (ids.length === 0 || shipping.value) return;
  if (!window.confirm(t("admin.pages.shipping.markShippedConfirm", { n: ids.length }))) return;
  shipping.value = true;
  error.value = "";
  try {
    await flow.shipShippingOrders(ids);
    await load();
    selected.value = {};
  } catch (e: any) {
    // Partial failure: shipShippingOrders attempts every id and lists the
    // per-order failures (e.g. 409 order_not_ready_to_ship) on `failed`.
    const failed: { id: string; message: string }[] = e?.failed ?? [];
    error.value =
      failed.length > 0
        ? t("admin.pages.shipping.markShippedFailed", {
            orders: failed.map((f) => `${orderNo(f.id)} (${f.message})`).join(", "),
          })
        : e.message;
    await load();
    selected.value = {};
  } finally {
    shipping.value = false;
  }
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    // The backend's config-aware feed: whatever step ends the enabled chain.
    rows.value = await flow.listShippingOrders();
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
      <h1>{{ $t("admin.pages.shipping.title") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
        <button
          class="btn"
          :disabled="selectedIds.length === 0 || shipping"
          @click="markShipped"
        >
          {{
            selectedIds.length
              ? $t("admin.pages.shipping.markShippedSelected", { n: selectedIds.length })
              : $t("admin.pages.shipping.markShipped")
          }}
        </button>
        <button
          class="btn"
          :disabled="selectedIds.length === 0"
          :title="$t('admin.pages.shipping.downloadPendingSelected', { n: selectedIds.length })"
        >
          {{
            selectedIds.length
              ? $t("admin.pages.shipping.downloadShipperSelected", { n: selectedIds.length })
              : $t("admin.pages.shipping.downloadShipper")
          }}
        </button>
      </div>
    </div>

    <div class="filters">
      <input v-model="search" :placeholder="$t('admin.pages.shipping.searchPlaceholder')" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <div v-else class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th></th>
            <th>{{ $t("admin.pages.shipping.orderNo") }}</th>
            <th>{{ $t("admin.pages.shipping.shipTo") }}</th>
            <th>{{ $t("admin.pages.shipping.boxes") }}</th>
            <th>{{ $t("admin.pages.shipping.completed") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in paged" :key="r.pickingOrderId">
            <td @click.stop>
              <input v-model="selected[r.pickingOrderId]" type="checkbox" />
            </td>
            <td class="clickable" @click="navigateTo(`/shipping/${r.pickingOrderId}`)">{{ r.orderNo }}</td>
            <td>{{ r.shipTo ?? "—" }}</td>
            <td>{{ $t("admin.pages.shipping.boxesClosed", { closed: r.closedBoxCount, total: r.boxCount }) }}</td>
            <td>{{ new Date(r.completedAt).toLocaleDateString() }}</td>
          </tr>
          <tr v-if="total === 0">
            <td colspan="5" class="muted">{{ $t("admin.pages.shipping.none") }}</td>
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
