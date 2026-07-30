<script setup lang="ts">
import type { StockSearchResult } from "~/utils/flowApi";

const api = useApi();
const flow = useFlowApi();

const suppliers = ref<{ id: string; code: string; name: string }[]>([]);
const supplierCode = ref("");
const partNo = ref("");

const result = ref<StockSearchResult | null>(null);
const searched = ref(false);
const loading = ref(false);
const error = ref("");

async function loadSuppliers() {
  try {
    suppliers.value = await api.get("/admin/suppliers");
  } catch {
    suppliers.value = [];
  }
}

async function search() {
  loading.value = true;
  error.value = "";
  try {
    result.value = await flow.stockSearch({
      supplierCode: supplierCode.value || undefined,
      partNo: partNo.value.trim() || undefined,
    });
    searched.value = true;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(loadSuppliers);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.stockSearch.title") }}</h1>
    </div>

    <div class="filters">
      <select v-model="supplierCode" :aria-label="$t('admin.pages.stockSearch.supplier')">
        <option value="">{{ $t("admin.pages.stockSearch.allSuppliers") }}</option>
        <option v-for="s in suppliers" :key="s.id" :value="s.code">{{ s.code }} — {{ s.name }}</option>
      </select>
      <input
        v-model="partNo"
        :placeholder="$t('admin.pages.stockSearch.partNoPlaceholder')"
        @keyup.enter="search"
      />
      <button class="btn btn-primary" :disabled="loading" @click="search">
        {{ $t("admin.common.search") }}
      </button>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>
    <p v-else-if="!searched" class="muted">{{ $t("admin.pages.stockSearch.hint") }}</p>

    <template v-else-if="result">
      <h2 class="section-title">{{ $t("admin.pages.stockSearch.parts") }}</h2>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("admin.pages.stockSearch.partNo") }}</th>
              <th>{{ $t("admin.pages.stockSearch.wclItemNo") }}</th>
              <th>{{ $t("admin.pages.stockSearch.description") }}</th>
              <th>{{ $t("admin.pages.stockSearch.onHandQty") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in result.parts" :key="p.id">
              <td>{{ p.partNo }}</td>
              <td>{{ p.wclItemNo ?? "—" }}</td>
              <td class="wrap">{{ p.description ?? "—" }}</td>
              <td>{{ p.onHandQty }}</td>
            </tr>
            <tr v-if="result.parts.length === 0">
              <td colspan="4" class="muted">{{ $t("admin.pages.stockSearch.noParts") }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 class="section-title">{{ $t("admin.pages.stockSearch.lots") }}</h2>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("admin.pages.stockSearch.partNo") }}</th>
              <th>{{ $t("admin.pages.stockSearch.dateCode") }}</th>
              <th>{{ $t("admin.pages.stockSearch.lotCode") }}</th>
              <th>{{ $t("admin.pages.stockSearch.shelf") }}</th>
              <th>{{ $t("admin.pages.stockSearch.box") }}</th>
              <th>{{ $t("admin.pages.stockSearch.orgSubInventory") }}</th>
              <th>{{ $t("admin.pages.stockSearch.totalQty") }}</th>
              <th>{{ $t("admin.pages.stockSearch.allocatedQty") }}</th>
              <th>{{ $t("admin.pages.stockSearch.availableQty") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(l, i) in result.lots" :key="i">
              <td>{{ l.partNo }}</td>
              <td>{{ l.dateCode ?? "—" }}</td>
              <td>{{ l.lotCode ?? "—" }}</td>
              <td>{{ l.shelfCode ?? "—" }}</td>
              <td>{{ l.boxId ?? "—" }}</td>
              <td>{{ l.orgId ?? "—" }} / {{ l.subInventoryCode ?? "—" }}</td>
              <td>{{ l.totalQty }}</td>
              <td>{{ l.allocatedQty }}</td>
              <td>{{ l.availableQty }}</td>
            </tr>
            <tr v-if="result.lots.length === 0">
              <td colspan="9" class="muted">{{ $t("admin.pages.stockSearch.noLots") }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
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
.section-title {
  font-size: 15px;
  margin: 18px 0 8px;
  color: #52606d;
}
td.wrap {
  white-space: normal;
}
</style>
