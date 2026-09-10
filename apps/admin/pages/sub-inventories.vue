<script setup lang="ts">
import type { AdminColumnDef } from "~/composables/useAdminTable";

interface SubInventoryRow {
  orgId: number;
  secondaryInventoryName: string;
  subinvDescription: string | null;
  officeCode: string | null;
  organizationId: number | null;
  customerCode: string | null;
}

interface ShareMemberRow {
  shareGroup: string;
  orgId: number;
  code: string;
}

const { t } = useI18n();
const api = useApi();
const rows = ref<SubInventoryRow[]>([]);
const loading = ref(false);
const error = ref("");

// Share-group membership per "orgId:code" + the editable drafts beside it.
// Members of the same group may serve each other's picking demands.
const shareGroups = ref<Record<string, string>>({});
const shareDrafts = ref<Record<string, string>>({});
const shareError = ref("");

// Client-side keyword filter; TanStack owns sorting + paging.
const search = ref("");

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  if (!needle) return rows.value;
  return rows.value.filter((r) =>
    [String(r.orgId), r.secondaryInventoryName, r.subinvDescription, r.officeCode, r.customerCode, shareGroups.value[rowId(r)]].some((v) =>
      String(v ?? "")
        .toLowerCase()
        .includes(needle)
    )
  );
});

const columnDefs = computed<AdminColumnDef<SubInventoryRow>[]>(() => [
  { key: "orgId", label: t("admin.pages.subInventories.orgId"), size: 70 },
  { key: "secondaryInventoryName", label: t("admin.pages.subInventories.code"), size: 110 },
  { key: "subinvDescription", label: t("admin.pages.subInventories.name"), size: 180 },
  { key: "officeCode", label: t("admin.pages.subInventories.officeCode"), size: 100 },
  { key: "organizationId", label: t("admin.pages.subInventories.organizationId"), size: 110 },
  { key: "customerCode", label: t("admin.pages.subInventories.customer"), size: 110 },
  {
    key: "shareGroup",
    label: t("admin.pages.subInventories.shareGroup"),
    sortable: false,
    accessor: (r) => shareGroups.value[rowId(r)] ?? "",
    size: 190,
  },
]);

