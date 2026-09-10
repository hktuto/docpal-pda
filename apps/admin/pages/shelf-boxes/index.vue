<script setup lang="ts">
import { boxLabelParams } from "~/utils/print";
import type { AdminColumnDef } from "~/composables/useAdminTable";

const { t } = useI18n();
const api = useApi();

const boxes = ref<any[]>([]);
const loading = ref(false);
const error = ref("");

const columnDefs = computed<AdminColumnDef<any>[]>(() => [
  { key: "id", label: t("admin.pages.shelfBoxes.id"), size: 100 },
  { key: "shelfCode", label: t("admin.pages.shelfBoxes.shelf"), size: 110 },
  { key: "orgId", label: t("admin.pages.shelfBoxes.orgId"), size: 80 },
  { key: "subInventoryCode", label: t("admin.pages.shelfBoxes.subInventory"), size: 120 },
  { key: "status", label: t("admin.pages.shelfBoxes.status"), size: 100 },
  { key: "itemCount", label: t("admin.pages.shelfBoxes.items"), size: 80 },
  { key: "totalQty", label: t("admin.pages.shelfBoxes.totalQty"), size: 90 },
  { key: "createdDate", label: t("admin.pages.shelfBoxes.created"), size: 170 },
]);

const { table, pagination, resetColumnState } = useAdminTable({
  tableId: "shelf-boxes-list",
  columns: columnDefs,
  rows: boxes,
  getRowId: (b) => b.id,
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
const total = computed(() => boxes.value.length);

// Multi-select for label printing (checkbox column + "Print selected").
const selected = ref<Set<string>>(new Set());
const selectedBoxes = computed(() => boxes.value.filter((b) => selected.value.has(b.id)));

const printItems = ref<{ title: string; params: Record<string, unknown> }[] | null>(null);

function printOne(b: any) {
  printItems.value = [{ title: b.id.slice(0, 8), params: boxLabelParams(b) }];
}

function printSelectedBoxes() {
  printItems.value = selectedBoxes.value.map((b) => ({
    title: b.id.slice(0, 8),
    params: boxLabelParams(b),
  }));
  selected.value = new Set();
}

const statuses = ["open", "closed", "verified"];

const showNew = ref(false);
const newForm = reactive({ shelfCode: "", orgId: "", subInventoryCode: "", status: "open" });
const newError = ref("");

const editing = ref<any | null>(null);
const editForm = reactive({ shelfCode: "", orgId: "", subInventoryCode: "", status: "open" });
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
  newForm.shelfCode = "";
  newForm.orgId = "";
  newForm.subInventoryCode = "";
  newForm.status = "open";
  newError.value = "";
  showNew.value = true;
}

function pairBody(form: { orgId: string; subInventoryCode: string }, body: Record<string, unknown>) {
  // Empty string clears / omits the pair member; org id must be an integer.
  if (form.orgId.trim() !== "") {
    const n = Number(form.orgId.trim());
    if (!Number.isInteger(n)) throw new Error(t("admin.common.orgIdInteger"));
    body.orgId = n;
  }
  if (form.subInventoryCode.trim() !== "") body.subInventoryCode = form.subInventoryCode.trim();
}

async function createBox() {
  newError.value = "";
  try {
    const body: Record<string, unknown> = { status: newForm.status };
    if (newForm.shelfCode.trim()) body.shelfCode = newForm.shelfCode.trim();
    pairBody(newForm, body);
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
  editForm.orgId = row.orgId != null ? String(row.orgId) : "";
  editForm.subInventoryCode = row.subInventoryCode ?? "";
  editForm.status = row.status;
  editError.value = "";
}

async function saveEdit() {
  editError.value = "";
  try {
    const body: Record<string, unknown> = {
      shelfCode: editForm.shelfCode.trim() || null, // null clears the shelf assignment
      status: editForm.status,
      // null clears the pair member (server treats present-null as clear)
      orgId: editForm.orgId.trim() === "" ? null : undefined,
      subInventoryCode: editForm.subInventoryCode.trim() === "" ? null : undefined,
    };
    pairBody(editForm, body);
    await api.patch(`/admin/shelf-boxes/${editing.value.id}`, body);
    editing.value = null;
    await load();
  } catch (e: any) {
    editError.value = e.message;
  }
}

async function remove(row: any) {
  if (!confirm(t("admin.pages.shelfBoxes.deleteConfirm", { id: row.id.slice(0, 8) }))) return;
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
      <h1>{{ $t("admin.pages.shelfBoxes.title") }}</h1>
      <div class="head-actions">
        <button v-if="selected.size" class="btn btn-primary" @click="printSelectedBoxes">
          {{ $t("admin.print.printSelected", { count: selected.size }) }}
        </button>
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
        <button class="btn btn-primary" @click="openNew">{{ $t("admin.common.new") }}</button>
      </div>
    </div>
    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>
    <DataTable
      v-else
      :table="table"
      selectable
      :row-id="(b: any) => b.id"
      v-model:selected="selected"
      :empty-text="$t('admin.pages.shelfBoxes.none')"
      :on-reset-columns="resetColumnState"
    >
      <template #cell-id="{ row }">
        <NuxtLink :to="`/shelf-boxes/${row.id}`" :title="row.id">{{ row.id.slice(0, 8) }}</NuxtLink>
      </template>
      <template #actions="{ row }">
        <button class="btn-link" @click="printOne(row)">{{ $t("admin.print.print") }}</button>
        <button class="btn-link" @click="openEdit(row)">{{ $t("admin.common.edit") }}</button>
        <button class="btn-link" @click="remove(row)">{{ $t("admin.common.delete") }}</button>
      </template>
    </DataTable>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />

    <div v-if="showNew" class="overlay" @mousedown="newDlg.onMousedown" @click="newDlg.onClick">
      <div class="dialog">
        <h2>{{ $t("admin.pages.shelfBoxes.newTitle") }}</h2>
        <div v-if="newError" class="error-banner">{{ newError }}</div>
        <form @submit.prevent="createBox">
          <div class="form-row">
            <label for="nb-shelf">{{ $t("admin.pages.shelfBoxes.shelfCode") }}</label>
            <input id="nb-shelf" v-model="newForm.shelfCode" type="text" />
          </div>
          <div class="form-row">
            <label for="nb-org">{{ $t("admin.pages.shelfBoxes.orgId") }}</label>
            <input id="nb-org" v-model="newForm.orgId" type="text" placeholder="e.g. 2" />
          </div>
          <div class="form-row">
            <label for="nb-sub">{{ $t("admin.pages.shelfBoxes.subInventory") }}</label>
            <input id="nb-sub" v-model="newForm.subInventoryCode" type="text" placeholder="e.g. STORE1" />
          </div>
          <div class="form-row">
            <label for="nb-status">{{ $t("admin.pages.shelfBoxes.status") }}</label>
            <select id="nb-status" v-model="newForm.status">
              <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
            </select>
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
        <h2>{{ $t("admin.pages.shelfBoxes.editTitle", { id: editing.id.slice(0, 8) }) }}</h2>
        <div v-if="editError" class="error-banner">{{ editError }}</div>
        <form @submit.prevent="saveEdit">
          <div class="form-row">
            <label for="eb-shelf">{{ $t("admin.pages.shelfBoxes.shelfCode") }}</label>
            <input id="eb-shelf" v-model="editForm.shelfCode" type="text" />
            <div class="hint">{{ $t("admin.pages.shelfBoxes.clearShelfHint") }}</div>
          </div>
          <div class="form-row">
            <label for="eb-org">{{ $t("admin.pages.shelfBoxes.orgId") }}</label>
            <input id="eb-org" v-model="editForm.orgId" type="text" />
            <div class="hint">{{ $t("admin.pages.shelfBoxes.clearHint") }}</div>
          </div>
          <div class="form-row">
            <label for="eb-sub">{{ $t("admin.pages.shelfBoxes.subInventory") }}</label>
            <input id="eb-sub" v-model="editForm.subInventoryCode" type="text" />
            <div class="hint">{{ $t("admin.pages.shelfBoxes.clearHint") }}</div>
          </div>
          <div class="form-row">
            <label for="eb-status">{{ $t("admin.pages.shelfBoxes.status") }}</label>
            <select id="eb-status" v-model="editForm.status">
              <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn" @click="editing = null">{{ $t("admin.common.cancel") }}</button>
            <button type="submit" class="btn btn-primary">{{ $t("admin.common.save") }}</button>
          </div>
        </form>
      </div>
    </div>

    <PrintLabelsDialog v-if="printItems" :items="printItems" @close="printItems = null" />
  </div>
</template>
