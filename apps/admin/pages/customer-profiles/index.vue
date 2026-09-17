<script setup lang="ts">
import type { AdminColumnDef } from "~/composables/useAdminTable";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

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

// PDA-local customer profiles; each profile's `customers` array lists the
// customer_accounts.party_name values it applies to (a customer belongs to at
// most one profile). Loaded here to distinguish "has profile" vs "no profile
// yet" and to show the assigned profile's label; edited on the detail page.
const profiles = ref<any[]>([]);

function profileFor(partyName: string) {
  return profiles.value.find((p) => Array.isArray(p.customers) && p.customers.includes(partyName));
}

// Client-side filters; TanStack owns sorting + paging.
const search = ref("");
const statusFilter = ref<"" | "A" | "I">("");
const profileFilter = ref<"" | "with" | "without">("");

const statusFilterOptions = computed<SearchableSelectOption[]>(() => [
  { value: "A", label: t("admin.pages.customerProfiles.active") },
  { value: "I", label: t("admin.pages.customerProfiles.inactive") },
]);
const profileFilterOptions = computed<SearchableSelectOption[]>(() => [
  { value: "with", label: t("admin.pages.customerProfiles.profileWith") },
  { value: "without", label: t("admin.pages.customerProfiles.profileWithout") },
]);

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return rows.value.filter((r) => {
    if (statusFilter.value && r.accountStatus !== statusFilter.value) return false;
    const hasProfile = !!profileFor(r.partyName);
    if (profileFilter.value === "with" && !hasProfile) return false;
    if (profileFilter.value === "without" && hasProfile) return false;
    if (!needle) return true;
    return [r.partyName, r.accountNumber, String(r.custAccountId)].some((v) => v.toLowerCase().includes(needle));
  });
});

const columnDefs = computed<AdminColumnDef<CustomerAccount>[]>(() => [
  { key: "custAccountId", label: t("admin.pages.customerProfiles.id"), size: 90 },
  { key: "partyName", label: t("admin.pages.customerProfiles.customerName"), size: 260 },
  { key: "accountNumber", label: t("admin.pages.customerProfiles.customerCode"), size: 140 },
  { key: "accountStatus", label: t("admin.pages.customerProfiles.status"), size: 100 },
  { key: "profile", label: t("admin.pages.customerProfiles.profile"), size: 160, accessor: (r) => profileFor(r.partyName)?.label ?? "" },
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
        <NuxtLink to="/customer-profile-list" class="btn">
          {{ $t("admin.pages.customerProfiles.manageProfiles") }}
        </NuxtLink>
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
      <SearchableSelect
        v-model="statusFilter"
        :options="statusFilterOptions"
        :all-label="$t('admin.common.allStatuses')"
        :aria-label="$t('admin.pages.customerProfiles.status')"
        :multiple="false"
      />
      <SearchableSelect
        v-model="profileFilter"
        :options="profileFilterOptions"
        :all-label="$t('admin.pages.customerProfiles.profileAll')"
        :aria-label="$t('admin.pages.customerProfiles.profileFilter')"
        :multiple="false"
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
      <template #cell-profile="{ row }">
        {{ profileFor(row.partyName)?.label ?? "—" }}
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
.search-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.625rem;
}
.status-badge {
  display: inline-block;
  padding: 0.125rem 0.625rem;
  border-radius: 0.625rem;
  font-size: 0.75rem;
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
