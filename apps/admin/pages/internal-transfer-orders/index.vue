<script setup lang="ts">
import type { InternalTransferOrderRow } from "~/utils/flowApi";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

// Internal transfer orders — admin list of the upstream-synced
// internal_transfer_orders table (stage 1 spec
// 2026-11-10-internal-transfer-admin-allocate-design.md: the detail page
// allocates + assigns delegated picking orders). The sync service writes SQL
// directly, so this page refreshes on mount / manual refresh.
const flow = useFlowApi();
const { t } = useI18n();

const STATUSES = ["pending", "allocated", "picking", "issue", "finished"];

const status = ref("");
const search = ref("");
const page = ref(1);
const pageSize = ref(50);
const total = ref(0);

const statusOptions = computed<SearchableSelectOption[]>(() =>
  STATUSES.map((s) => ({ value: s, label: t(`internalTransfer.status.${s}`) }))
);

const rows = ref<InternalTransferOrderRow[]>([]);
const loading = ref(true);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const res = await flow.listInternalTransferOrders({
      status: status.value || undefined,
      search: search.value.trim() || undefined,
      page: page.value,
      pageSize: pageSize.value,
    });
    rows.value = res.rows;
    total.value = res.total;
  } catch (e: any) {
    error.value = e?.message ?? String(e);
    rows.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

// Filter/search changes reload from page 1 (the page watcher performs the
// reload when the page actually changes).
function resetPageAndLoad() {
  if (page.value !== 1) page.value = 1;
  else load();
}

watch(status, resetPageAndLoad);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(resetPageAndLoad, 300);
});
watch(page, load);
watch(pageSize, load);

onMounted(load);

function fmtLoc(orgId: number | null, code: string | null): string {
  return orgId === null && !code ? "—" : `${orgId ?? "?"} / ${code ?? "?"}`;
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("internalTransfer.title") }}</h1>
      <button class="btn" :disabled="loading" @click="load">
        {{ $t("admin.common.refresh") }}
      </button>
    </div>

    <p class="muted explainer">{{ $t("internalTransfer.explainer") }}</p>

    <div class="filters">
      <SearchableSelect
        v-model="status"
        :options="statusOptions"
        :all-label="$t('admin.common.allStatuses')"
        :aria-label="$t('internalTransfer.colStatus')"
        :multiple="false"
      />
      <input v-model="search" class="filter-search" :placeholder="$t('internalTransfer.searchPlaceholder')" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <div v-else class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>{{ $t("internalTransfer.colOrderNo") }}</th>
            <th>{{ $t("internalTransfer.colFrom") }}</th>
            <th>{{ $t("internalTransfer.colTo") }}</th>
            <th>{{ $t("internalTransfer.colStatus") }}</th>
            <th>{{ $t("internalTransfer.colAllocation") }}</th>
            <th class="num">{{ $t("internalTransfer.colItems") }}</th>
            <th class="num">{{ $t("internalTransfer.colPicked") }}</th>
            <th>{{ $t("internalTransfer.colCustomer") }}</th>
            <th>{{ $t("internalTransfer.colCreated") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td>
              <NuxtLink :to="`/internal-transfer-orders/${row.id}`">{{ row.orderNo }}</NuxtLink>
              <span v-if="row.linked" :title="$t('internalTransfer.assignTitle')"> 🔗</span>
            </td>
            <td>{{ fmtLoc(row.fromOrgId, row.fromSubInventoryCode) }}</td>
            <td>{{ fmtLoc(row.toOrgId, row.toSubInventoryCode) }}</td>
            <td>{{ $t(`internalTransfer.status.${row.status}`) }}</td>
            <td>{{ $t(`status.allocation.${row.allocationStatus}`) }}</td>
            <td class="num">{{ row.itemCount }} / {{ row.totalQty }}</td>
            <td class="num">{{ row.pickedQty }} / {{ row.allocatedQty }}</td>
            <td>{{ row.customerName ?? "—" }}</td>
            <td>{{ new Date(row.createdDate).toLocaleString() }}</td>
          </tr>
          <tr v-if="rows.length === 0">
            <td :colspan="9" class="muted">{{ $t("internalTransfer.none") }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />
  </div>
</template>

<style scoped>
.explainer {
  margin: 0 0 1rem;
}

.filters {
  display: flex;
  gap: 0.75rem;
  max-width: 36rem;
  margin-bottom: 1rem;
}

.filters .filter-search {
  flex: 1;
  padding: 0.4375rem 0.5625rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  font-size: 0.875rem;
}

.num {
  text-align: right;
}
</style>
