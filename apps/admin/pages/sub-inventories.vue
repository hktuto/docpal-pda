<script setup lang="ts">
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

// Client-side keyword filter + clickable sort headers, applied before paging.
const search = ref("");
const { sortKey, sortDir, toggleSort, sortRows } = useColumnSort();

const displayed = computed(() => {
  const needle = search.value.trim().toLowerCase();
  let list = rows.value;
  if (needle) {
    list = list.filter((r) =>
      [String(r.orgId), r.secondaryInventoryName, r.subinvDescription, r.officeCode, r.customerCode, shareGroups.value[rowId(r)]].some((v) =>
        String(v ?? "")
          .toLowerCase()
          .includes(needle)
      )
    );
  }
  return sortRows(list);
});

const { page, pageSize, total, paged } = usePaging(displayed);

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

    <div v-else class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th class="sortable" @click="toggleSort('orgId')">
              {{ $t("admin.pages.subInventories.orgId") }}
              <span v-if="sortKey === 'orgId'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('secondaryInventoryName')">
              {{ $t("admin.pages.subInventories.code") }}
              <span v-if="sortKey === 'secondaryInventoryName'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('subinvDescription')">
              {{ $t("admin.pages.subInventories.name") }}
              <span v-if="sortKey === 'subinvDescription'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('officeCode')">
              {{ $t("admin.pages.subInventories.officeCode") }}
              <span v-if="sortKey === 'officeCode'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('organizationId')">
              {{ $t("admin.pages.subInventories.organizationId") }}
              <span v-if="sortKey === 'organizationId'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th class="sortable" @click="toggleSort('customerCode')">
              {{ $t("admin.pages.subInventories.customer") }}
              <span v-if="sortKey === 'customerCode'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th>{{ $t("admin.pages.subInventories.shareGroup") }}</th>
            <th>{{ $t("admin.common.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in paged" :key="rowId(r)">
            <td>{{ r.orgId }}</td>
            <td>{{ r.secondaryInventoryName }}</td>
            <td>{{ r.subinvDescription ?? "—" }}</td>
            <td>{{ r.officeCode ?? "—" }}</td>
            <td>{{ r.organizationId ?? "—" }}</td>
            <td>{{ r.customerCode ?? "—" }}</td>
            <td class="share-cell">
              <input
                v-model="shareDrafts[rowId(r)]"
                type="text"
                class="share-input"
                placeholder="—"
                @keyup.enter="saveShare(r)"
              />
              <button v-if="shareDirty(r)" class="btn btn-small" @click="saveShare(r)">
                {{ $t("admin.common.save") }}
              </button>
            </td>
            <td class="actions">
              <button class="btn-link" @click="openEdit(r)">{{ $t("admin.common.edit") }}</button>
              <button class="btn-link" @click="remove(r)">{{ $t("admin.common.delete") }}</button>
            </td>
          </tr>
          <tr v-if="total === 0">
            <td colspan="8" class="muted">{{ $t("admin.pages.subInventories.none") }}</td>
          </tr>
        </tbody>
      </table>
    </div>
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
th.sortable {
  cursor: pointer;
  user-select: none;
}
th.sortable:hover {
  color: var(--brand-teal-dark);
}
.sort-arrow {
  font-size: 9px;
  margin-left: 3px;
}
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
