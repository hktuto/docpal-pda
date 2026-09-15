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

// Share-group membership per "orgId:code". Members of the same group may
// serve each other's picking demands. A group exists only via its members
// (no groups table) — removing the last member deletes the group.
const shareGroups = ref<Record<string, string>>({});
const shareError = ref("");

const groupNames = computed(() =>
  [...new Set(Object.values(shareGroups.value))].sort((a, b) => a.localeCompare(b))
);

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
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

// Table-cell select: assign/clear one row's group.
async function setShare(r: SubInventoryRow, group: string) {
  if (group === (shareGroups.value[rowId(r)] ?? "")) return;
  shareError.value = "";
  try {
    await api.put(`/admin/sub-inventory-share-groups/${rowId(r)}`, { shareGroup: group || null });
    await load();
  } catch (e: any) {
    shareError.value = e.message;
  }
}

// --- Share-group manager dialog --------------------------------------------

const showShareMgr = ref(false);
const shareMgrError = ref("");
const shareMgrSaving = ref(false);
// New groups staged in the dialog before any member is saved.
const draftGroups = ref<string[]>([]);
const selectedGroup = ref<string | null>(null);
const groupNameDraft = ref("");
const memberDraft = ref<Set<string>>(new Set());
const newGroupName = ref("");

const shareMgrDlg = useOverlayDismiss(() => { showShareMgr.value = false; });

// Groups = names from membership rows + staged drafts; value = member ids.
const mgrGroups = computed(() => {
  const map = new Map<string, string[]>();
  for (const [id, g] of Object.entries(shareGroups.value)) {
    const list = map.get(g) ?? [];
    list.push(id);
    map.set(g, list);
  }
  for (const d of draftGroups.value) if (!map.has(d)) map.set(d, []);
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, members]) => ({ name, members: members.sort() }));
});

// Member picker: sub-inventories grouped by org. Codes repeat across orgs,
// so options are keyed on orgId:code, not code alone.
const mgrOrgs = computed(() => {
  const byOrg = new Map<number, SubInventoryRow[]>();
  for (const r of rows.value) {
    const list = byOrg.get(r.orgId) ?? [];
    list.push(r);
    byOrg.set(r.orgId, list);
  }
  return [...byOrg.entries()]
    .sort(([a], [b]) => a - b)
    .map(([orgId, items]) => ({
      orgId,
      office: items[0]?.officeCode ?? null,
      items: items.sort((a, b) => a.secondaryInventoryName.localeCompare(b.secondaryInventoryName)),
    }));
});

function openShareMgr() {
  draftGroups.value = [];
  shareMgrError.value = "";
  newGroupName.value = "";
  showShareMgr.value = true;
  selectGroup(mgrGroups.value[0]?.name ?? null);
}

function selectGroup(name: string | null) {
  selectedGroup.value = name;
  groupNameDraft.value = name ?? "";
  memberDraft.value = new Set(mgrGroups.value.find((g) => g.name === name)?.members ?? []);
}

function createDraftGroup() {
  shareMgrError.value = "";
  const name = newGroupName.value.trim();
  if (!name) {
    shareMgrError.value = t("admin.pages.subInventories.shareManager.nameRequired");
    return;
  }
  if (mgrGroups.value.some((g) => g.name === name)) {
    shareMgrError.value = t("admin.pages.subInventories.shareManager.nameExists");
    return;
  }
  draftGroups.value = [...draftGroups.value, name];
  newGroupName.value = "";
  selectGroup(name);
}