const { table, pagination, resetColumnState } = useAdminTable({
  tableId: "sub-inventories",
  columns: columnDefs,
  rows: filtered,
  getRowId: rowId,
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

const showNew = ref(false);
const newForm = reactive({ orgId: "", code: "", subinvDescription: "", officeCode: "", organizationId: "", customerCode: "" });
const newError = ref("");

const editing = ref<SubInventoryRow | null>(null);
const editForm = reactive({ subinvDescription: "", officeCode: "", organizationId: "", customerCode: "" });
const editError = ref("");

const newDlg = useOverlayDismiss(() => { showNew.value = false; });
const editDlg = useOverlayDismiss(() => { editing.value = null; });

function rowId(r: SubInventoryRow): string {
  return `${r.orgId}:${r.secondaryInventoryName}`;
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [groups, members] = await Promise.all([
      api.get("/admin/sub-inventories"),
      api.get("/admin/sub-inventory-share-groups"),
    ]);
    rows.value = groups;
    const map: Record<string, string> = {};
    for (const m of members as ShareMemberRow[]) map[`${m.orgId}:${m.code}`] = m.shareGroup;
    shareGroups.value = map;
    shareDrafts.value = { ...map };
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function shareDirty(r: SubInventoryRow): boolean {
  const id = rowId(r);
  return (shareDrafts.value[id] ?? "").trim() !== (shareGroups.value[id] ?? "");
}

async function saveShare(r: SubInventoryRow) {
  shareError.value = "";
  try {
    await api.put(`/admin/sub-inventory-share-groups/${rowId(r)}`, {
      shareGroup: (shareDrafts.value[rowId(r)] ?? "").trim() || null,
    });
    await load();
  } catch (e: any) {
    shareError.value = e.message;
  }
}

function openNew() {
  Object.assign(newForm, { orgId: "", code: "", subinvDescription: "", officeCode: "", organizationId: "", customerCode: "" });
  newError.value = "";
  showNew.value = true;
}

/** Optional integer field (organizationId): empty = null, else must be an integer. */
function optIntField(raw: string): number | null | undefined {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : undefined;
}

async function createGroup() {
  newError.value = "";
  const orgId = Number(newForm.orgId.trim());
  if (!Number.isInteger(orgId)) {
    newError.value = t("admin.common.orgIdInteger");
    return;
  }
  const organizationId = optIntField(newForm.organizationId);
  if (organizationId === undefined) {
    newError.value = t("admin.common.orgIdInteger");
    return;
  }
  try {
    const body: Record<string, unknown> = { orgId, code: newForm.code.trim() };
    if (newForm.subinvDescription.trim()) body.subinvDescription = newForm.subinvDescription.trim();
    if (newForm.officeCode.trim()) body.officeCode = newForm.officeCode.trim();
    if (organizationId !== null) body.organizationId = organizationId;
    if (newForm.customerCode.trim()) body.customerCode = newForm.customerCode.trim();
    await api.post("/admin/sub-inventories", body);
    showNew.value = false;
    await load();
  } catch (e: any) {
    newError.value = e.message;
  }
}

function openEdit(row: SubInventoryRow) {
  editing.value = row;
  editForm.subinvDescription = row.subinvDescription ?? "";
  editForm.officeCode = row.officeCode ?? "";
  editForm.organizationId = row.organizationId === null ? "" : String(row.organizationId);
  editForm.customerCode = row.customerCode ?? "";
  editError.value = "";
}

async function saveEdit() {
  if (!editing.value) return;
  editError.value = "";
  const organizationId = optIntField(editForm.organizationId);
  if (organizationId === undefined) {
    editError.value = t("admin.common.orgIdInteger");
    return;
  }
  try {
    await api.patch(`/admin/sub-inventories/${rowId(editing.value)}`, {
      subinvDescription: editForm.subinvDescription.trim() || null,
      officeCode: editForm.officeCode.trim() || null,
      organizationId,
      customerCode: editForm.customerCode.trim() || null,
    });
    editing.value = null;
    await load();
  } catch (e: any) {
    editError.value = e.message;
  }
}

async function remove(row: SubInventoryRow) {
  if (!confirm(t("admin.pages.subInventories.deleteConfirm", { id: `${row.orgId} / ${row.secondaryInventoryName}` }))) return;
  error.value = "";
  try {
    await api.del(`/admin/sub-inventories/${rowId(row)}`);
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.subInventories.title") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
        <button class="btn btn-primary" @click="openNew">{{ $t("admin.common.new") }}</button>
      </div>
    </div>

    <p class="muted">{{ $t("admin.pages.subInventories.explainer") }}</p>

    <div class="search-bar">
      <input
        v-model="search"
        type="search"
        class="search-input"
        :placeholder="$t('admin.pages.subInventories.filterPlaceholder')"
      />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="shareError" class="error-banner">{{ shareError }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <DataTable
      v-else
      :table="table"
      :empty-text="$t('admin.pages.subInventories.none')"
      :on-reset-columns="resetColumnState"
    >
      <template #cell-subinvDescription="{ row }">{{ row.subinvDescription ?? "—" }}</template>
      <template #cell-officeCode="{ row }">{{ row.officeCode ?? "—" }}</template>
      <template #cell-organizationId="{ row }">{{ row.organizationId ?? "—" }}</template>
      <template #cell-customerCode="{ row }">{{ row.customerCode ?? "—" }}</template>
      <template #cell-shareGroup="{ row }">
        <div class="share-cell">
          <input
            v-model="shareDrafts[rowId(row)]"
            type="text"
            class="share-input"
            placeholder="—"
            @keyup.enter="saveShare(row)"
          />
          <button v-if="shareDirty(row)" class="btn btn-small" @click="saveShare(row)">
            {{ $t("admin.common.save") }}
          </button>
        </div>
      </template>
      <template #actions="{ row }">
        <button class="btn-link" @click="openEdit(row)">{{ $t("admin.common.edit") }}</button>
        <button class="btn-link" @click="remove(row)">{{ $t("admin.common.delete") }}</button>
      </template>
    </DataTable>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />

    <div v-if="showNew" class="overlay" @mousedown="newDlg.onMousedown" @click="newDlg.onClick">
      <div class="dialog">
        <h2>{{ $t("admin.pages.subInventories.newTitle") }}</h2>
        <div v-if="newError" class="error-banner">{{ newError }}</div>
        <form @submit.prevent="createGroup">
          <div class="form-row">
            <label for="ns-org">{{ $t("admin.pages.subInventories.orgId") }} <span class="req">*</span></label>
            <input id="ns-org" v-model="newForm.orgId" type="text" required placeholder="e.g. 2" />
          </div>
          <div class="form-row">
            <label for="ns-code">{{ $t("admin.pages.subInventories.code") }} <span class="req">*</span></label>
            <input id="ns-code" v-model="newForm.code" type="text" required placeholder="e.g. STORE1" />
          </div>
          <div class="form-row">
            <label for="ns-name">{{ $t("admin.pages.subInventories.name") }}</label>
            <input id="ns-name" v-model="newForm.subinvDescription" type="text" />
          </div>
          <div class="form-row">
            <label for="ns-office">{{ $t("admin.pages.subInventories.officeCode") }}</label>
            <input id="ns-office" v-model="newForm.officeCode" type="text" />
          </div>
          <div class="form-row">
            <label for="ns-orgid">{{ $t("admin.pages.subInventories.organizationId") }}</label>
            <input id="ns-orgid" v-model="newForm.organizationId" type="text" />
          </div>
          <div class="form-row">
            <label for="ns-cust">{{ $t("admin.pages.subInventories.customerCode") }}</label>
            <input id="ns-cust" v-model="newForm.customerCode" type="text" />
            <div class="hint">{{ $t("admin.pages.subInventories.customerCodeHint") }}</div>
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn" @click="showNew = false">{{ $t("admin.common.cancel") }}</button>
            <button type="submit" class="btn btn-primary">{{ $t("admin.common.create") }}</button>
          </div>
        </form>
      </div>
    </div>

    <div v-if="editing" class="overlay" @mousedown="editDlg.onMousedown" @click="editDlg.onClick">
      <div class="dialog">
        <h2>{{ $t("admin.pages.subInventories.editTitle", { id: `${editing.orgId} / ${editing.secondaryInventoryName}` }) }}</h2>
        <div v-if="editError" class="error-banner">{{ editError }}</div>
        <form @submit.prevent="saveEdit">
          <div class="form-row">
            <label for="es-name">{{ $t("admin.pages.subInventories.name") }}</label>
            <input id="es-name" v-model="editForm.subinvDescription" type="text" />
          </div>
          <div class="form-row">
            <label for="es-office">{{ $t("admin.pages.subInventories.officeCode") }}</label>
            <input id="es-office" v-model="editForm.officeCode" type="text" />
          </div>
          <div class="form-row">
            <label for="es-orgid">{{ $t("admin.pages.subInventories.organizationId") }}</label>
            <input id="es-orgid" v-model="editForm.organizationId" type="text" />
          </div>
          <div class="form-row">
            <label for="es-cust">{{ $t("admin.pages.subInventories.customerCode") }}</label>
            <input id="es-cust" v-model="editForm.customerCode" type="text" />
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn" @click="editing = null">{{ $t("admin.common.close") }}</button>
            <button type="submit" class="btn btn-primary">{{ $t("admin.common.save") }}</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.share-cell {
  display: flex;
  gap: 6px;
  align-items: center;
}
.share-input {
  width: 110px;
  padding: 5px 7px;
  border: 1px solid #dde3e9;
  border-radius: 4px;
  font-size: 12px;
}
.share-input:focus {
  border-color: var(--brand-teal, #0e9594);
  outline: none;
}
</style>
