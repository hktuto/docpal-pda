<script setup lang="ts">
import type { AdminColumnDef } from "~/composables/useAdminTable";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";
import { BUG_CATEGORY_IDS } from "~/utils/bugReportCategories";

// Bug-report triage queue (spec
// docs/superpowers/specs/2026-11-05-in-app-bug-report-design.md). The app
// inbox: reports from PDA/admin float in here; the triage loop is
// open → triaged → closed, and closing folds the row into docs/uat with the
// BUG-xxx id recorded in uatRef. One-way sync — the repo tracker stays the
// ledger. Plain fetch + useAdminTable, not CrudTable (a queue, not CRUD).

interface BugReportRow {
  id: string;
  createdDate: string;
  app: string;
  route: string;
  category: string | null;
  status: string;
  reporter: string;
  uatRef: string | null;
  hasPhoto: boolean;
}

interface BugReportDetail extends BugReportRow {
  note: string;
  context: { userAgent?: string; sessionId?: string } | null;
  trail: { t: number; k: string; m: string; r: string }[];
  photo: string | null;
  photoMime: string | null;
}

const { t } = useI18n();

const statusFilter = ref(""); // "" | open | triaged | closed
const categoryFilter = ref(""); // "" | vocabulary id

const statusOptions = computed<SearchableSelectOption[]>(() =>
  ["open", "triaged", "closed"].map((s) => ({ value: s, label: t(`bugQueue.statuses.${s}`) }))
);
const categoryOptions = computed<SearchableSelectOption[]>(() =>
  BUG_CATEGORY_IDS.map((c) => ({ value: c, label: t(`bugReport.categories.${c}`) }))
);

const rows = ref<BugReportRow[]>([]);
const loading = ref(true);
const error = ref("");
const notice = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const params = new URLSearchParams();
    if (statusFilter.value) params.set("status", statusFilter.value);
    if (categoryFilter.value) params.set("category", categoryFilter.value);
    const qs = params.toString();
    rows.value = await useApi().get<BugReportRow[]>(`/admin/bug-reports${qs ? `?${qs}` : ""}`);
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    loading.value = false;
  }
}

watch([statusFilter, categoryFilter], load);
onMounted(load);

const columnDefs = computed<AdminColumnDef<BugReportRow>[]>(() => [
  { key: "createdDate", label: t("bugQueue.colWhen"), size: 150 },
  { key: "reporter", label: t("bugQueue.colWho"), size: 120 },
  { key: "app", label: t("bugQueue.colScreen"), size: 240 },
  { key: "category", label: t("bugQueue.colCategory"), size: 150 },
  { key: "status", label: t("bugQueue.colStatus"), size: 110 },
]);

const { table, resetColumnState } = useAdminTable({
  tableId: "bug-reports",
  columns: columnDefs,
  rows,
  getRowId: (r) => r.id,
  defaultPageSize: 50,
});

// --- detail dialog ---------------------------------------------------------

const detail = ref<BugReportDetail | null>(null);
const editStatus = ref("open");
const editUatRef = ref("");
const saving = ref(false);
const detailError = ref("");

async function openDetail(row: BugReportRow) {
  detailError.value = "";
  try {
    detail.value = await useApi().get<BugReportDetail>(`/admin/bug-reports/${row.id}`);
    editStatus.value = detail.value.status;
    editUatRef.value = detail.value.uatRef ?? "";
  } catch (e: any) {
    detailError.value = e?.message ?? String(e);
  }
}

async function saveDetail() {
  if (!detail.value || saving.value) return;
  saving.value = true;
  detailError.value = "";
  try {
    await useApi().patch(`/admin/bug-reports/${detail.value.id}`, {
      status: editStatus.value,
      uatRef: editUatRef.value.trim() || null,
    });
    detail.value = null;
    await load();
    notice.value = t("bugQueue.saved");
    setTimeout(() => (notice.value = ""), 5000);
  } catch (e: any) {
    detailError.value = e?.message ?? String(e);
  } finally {
    saving.value = false;
  }
}