function toggleMgrMember(id: string) {
  const next = new Set(memberDraft.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  memberDraft.value = next;
}

// The group a sub-inventory currently belongs to (for the "in X" badge).
function currentGroupOf(id: string): string | null {
  return shareGroups.value[id] ?? null;
}

async function saveMgrGroup() {
  const originalName = selectedGroup.value;
  if (!originalName || shareMgrSaving.value) return;
  shareMgrError.value = "";
  const name = groupNameDraft.value.trim();
  if (!name) {
    shareMgrError.value = t("admin.pages.subInventories.shareManager.nameRequired");
    return;
  }
  if (name !== originalName && mgrGroups.value.some((g) => g.name === name)) {
    shareMgrError.value = t("admin.pages.subInventories.shareManager.nameExists");
    return;
  }
  shareMgrSaving.value = true;
  try {
    const originalMembers = mgrGroups.value.find((g) => g.name === originalName)?.members ?? [];
    for (const id of memberDraft.value) {
      await api.put(`/admin/sub-inventory-share-groups/${id}`, { shareGroup: name });
    }
    for (const id of originalMembers) {
      if (!memberDraft.value.has(id)) {
        await api.put(`/admin/sub-inventory-share-groups/${id}`, { shareGroup: null });
      }
    }
    draftGroups.value = draftGroups.value.filter((d) => d !== originalName);
    await load();
    // A group saved with zero members no longer exists — select another.
    selectGroup(memberDraft.value.size ? name : (mgrGroups.value[0]?.name ?? null));
  } catch (e: any) {
    shareMgrError.value = e.message;
  } finally {
    shareMgrSaving.value = false;
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
        <button class="btn" @click="openShareMgr">{{ $t("admin.pages.subInventories.shareManager.button") }}</button>
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
        <SearchableSelect
          class="share-select"
          :model-value="shareGroups[rowId(row)] ?? ''"
          :options="[{ value: '', label: '—' }, ...groupNames.map((g) => ({ value: g, label: g }))]"
          all-label="—"
          :aria-label="$t('admin.pages.subInventories.shareGroup')"
          :multiple="false"
          :show-all="false"
          @update:model-value="setShare(row, $event as string)"
        />
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

    <div v-if="showShareMgr" class="overlay" @mousedown="shareMgrDlg.onMousedown" @click="shareMgrDlg.onClick">
      <div class="dialog share-mgr-dialog">
        <h2>{{ $t("admin.pages.subInventories.shareManager.title") }}</h2>
        <div v-if="shareMgrError" class="error-banner">{{ shareMgrError }}</div>
        <div class="share-mgr-body">
          <div class="share-mgr-groups">
            <div class="share-mgr-label">{{ $t("admin.pages.subInventories.shareManager.groups") }}</div>
            <div v-if="mgrGroups.length === 0" class="muted">
              {{ $t("admin.pages.subInventories.shareManager.noGroups") }}
            </div>
            <button
              v-for="g in mgrGroups"
              :key="g.name"
              type="button"
              class="share-mgr-group"
              :class="{ active: g.name === selectedGroup }"
              @click="selectGroup(g.name)"
            >
              <span>{{ g.name }}</span>
              <span class="muted">{{ $t("admin.pages.subInventories.shareManager.memberCount", { n: g.members.length }) }}</span>
            </button>
            <div class="share-mgr-new">
              <input
                v-model="newGroupName"
                type="text"
                :placeholder="$t('admin.pages.subInventories.shareManager.newPlaceholder')"
                @keyup.enter="createDraftGroup"
              />
              <button type="button" class="btn btn-small" @click="createDraftGroup">
                {{ $t("admin.common.create") }}
              </button>
            </div>
          </div>
          <div v-if="selectedGroup" class="share-mgr-members">
            <div class="form-row">
              <label for="sm-name">{{ $t("admin.pages.subInventories.shareManager.groupName") }}</label>
              <input id="sm-name" v-model="groupNameDraft" type="text" />
            </div>
            <div class="share-mgr-label">{{ $t("admin.pages.subInventories.shareManager.members") }}</div>
            <div class="share-mgr-picker">
              <div v-for="o in mgrOrgs" :key="o.orgId" class="share-mgr-org">
                <div class="share-mgr-org-name">
                  {{ o.office ?? $t("admin.scopePicker.orgFallback", { orgId: o.orgId }) }}
                </div>
                <label v-for="r in o.items" :key="rowId(r)" class="share-mgr-option">
                  <input
                    type="checkbox"
                    :checked="memberDraft.has(rowId(r))"
                    @change="toggleMgrMember(rowId(r))"
                  />
                  <span>
                    {{ r.secondaryInventoryName }}<template v-if="r.subinvDescription"> — {{ r.subinvDescription }}</template>
                  </span>
                  <span
                    v-if="currentGroupOf(rowId(r)) && currentGroupOf(rowId(r)) !== selectedGroup"
                    class="share-mgr-badge"
                  >
                    {{ $t("admin.pages.subInventories.shareManager.inOtherGroup", { group: currentGroupOf(rowId(r)) }) }}
                  </span>
                </label>
              </div>
            </div>
            <div class="hint">{{ $t("admin.pages.subInventories.shareManager.emptyGroupHint") }}</div>
            <div class="dialog-actions">
              <button type="button" class="btn" @click="showShareMgr = false">{{ $t("admin.common.close") }}</button>
              <button type="button" class="btn btn-primary" :disabled="shareMgrSaving" @click="saveMgrGroup">
                {{ shareMgrSaving ? $t("admin.common.saving") : $t("admin.common.save") }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.share-select {
  width: 150px;
  font-size: 12px;
}

.share-mgr-dialog {
  width: 760px;
  max-width: 92vw;
}
.share-mgr-body {
  display: flex;
  gap: 18px;
  align-items: flex-start;
}
.share-mgr-groups {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.share-mgr-label {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #64748b;
  margin-bottom: 4px;
}
.share-mgr-group {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid #dde3e9;
  border-radius: 6px;
  background: #fff;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.share-mgr-group.active {
  border-color: var(--brand-teal, #0e9594);
  background: #f0fafa;
}
.share-mgr-new {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.share-mgr-new input {
  flex: 1;
  min-width: 0;
  padding: 5px 7px;
  border: 1px solid #dde3e9;
  border-radius: 4px;
  font-size: 12px;
}
.share-mgr-members {
  flex: 1;
  min-width: 0;
}
.share-mgr-picker {
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid #d8e1ea;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.share-mgr-org-name {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #64748b;
  margin-bottom: 4px;
}
.share-mgr-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 14px;
  cursor: pointer;
}
.share-mgr-badge {
  font-size: 11px;
  color: #92400e;
  background: #fef3c7;
  border-radius: 4px;
  padding: 1px 6px;
}
.share-mgr-members .hint {
  margin-top: 8px;
}
</style>
