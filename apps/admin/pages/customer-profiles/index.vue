<script setup lang="ts">
import type { AdminColumnDef } from "~/composables/useAdminTable";

interface CustomerAccount {
  custAccountId: number;
  partyId: number;
  partyName: string;
  partyType: string;
  accountNumber: string;
  accountStatus: string; // A=Active, I=Inactive
}

const { t } = useI18n();
const api = useApi();
const rows = ref<CustomerAccount[]>([]);
const loading = ref(false);
const error = ref("");

// PDA-local customer profiles (one per customer_accounts.party_name), loaded
// here only to distinguish "has profile" vs "no profile yet" in the row action;
// edited on the detail page /customer-profiles/<partyName>.
const profiles = ref<any[]>([]);

function profileFor(partyName: string) {
  return profiles.value.find((p) => p.code === partyName);
}

// Client-side keyword filter; TanStack owns sorting + paging.
const search = ref("");

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  if (!needle) return rows.value;
  return rows.value.filter((r) =>
    [r.partyName, r.accountNumber, String(r.custAccountId)].some((v) => v.toLowerCase().includes(needle))
  );
});

const columnDefs = computed<AdminColumnDef<CustomerAccount>[]>(() => [
  { key: "custAccountId", label: t("admin.pages.customerProfiles.id"), size: 90 },
  { key: "partyName", label: t("admin.pages.customerProfiles.customerName"), size: 260 },
  { key: "accountNumber", label: t("admin.pages.customerProfiles.customerCode"), size: 140 },
  { key: "accountStatus", label: t("admin.pages.customerProfiles.status"), size: 100 },
]);

const { table, pagination, resetColumnState } = useAdminTable({
  tableId: "customer-accounts",
  columns: columnDefs,
  rows: filtered,
  getRowId: (r) => r.partyName,
});

// Pager uses a 1-based page; the table uses a 0-based pageIndex.
const page = computed({
  get: () => pagination.value.pageIndex + 1,
  set: (v: number) => {
    pagination.value = { ...pagination.value, pageIndex: v - 1 };
  },
});
const pageSize = computed({
  get: () => pagination.value.pageSize,
  set: (v: number) => {
    pagination.value = { pageIndex: 0, pageSize: v };
  },
});
const total = computed(() => filtered.value.length);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [accounts, profileRows] = await Promise.all([
      api.get("/admin/customer-accounts"),
      api.get("/admin/customer-profiles").catch(() => []),
    ]);
    rows.value = accounts;
    profiles.value = profileRows;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function isActive(status: string): boolean {
  return status === "A";
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.customerProfiles.title") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
      </div>
    </div>

    <p class="muted">{{ $t("admin.pages.customerProfiles.explainer") }}</p>

    <div class="search-bar">
      <input
        v-model="search"
        type="search"
        class="search-input"
        :placeholder="$t('admin.pages.customerProfiles.filterPlaceholder')"
      />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <DataTable
      v-else
      :table="table"
      :empty-text="$t('admin.pages.customerProfiles.none')"
      :on-reset-columns="resetColumnState"
    >
      <template #cell-accountStatus="{ row }">
        <span class="status-badge" :class="isActive(row.accountStatus) ? 'active' : 'inactive'">
          {{
            isActive(row.accountStatus)
              ? $t("admin.pages.customerProfiles.active")
              : $t("admin.pages.customerProfiles.inactive")
          }}
        </span>
      </template>
      <template #actions="{ row }">
        <button
          class="btn-link"
          :title="profileFor(row.partyName)?.label || $t('admin.pages.customerProfiles.noProfileYet')"
          @click="navigateTo(`/customer-profiles/${encodeURIComponent(row.partyName)}`)"
        >
          {{
            profileFor(row.partyName)
              ? $t("admin.pages.customerProfiles.editProfile")
              : $t("admin.pages.customerProfiles.createProfile")
          }}
        </button>
      </template>
    </DataTable>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />
  </div>
</template>

<style scoped>
.status-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 12px;
}
.status-badge.active {
  background: #e3f4e5;
  color: #1e7e34;
  border: 1px solid #bfe3c6;
}
.status-badge.inactive {
  background: #f1f3f5;
  color: #6b7680;
  border: 1px solid #dde3e9;
}
</style>
