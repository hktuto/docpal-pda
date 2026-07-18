<script setup lang="ts">
const api = useApi();

const boxes = ref<any[]>([]);
const loading = ref(false);
const error = ref("");

const statuses = ["open", "closed", "verified"];

const showNew = ref(false);
const newForm = reactive({ receivingOrderId: "", shelfCode: "", status: "open" });
const newError = ref("");

const editing = ref<any | null>(null);
const editForm = reactive({ shelfCode: "", status: "open" });
const editError = ref("");

// Dismiss overlays only on a genuine overlay click (press starts and ends on
// the overlay), so selecting text inside the dialog doesn't close it.
const newDlg = useOverlayDismiss(() => { showNew.value = false; });
const editDlg = useOverlayDismiss(() => { editing.value = null; });

async function load() {
  loading.value = true;
  error.value = "";
  try {
    boxes.value = await api.get("/admin/shelf-boxes");
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function openNew() {
  newForm.receivingOrderId = "";
  newForm.shelfCode = "";
  newForm.status = "open";
  newError.value = "";
  showNew.value = true;
}

async function createBox() {
  newError.value = "";
  try {
    const body: Record<string, unknown> = { status: newForm.status };
    if (newForm.receivingOrderId.trim()) body.receivingOrderId = newForm.receivingOrderId.trim();
    if (newForm.shelfCode.trim()) body.shelfCode = newForm.shelfCode.trim();
    await api.post("/admin/shelf-boxes", body);
    showNew.value = false;
    await load();
  } catch (e: any) {
    newError.value = e.message;
  }
}

function openEdit(row: any) {
  editing.value = row;
  editForm.shelfCode = row.shelfCode ?? "";
  editForm.status = row.status;
  editError.value = "";
}

async function saveEdit() {
  editError.value = "";
  try {
    await api.patch(`/admin/shelf-boxes/${editing.value.id}`, {
      shelfCode: editForm.shelfCode.trim() || null, // null clears the shelf assignment
      status: editForm.status,
    });
    editing.value = null;
    await load();
  } catch (e: any) {
    editError.value = e.message;
  }
}

async function remove(row: any) {
  if (!confirm(`Delete box ${row.id.slice(0, 8)}?`)) return;
  error.value = "";
  try {
    await api.del(`/admin/shelf-boxes/${row.id}`);
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
      <h1>Shelf Boxes</h1>
      <button class="btn btn-primary" @click="openNew">New</button>
    </div>
    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">Loading…</div>
    <div v-else class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>ID</th>
            <th>Receiving order</th>
            <th>Shelf</th>
            <th>Status</th>
            <th>Items</th>
            <th>Total qty</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in boxes" :key="b.id">
            <td>
              <NuxtLink :to="`/shelf-boxes/${b.id}`" :title="b.id">{{ b.id.slice(0, 8) }}</NuxtLink>
            </td>
            <td>{{ formatCell(b.receivingOrderRefNo) }}</td>
            <td>{{ formatCell(b.shelfCode) }}</td>
            <td>{{ b.status }}</td>
            <td>{{ b.itemCount }}</td>
            <td>{{ b.totalQty }}</td>
            <td>{{ formatCell(b.createdAt) }}</td>
            <td class="actions">
              <button class="btn-link" @click="openEdit(b)">Edit</button>
              <button class="btn-link" @click="remove(b)">Delete</button>
            </td>
          </tr>
          <tr v-if="boxes.length === 0">
            <td colspan="8" class="muted">No shelf boxes.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showNew" class="overlay" @mousedown="newDlg.onMousedown" @click="newDlg.onClick">
      <div class="dialog">
        <h2>New shelf box</h2>
        <div v-if="newError" class="error-banner">{{ newError }}</div>
        <form @submit.prevent="createBox">
          <div class="form-row">
            <label for="nb-ro">Receiving order ID</label>
            <input id="nb-ro" v-model="newForm.receivingOrderId" type="text" />
          </div>
          <div class="form-row">
            <label for="nb-shelf">Shelf code</label>
            <input id="nb-shelf" v-model="newForm.shelfCode" type="text" />
          </div>
          <div class="form-row">
            <label for="nb-status">Status</label>
            <select id="nb-status" v-model="newForm.status">
              <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
            </select>
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
        <h2>Edit shelf box {{ editing.id.slice(0, 8) }}</h2>
        <div v-if="editError" class="error-banner">{{ editError }}</div>
        <form @submit.prevent="saveEdit">
          <div class="form-row">
            <label for="eb-shelf">Shelf code</label>
            <input id="eb-shelf" v-model="editForm.shelfCode" type="text" />
            <div class="hint">Leave empty to clear the shelf assignment.</div>
          </div>
          <div class="form-row">
            <label for="eb-status">Status</label>
            <select id="eb-status" v-model="editForm.status">
              <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn" @click="editing = null">Cancel</button>
            <button type="submit" class="btn btn-primary">Save</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
