<script setup lang="ts">
import type { AdminColumnDef } from "~/composables/useAdminTable";
import { formatScopeSummary, type SubInventoryScope } from "~/utils/userScope";

// Per-user sub-inventory scope management
// (spec 2026-09-11-user-subinventory-scope-design.md). Scope edits go to
// PUT /admin/user-profiles/:username; the backend enforces the filter on
// receiving/picking endpoints.

interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  groupCodes: string[];
  subInventoryScopes: SubInventoryScope[] | null;
}

const { t } = useI18n();
const api = useApi();

const users = ref<UserProfile[]>([]);
const loading = ref(false);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    users.value = await api.get<UserProfile[]>("/admin/user-profiles");
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

const q = ref("");
const filtered = computed(() => {
  const needle = q.value.trim().toLowerCase();
  if (!needle) return users.value;
  return users.value.filter(
    (u) =>
      u.username.toLowerCase().includes(needle) ||
      u.displayName.toLowerCase().includes(needle) ||
      u.groupCodes.some((g) => g.toLowerCase().includes(needle))
  );
});

function scopeSummary(u: UserProfile): string {
  return formatScopeSummary(u.subInventoryScopes);
}

const columnDefs = computed<AdminColumnDef<UserProfile>[]>(() => [
  { key: "username", label: t("admin.pages.userProfiles.username"), size: 140 },
  { key: "displayName", label: t("admin.pages.userProfiles.displayName"), size: 180 },
  {
    key: "groups",
    label: t("admin.pages.userProfiles.groups"),
    accessor: (u) => u.groupCodes.join(", "),
    size: 180,
  },
  {
    key: "scope",
    label: t("admin.pages.userProfiles.scope"),
    accessor: (u) => scopeSummary(u),
    size: 240,
  },
]);

const { table, pagination, resetColumnState } = useAdminTable({
  tableId: "user-profiles",
  columns: columnDefs,
  rows: filtered,
  getRowId: (u) => u.id || u.username,
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

const editingUser = ref<UserProfile | null>(null);
const draftScopes = ref<SubInventoryScope[]>([]);
const saving = ref(false);
const saveError = ref("");

function startEdit(u: UserProfile) {
  editingUser.value = u;
  draftScopes.value = (u.subInventoryScopes ?? []).map((s) => ({ ...s }));
  saveError.value = "";
}

function closeEdit() {
  editingUser.value = null;
  saveError.value = "";
}

const { onMousedown, onClick } = useOverlayDismiss(closeEdit);

async function save() {
  const u = editingUser.value;
  if (!u || saving.value) return;
  saving.value = true;
  saveError.value = "";
  try {
    const res = await api.put<{ username: string; subInventoryScopes: SubInventoryScope[] }>(
      `/admin/user-profiles/${encodeURIComponent(u.username)}`,
      { subInventoryScopes: draftScopes.value }
    );
    u.subInventoryScopes = res.subInventoryScopes;
    closeEdit();
  } catch (e: any) {
    saveError.value = e?.message ?? String(e);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.userProfiles.title") }}</h1>
      <button class="btn" :disabled="loading" @click="load">
        {{ $t("admin.common.refresh") }}
      </button>
    </div>

    <p class="muted explainer">{{ $t("admin.pages.userProfiles.explainer") }}</p>

    <div class="search-bar">
      <input
        v-model="q"
        type="search"
        class="search-input"
        autocomplete="off"
        data-1p-ignore
        data-lpignore="true"
        :placeholder="$t('admin.pages.userProfiles.searchPlaceholder')"
      />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading && users.length === 0" class="loading">{{ $t("admin.common.loading") }}</div>

    <DataTable
      v-else
      :table="table"
      :loading="loading"
      :empty-text="$t('admin.pages.userProfiles.none')"
      :on-reset-columns="resetColumnState"
    >
      <template #cell-groups="{ row }">{{ row.groupCodes.join(", ") || "—" }}</template>
      <template #cell-scope="{ row }">{{ scopeSummary(row) || "—" }}</template>
      <template #actions="{ row }">
        <button class="btn-link" @click="startEdit(row)">
          {{ $t("admin.pages.userProfiles.editScope") }}
        </button>
      </template>
    </DataTable>

    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />

    <div v-if="editingUser" class="overlay" @mousedown="onMousedown" @click="onClick">
      <div class="dialog">
        <h2>{{ $t("admin.pages.userProfiles.dialogTitle", { user: editingUser.username }) }}</h2>
        <div v-if="saveError" class="error-banner">{{ saveError }}</div>
        <SubInventoryScopePicker v-model="draftScopes" />
        <div class="dialog-actions">
          <button class="btn" @click="closeEdit">{{ $t("admin.common.cancel") }}</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">
            {{ saving ? $t("admin.common.saving") : $t("admin.common.save") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.explainer {
  margin: 0 0 12px;
  font-size: 13px;
}
</style>
