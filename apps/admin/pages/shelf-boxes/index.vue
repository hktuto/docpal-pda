<script setup lang="ts">
import { renderShelfBoxLabelPng } from "~/utils/print";
import type { AdminColumnDef } from "~/composables/useAdminTable";

const { t } = useI18n();
const api = useApi();

const boxes = ref<any[]>([]);
const loading = ref(false);
const error = ref("");

const columnDefs = computed<AdminColumnDef<any>[]>(() => [
  { key: "id", label: t("admin.pages.shelfBoxes.id"), size: 100 },
  { key: "shelfCode", label: t("admin.pages.shelfBoxes.shelf"), size: 110, accessor: (b) => formatShelf(b.shelfCode, b.shelfDisplayName) },
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

// Multi-select for label printing (checkbox column + "Print selected" /
// "Print all"): the single-label dialog prints one 70 x 37 mm label per box,
// the batch dialog lays the same labels out 3 x 8 per A4 page.
const selected = ref<Set<string>>(new Set());
const selectedBoxes = computed(() => boxes.value.filter((b) => selected.value.has(b.id)));

const printItems = ref<{ title: string; boxId: string }[] | null>(null);
const batchBoxIds = ref<string[] | null>(null);

function printOne(b: any) {
  printItems.value = [{ title: b.id.slice(0, 8), boxId: b.id }];
}

function printSelectedBoxes() {
  batchBoxIds.value = selectedBoxes.value.map((b) => b.id);
  selected.value = new Set();
}

function printAllBoxes() {
  batchBoxIds.value = boxes.value.map((b) => b.id);
}

const statuses = ["open", "closed", "verified"];
const statusOptions = statuses.map((s) => ({ value: s, label: s }));

const showNew = ref(false);
const newForm = reactive({
  shelfCode: "",
  orgId: "",
  subInventoryCode: "",
  status: "open",
  qty: 1,
  createAndPrint: false,
});
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
  newForm.qty = 1;
  newForm.createAndPrint = false;
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

// Batch create: the backend generates one BOX-H-<date>-<seq> id per POST, so
// creating N boxes is N sequential POSTs with the same field values. With
// "create and print" on, the new box ids go straight into a print dialog
// (single label for one box, A4 batch sheets for several).
async function createBox() {
  newError.value = "";
  const qty = Math.max(1, Math.floor(Number(newForm.qty) || 1));
  const body: Record<string, unknown> = { status: newForm.status };
  if (newForm.shelfCode.trim()) body.shelfCode = newForm.shelfCode.trim();
  try {
    pairBody(newForm, body);
  } catch (e: any) {
    newError.value = e.message;
    return;
  }
  const created: string[] = [];
  try {
    for (let i = 0; i < qty; i++) {
      const row = await api.post("/admin/shelf-boxes", body);
      created.push(row.id);
    }
    showNew.value = false;
    await load();
    if (newForm.createAndPrint) {
      if (created.length === 1) printItems.value = [{ title: created[0], boxId: created[0] }];
      else batchBoxIds.value = created;
    }
  } catch (e: any) {
    newError.value = created.length
      ? t("admin.pages.shelfBoxes.createPartial", { count: created.length, message: e.message })
      : e.message;
    await load();
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

// Download the same label the print dialog produces (QR on the left encoding
// the box id, box id text on the right) as a PNG, without going through the
// print service.
async function downloadLabel(row: any) {
  error.value = "";
  try {
    const png = await renderShelfBoxLabelPng(row.id);
    const url = URL.createObjectURL(png);
    const a = document.createElement("a");
    a.href = url;
    a.download = `box-label-${row.id}.png`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e: any) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.shelfBoxes.title") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="!boxes.length" @click="printAllBoxes">
          {{ $t("admin.print.printAll", { count: boxes.length }) }}
        </button>
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
        <button class="btn-link" @click="downloadLabel(row)">{{ $t("admin.print.downloadQr") }}</button>
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
            <SearchableSelect
              v-model="newForm.status"
              :options="statusOptions"
              :all-label="$t('admin.pages.shelfBoxes.status')"
              :aria-label="$t('admin.pages.shelfBoxes.status')"
              :multiple="false"
              :show-all="false"
            />
          </div>
          <div class="form-row">
            <label for="nb-qty">{{ $t("admin.pages.shelfBoxes.qty") }}</label>
            <input id="nb-qty" v-model.number="newForm.qty" type="number" min="1" step="1" />
            <div class="hint">{{ $t("admin.pages.shelfBoxes.qtyHint") }}</div>
          </div>
          <div class="form-row">
            <label for="nb-print">{{ $t("admin.pages.shelfBoxes.createAndPrint") }}</label>
            <input id="nb-print" v-model="newForm.createAndPrint" type="checkbox" class="bool-input" />
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
            <SearchableSelect
              v-model="editForm.status"
              :options="statusOptions"
              :all-label="$t('admin.pages.shelfBoxes.status')"
              :aria-label="$t('admin.pages.shelfBoxes.status')"
              :multiple="false"
              :show-all="false"
            />
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn" @click="editing = null">{{ $t("admin.common.cancel") }}</button>
            <button type="submit" class="btn btn-primary">{{ $t("admin.common.save") }}</button>
          </div>
        </form>
      </div>
    </div>

    <ShelfBoxPrintDialog v-if="printItems" :items="printItems" @close="printItems = null" />
    <ShelfBoxBatchPrintDialog v-if="batchBoxIds" :box-ids="batchBoxIds" @close="batchBoxIds = null" />
  </div>
</template>