async function deleteDetail() {
  if (!detail.value || saving.value) return;
  saving.value = true;
  detailError.value = "";
  try {
    await useApi().del(`/admin/bug-reports/${detail.value.id}`);
    detail.value = null;
    await load();
    notice.value = t("bugQueue.deleted");
    setTimeout(() => (notice.value = ""), 5000);
  } catch (e: any) {
    detailError.value = e?.message ?? String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("bugQueue.title") }}</h1>
    </div>

    <div class="filters">
      <SearchableSelect
        v-model="statusFilter"
        :options="statusOptions"
        :all-label="$t('bugQueue.allStatuses')"
        :aria-label="$t('bugQueue.filterStatus')"
        :multiple="false"
        class="filter-item"
      />
      <SearchableSelect
        v-model="categoryFilter"
        :options="categoryOptions"
        :all-label="$t('bugQueue.allCategories')"
        :aria-label="$t('bugQueue.colCategory')"
        :multiple="false"
        class="filter-item"
      />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="notice" class="notice-banner">{{ notice }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <DataTable v-else :table="table" :empty-text="$t('bugQueue.empty')" :on-reset-columns="resetColumnState">
      <template #cell-createdDate="{ row }">{{ formatDateTime(row.createdDate) }}</template>
      <template #cell-app="{ row }">
        <span class="muted">{{ row.app }}</span>
        <div class="sub-line">{{ row.route }}</div>
      </template>
      <template #cell-category="{ row }">
        {{ row.category ? $t(`bugReport.categories.${row.category}`) : "—" }}
      </template>
      <template #cell-status="{ row }">
        <span class="state-badge" :class="`state-${row.status}`">{{ $t(`bugQueue.statuses.${row.status}`) }}</span>
      </template>
      <template #actions="{ row }">
        <button class="btn btn-small" @click="openDetail(row)">{{ $t("bugQueue.details") }}</button>
      </template>
    </DataTable>

    <div v-if="detail" class="overlay" @click.self="detail = null">
      <div class="dialog">
        <button type="button" class="dialog-close" :aria-label="$t('bugReport.close')" @click="detail = null">&times;</button>
        <h2>{{ $t("bugReport.title") }} · {{ detail.reporter }}</h2>
        <div v-if="detailError" class="error-banner">{{ detailError }}</div>

        <div class="meta">
          <span>{{ formatDateTime(detail.createdDate) }}</span>
          <span>{{ detail.app }} → {{ detail.route }}</span>
          <span v-if="detail.category">{{ $t(`bugReport.categories.${detail.category}`) }}</span>
        </div>

        <h3>{{ $t("bugQueue.note") }}</h3>
        <p class="note">{{ detail.note }}</p>

        <h3>{{ $t("bugQueue.context") }}</h3>
        <p class="mono small">
          session {{ detail.context?.sessionId ?? "—" }} · {{ detail.context?.userAgent ?? "—" }}
        </p>

        <h3>{{ $t("bugQueue.trail") }}</h3>
        <pre class="trail">{{
          (detail.trail ?? [])
            .map((e) => `${formatDateTime(e.t)} [${e.k}] ${e.r} → ${e.m}`)
            .join("\n") || "—"
        }}</pre>

        <template v-if="detail.photo">
          <h3>{{ $t("bugQueue.photo") }}</h3>
          <img class="photo" :src="`data:${detail.photoMime};base64,${detail.photo}`" :alt="$t('bugQueue.photo')" />
        </template>

        <div class="edit-row">
          <label>
            <span>{{ $t("bugQueue.colStatus") }}</span>
            <select v-model="editStatus">
              <option value="open">{{ $t("bugQueue.statuses.open") }}</option>
              <option value="triaged">{{ $t("bugQueue.statuses.triaged") }}</option>
              <option value="closed">{{ $t("bugQueue.statuses.closed") }}</option>
            </select>
          </label>
          <label>
            <span>{{ $t("bugQueue.uatRef") }}</span>
            <input v-model="editUatRef" type="text" :placeholder="$t('bugQueue.uatRefPlaceholder')" />
          </label>
        </div>

        <div class="dialog-actions">
          <button type="button" class="btn btn-danger" :disabled="saving" @click="deleteDetail">
            {{ $t("bugQueue.delete") }}
          </button>
          <button type="button" class="btn" :disabled="saving" @click="detail = null">
            {{ $t("bugReport.cancel") }}
          </button>
          <button type="button" class="btn btn-primary" :disabled="saving" @click="saveDetail">
            {{ $t("bugQueue.save") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.625rem;
  margin-bottom: 0.75rem;
}
.filter-item {
  width: 12.5rem;
}
.error-banner {
  margin-bottom: 0.75rem;
  padding: 0.5625rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.875rem;
  background: #fdecea;
  border: 1px solid #f5b5ae;
  color: #b3261e;
}
.notice-banner {
  margin-bottom: 0.75rem;
  padding: 0.5625rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.875rem;
  background: #e9f7ef;
  border: 1px solid #b5e2c8;
  color: #1e7a46;
}
.sub-line {
  font-size: 0.75rem;
}
.state-badge {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 700;
}
.state-open {
  background: #fdecea;
  color: #b3261e;
}
.state-triaged {
  background: #fff4e0;
  color: #9a5b00;
}
.state-closed {
  background: #e9f7ef;
  color: #1e7a46;
}
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 32, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 1000;
}
.dialog {
  background: #fff;
  border-radius: 0.75rem;
  box-shadow: 0 16px 48px rgba(15, 23, 32, 0.25);
  width: 100%;
  max-width: 46rem;
  max-height: 92vh;
  overflow-y: auto;
  padding: 1.25rem;
  position: relative;
}
.dialog-close {
  position: absolute;
  top: 0.5rem;
  right: 0.75rem;
  border: none;
  background: none;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  color: #64748b;
}
.dialog h2 {
  margin: 0 0 0.75rem;
  font-size: 1.125rem;
}
.dialog h3 {
  margin: 1rem 0 0.25rem;
  font-size: 0.8125rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #64748b;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  font-size: 0.8125rem;
  color: #64748b;
}
.note {
  margin: 0;
  white-space: pre-wrap;
}
.mono {
  font-family: monospace;
}
.small {
  font-size: 0.75rem;
  word-break: break-all;
}
.trail {
  margin: 0;
  padding: 0.625rem 0.75rem;
  background: #f5f7fa;
  border: 1px solid #d8e1ea;
  border-radius: 0.5rem;
  font-family: monospace;
  font-size: 0.75rem;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 16rem;
  overflow-y: auto;
}
.photo {
  max-width: 100%;
  max-height: 24rem;
  border-radius: 0.5rem;
}
.edit-row {
  display: flex;
  gap: 1rem;
  margin-top: 1rem;
}
.edit-row label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.8125rem;
  color: #475569;
}
.edit-row select,
.edit-row input {
  padding: 0.4375rem 0.5rem;
  border: 1px solid #d8e1ea;
  border-radius: 0.5rem;
  font-size: 0.875rem;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1rem;
}
.btn {
  padding: 0.4375rem 0.875rem;
  border-radius: 0.5rem;
  border: 1px solid #d8e1ea;
  background: #fff;
  color: #334155;
  font-size: 0.875rem;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.btn-primary {
  background: var(--brand-blue, #1b8fd4);
  border-color: var(--brand-blue, #1b8fd4);
  color: #fff;
}
.btn-danger {
  color: #b3261e;
  border-color: #f5b5ae;
}
.btn-small {
  padding: 0.25rem 0.625rem;
  font-size: 0.8125rem;
}
</style>
