<script setup lang="ts">
interface SubInventoryRow {
  orgId: number;
  code: string;
  name: string | null;
  customerCode: string | null;
}

interface ShareMemberRow {
  shareGroup: string;
  orgId: number;
  code: string;
}

const api = useApi();
const rows = ref<SubInventoryRow[]>([]);
const loading = ref(false);
const error = ref("");

// Share-group membership per "orgId:code" + the editable drafts beside it.
// Members of the same group may serve each other's picking demands.
const shareGroups = ref<Record<string, string>>({});
const shareDrafts = ref<Record<string, string>>({});
const shareError = ref("");

const { page, pageSize, total, paged } = usePaging(rows);

const showNew = ref(false);
const newForm = reactive({ orgId: "", code: "", name: "", customerCode: "" });
const newError = ref("");

const editing = ref<SubInventoryRow | null>(null);
const editForm = reactive({ name: "", customerCode: "" });
const editError = ref("");

const newDlg = useOverlayDismiss(() => { showNew.value = false; });
const editDlg = useOverlayDismiss(() => { editing.value = null; });

function rowId(r: SubInventoryRow): string {
  return `${r.orgId}:${r.code}`;
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
  Object.assign(newForm, { orgId: "", code: "", name: "", customerCode: "" });
  newError.value = "";
  showNew.value = true;
}

async function createGroup() {
  newError.value = "";
  const orgId = Number(newForm.orgId.trim());
  if (!Number.isInteger(orgId)) {
    newError.value = "Org ID must be an integer";
    return;
  }
  try {
    const body: Record<string, unknown> = { orgId, code: newForm.code.trim() };
    if (newForm.name.trim()) body.name = newForm.name.trim();
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
  editForm.name = row.name ?? "";
  editForm.customerCode = row.customerCode ?? "";
  editError.value = "";
}

async function saveEdit() {
  if (!editing.value) return;
  editError.value = "";
  try {
    await api.patch(`/admin/sub-inventories/${rowId(editing.value)}`, {
      name: editForm.name.trim() || null,
      customerCode: editForm.customerCode.trim() || null,
    });
    editing.value = null;
    await load();
  } catch (e: any) {
    editError.value = e.message;
  }
}

async function remove(row: SubInventoryRow) {
  if (!confirm(`Delete sub-inventory ${row.orgId} / ${row.code}?`)) return;
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
      <h1>Sub-inventories</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">Refresh</button>
        <button class="btn btn-primary" @click="openNew">New</button>
      </div>
    </div>

    <p class="muted">
      Stock is partitioned by Org ID + Sub-inventory. Sub-inventories in the
      same <strong>share group</strong> may serve each other's picking demands.
    </p>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="shareError" class="error-banner">{{ shareError }}</div>
    <div v-if="loading" class="loading">Loading…</div>

    <div v-else class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>Org ID</th>
            <th>Sub-inventory</th>
            <th>Name</th>
            <th>Customer</th>
            <th>Share group</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in paged" :key="rowId(r)">
            <td>{{ r.orgId }}</td>
            <td>{{ r.code }}</td>
            <td>{{ r.name ?? "—" }}</td>
            <td>{{ r.customerCode ?? "—" }}</td>
            <td class="share-cell">
              <input
                v-model="shareDrafts[rowId(r)]"
                type="text"
                class="share-input"
                placeholder="—"
                @keyup.enter="saveShare(r)"
              />
              <button v-if="shareDirty(r)" class="btn btn-small" @click="saveShare(r)">Save</button>
            </td>
            <td class="actions">
              <button class="btn-link" @click="openEdit(r)">Edit</button>
              <button class="btn-link" @click="remove(r)">Delete</button>
            </td>
          </tr>
          <tr v-if="total === 0">
            <td colspan="6" class="muted">No sub-inventories.</td>
          </tr>
        </tbody>
      </table>
    </div>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />

    <div v-if="showNew" class="overlay" @mousedown="newDlg.onMousedown" @click="newDlg.onClick">
      <div class="dialog">
        <h2>New sub-inventory</h2>
        <div v-if="newError" class="error-banner">{{ newError }}</div>
        <form @submit.prevent="createGroup">
          <div class="form-row">
            <label for="ns-org">Org ID <span class="req">*</span></label>
            <input id="ns-org" v-model="newForm.orgId" type="text" required placeholder="e.g. 2" />
          </div>
          <div class="form-row">
            <label for="ns-code">Sub-inventory <span class="req">*</span></label>
            <input id="ns-code" v-model="newForm.code" type="text" required placeholder="e.g. STORE1" />
          </div>
          <div class="form-row">
            <label for="ns-name">Name</label>
            <input id="ns-name" v-model="newForm.name" type="text" />
          </div>
          <div class="form-row">
            <label for="ns-cust">Customer code</label>
            <input id="ns-cust" v-model="newForm.customerCode" type="text" />
            <div class="hint">Set only for customer-segregated stores.</div>
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn" @click="showNew = false">Cancel</button>
            <button type="submit" class="btn btn-primary">Create</button>
          </div>
        </form>
      </div>
    </div>

    <div v-if="editing" class="overlay" @mousedown="editDlg.onMousedown" @click="editDlg.onClick">
      <div class="dialog">
        <h2>Edit {{ editing.orgId }} / {{ editing.code }}</h2>
        <div v-if="editError" class="error-banner">{{ editError }}</div>
        <form @submit.prevent="saveEdit">
          <div class="form-row">
            <label for="es-name">Name</label>
            <input id="es-name" v-model="editForm.name" type="text" />
          </div>
          <div class="form-row">
            <label for="es-cust">Customer code</label>
            <input id="es-cust" v-model="editForm.customerCode" type="text" />
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn" @click="editing = null">Close</button>
            <button type="submit" class="btn btn-primary">Save</button>
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
