<script setup lang="ts">
interface SubInventoryRow {
  orgId: number;
  code: string;
  name: string | null;
  customerCode: string | null;
  tags: string[];
}

const api = useApi();
const rows = ref<SubInventoryRow[]>([]);
const loading = ref(false);
const error = ref("");

const { page, pageSize, total, paged } = usePaging(rows);

const showNew = ref(false);
const newForm = reactive({ orgId: "", code: "", name: "", customerCode: "", tag: "" });
const newError = ref("");

const editing = ref<SubInventoryRow | null>(null);
const editForm = reactive({ name: "", customerCode: "" });
const editError = ref("");
const newTag = ref("");

const newDlg = useOverlayDismiss(() => { showNew.value = false; });
const editDlg = useOverlayDismiss(() => { editing.value = null; });

function rowId(r: SubInventoryRow): string {
  return `${r.orgId}:${r.code}`;
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = await api.get("/admin/sub-inventories");
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function openNew() {
  Object.assign(newForm, { orgId: "", code: "", name: "", customerCode: "", tag: "" });
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
    if (newForm.tag.trim()) body.tag = newForm.tag.trim();
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
  newTag.value = "";
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

async function addTag() {
  if (!editing.value || !newTag.value.trim()) return;
  editError.value = "";
  try {
    await api.post(`/admin/sub-inventories/${rowId(editing.value)}/tags`, { tag: newTag.value.trim() });
    newTag.value = "";
    await load();
    editing.value = rows.value.find((r) => r.orgId === editing.value!.orgId && r.code === editing.value!.code) ?? null;
  } catch (e: any) {
    editError.value = e.message;
  }
}

async function removeTag(tag: string) {
  if (!editing.value || !confirm(`Remove tag ${tag}?`)) return;
  editError.value = "";
  try {
    await api.del(`/admin/sub-inventories/${rowId(editing.value)}/tags/${encodeURIComponent(tag)}`);
    await load();
    editing.value = rows.value.find((r) => r.orgId === editing.value!.orgId && r.code === editing.value!.code) ?? null;
  } catch (e: any) {
    editError.value = e.message;
  }
}

async function remove(row: SubInventoryRow) {
  if (!confirm(`Delete sub-inventory ${row.orgId} / ${row.code} (and its tags)?`)) return;
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
      <button class="btn btn-primary" @click="openNew">New</button>
    </div>

    <p class="muted">
      Three levels: Org ID → Sub-inventory (group) → Tag. Stock references the
      group; items in the same org + sub-inventory share across tags.
    </p>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">Loading…</div>

    <div v-else class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>Org ID</th>
            <th>Sub-inventory</th>
            <th>Name</th>
            <th>Customer</th>
            <th>Tags</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in paged" :key="rowId(r)">
            <td>{{ r.orgId }}</td>
            <td>{{ r.code }}</td>
            <td>{{ r.name ?? "—" }}</td>
            <td>{{ r.customerCode ?? "—" }}</td>
            <td>
              <span v-for="t in r.tags" :key="t" class="tag-chip">{{ t }}</span>
              <span v-if="!r.tags?.length" class="muted">—</span>
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
            <label for="ns-tag">First tag</label>
            <input id="ns-tag" v-model="newForm.tag" type="text" placeholder="defaults to the sub-inventory code" />
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
        <hr class="dlg-sep" />
        <div class="form-row">
          <label>Tags</label>
          <div class="tag-list">
            <span v-for="t in editing.tags" :key="t" class="tag-chip">
              {{ t }}
              <button class="tag-x" title="Remove tag" @click="removeTag(t)">×</button>
            </span>
            <span v-if="!editing.tags?.length" class="muted">No tags.</span>
          </div>
        </div>
        <div class="form-row tag-add">
          <input v-model="newTag" type="text" placeholder="New tag" @keyup.enter="addTag" />
          <button class="btn btn-small" :disabled="!newTag.trim()" @click="addTag">Add</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #eef2f5;
  border: 1px solid #dde3e9;
  border-radius: 10px;
  padding: 1px 8px;
  font-size: 12px;
  margin: 1px 3px 1px 0;
}
.tag-x {
  border: none;
  background: none;
  color: #922b21;
  cursor: pointer;
  font-size: 12px;
  padding: 0 0 0 2px;
}
.tag-list {
  padding-top: 4px;
}
.tag-add {
  display: flex;
  gap: 8px;
}
.tag-add input {
  flex: 1;
  padding: 7px 9px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
}
.dlg-sep {
  border: none;
  border-top: 1px solid #e6ebf0;
  margin: 14px 0;
}
</style>
