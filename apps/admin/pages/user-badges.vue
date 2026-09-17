<script setup lang="ts">
import QRCode from "qrcode";
import { listPrinters, printFile, waitForPrintJob } from "~/utils/print";
import type { AdminColumnDef } from "~/composables/useAdminTable";

interface User {
  id: string;
  username: string;
  displayName: string;
  groupCodes: string[];
}

const { t } = useI18n();
const api = useApi();

const users = ref<User[]>([]);
const loading = ref(false);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    users.value = await api.get<User[]>("/admin/users");
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

const columnDefs = computed<AdminColumnDef<User>[]>(() => [
  { key: "username", label: t("admin.userBadges.username"), size: 140 },
  { key: "displayName", label: t("admin.userBadges.displayName"), size: 180 },
  {
    key: "groups",
    label: t("admin.userBadges.groups"),
    accessor: (u) => u.groupCodes.join(", "),
    size: 220,
  },
]);

const { table, pagination, resetColumnState } = useAdminTable({
  tableId: "user-badges",
  columns: columnDefs,
  rows: filtered,
  getRowId: (u) => u.id,
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

const selectedUser = ref<User | null>(null);
const password = ref("");
const badgeQr = ref<string | null>(null);
const badgeError = ref("");
const generating = ref(false);

function startBadge(u: User) {
  selectedUser.value = u;
  password.value = "";
  badgeQr.value = null;
  badgeError.value = "";
  printed.value = false;
}

function closeBadge() {
  selectedUser.value = null;
  password.value = "";
  badgeQr.value = null;
  badgeError.value = "";
  printed.value = false;
}

async function generateBadge() {
  if (!selectedUser.value || !password.value) return;
  generating.value = true;
  badgeError.value = "";
  try {
    const value = `${selectedUser.value.username}:${password.value}`;
    badgeQr.value = await QRCode.toDataURL(value, {
      width: 240,
      margin: 2,
      errorCorrectionLevel: "M",
    });
  } catch (e) {
    badgeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    generating.value = false;
  }
}

const printerName = ref(import.meta.client ? localStorage.getItem("badge_printer") ?? "" : "");
const printers = ref<string[]>([]);
const printing = ref(false);
const printed = ref(false);

// Printer names come from the print service via the backend proxy; failure is
// non-fatal — the field stays a free-text input.
async function loadPrinters() {
  try {
    printers.value = await listPrinters();
  } catch {
    printers.value = [];
  }
}

/** Render the badge card (name + username + QR) to a PNG for the print service. */
async function renderBadgePng(): Promise<Blob> {
  const u = selectedUser.value!;
  const canvas = document.createElement("canvas");
  canvas.width = 400;
  canvas.height = 420;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.fillStyle = "#0f1720";
  ctx.font = "700 28px sans-serif";
  ctx.fillText(u.displayName || u.username, 200, 56);
  ctx.fillStyle = "#64748b";
  ctx.font = "18px sans-serif";
  ctx.fillText(u.username, 200, 88);
  const img = new Image();
  img.src = badgeQr.value!;
  await img.decode();
  ctx.drawImage(img, 80, 120, 240, 240);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
      "image/png"
    )
  );
}

async function printBadge() {
  const u = selectedUser.value;
  const printer = printerName.value.trim();
  if (!u || !badgeQr.value || !printer || printing.value) return;
  printing.value = true;
  printed.value = false;
  badgeError.value = "";
  try {
    const png = await renderBadgePng();
    const job = await printFile(png, `badge-${u.username}.png`, { printerName: printer });
    // Submission accepted — now confirm the job actually printed.
    await waitForPrintJob(job.jobId);
    printed.value = true;
    localStorage.setItem("badge_printer", printer);
  } catch (e) {
    badgeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    printing.value = false;
  }
}

onMounted(() => {
  load();
  loadPrinters();
});
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.userBadges.title") }}</h1>
      <button class="btn" :disabled="loading" @click="load">
        {{ $t("admin.common.refresh") }}
      </button>
    </div>

    <div class="search-bar">
      <input
        v-model="q"
        type="search"
        class="search-input"
        autocomplete="off"
        data-1p-ignore
        data-lpignore="true"
        :placeholder="$t('admin.userBadges.searchPlaceholder')"
      />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading && users.length === 0" class="loading">{{ $t("admin.common.loading") }}</div>

    <DataTable
      v-else
      :table="table"
      :loading="loading"
      :empty-text="$t('admin.common.noRecords')"
      :on-reset-columns="resetColumnState"
    >
      <template #cell-groups="{ row }">{{ row.groupCodes.join(", ") || "—" }}</template>
      <template #actions="{ row }">
        <button class="btn-link" @click="startBadge(row)">
          {{ $t("admin.userBadges.createBadge") }}
        </button>
      </template>
    </DataTable>

    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />

    <div v-if="selectedUser" class="modal-overlay" @click.self="closeBadge">
      <div class="modal-box">
        <button class="modal-close" @click="closeBadge">×</button>

        <div v-if="!badgeQr">
          <h2>{{ $t("admin.userBadges.passwordTitle", { user: selectedUser.username }) }}</h2>
          <p class="hint">{{ $t("admin.userBadges.passwordHint") }}</p>
          <div class="form-row">
            <label for="badge-password">{{ $t("admin.auth.password") }}</label>
            <input
              id="badge-password"
              v-model="password"
              type="password"
              autocomplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              :placeholder="$t('admin.userBadges.passwordPlaceholder')"
              @keydown.enter="generateBadge"
            />
          </div>
          <div v-if="badgeError" class="error-banner">{{ badgeError }}</div>
          <div class="modal-actions">
            <button class="btn" @click="closeBadge">{{ $t("admin.common.cancel") }}</button>
            <button class="btn btn-primary" :disabled="!password || generating" @click="generateBadge">
              {{ generating ? $t("admin.common.loading") : $t("admin.userBadges.generate") }}
            </button>
          </div>
        </div>

        <div v-else class="badge-preview">
          <h2>{{ $t("admin.userBadges.badgeTitle") }}</h2>
          <div class="badge-card">
            <div class="badge-name">{{ selectedUser.displayName || selectedUser.username }}</div>
            <div class="badge-user">{{ selectedUser.username }}</div>
            <img :src="badgeQr" :alt="$t('admin.userBadges.qrAlt')" class="badge-qr" />
          </div>
          <div class="form-row">
            <label for="badge-printer">{{ $t("admin.userBadges.printerName") }}</label>
            <input
              id="badge-printer"
              v-model="printerName"
              type="text"
              list="badge-printers"
              autocomplete="off"
              data-1p-ignore
              data-lpignore="true"
              :placeholder="$t('admin.userBadges.printerPlaceholder')"
            />
            <datalist id="badge-printers">
              <option v-for="p in printers" :key="p" :value="p" />
            </datalist>
          </div>
          <div v-if="badgeError" class="error-banner">{{ badgeError }}</div>
          <div v-if="printed" class="success-banner">{{ $t("admin.userBadges.printSuccess") }}</div>
          <div class="modal-actions">
            <button class="btn" @click="closeBadge">{{ $t("admin.common.close") }}</button>
            <button
              class="btn btn-primary"
              :disabled="!printerName.trim() || printing"
              @click="printBadge"
            >
              {{ printing ? $t("admin.common.loading") : $t("admin.userBadges.print") }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-bar {
  margin-bottom: 0.75rem;
}
.search-input {
  width: 20rem;
  max-width: 100%;
  padding: 0.375rem 0.625rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.375rem;
  font-size: 0.875rem;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 1.25rem;
}

.modal-box {
  position: relative;
  background: #fff;
  border-radius: 0.75rem;
  box-shadow: 0 16px 40px rgba(15, 23, 32, 0.25);
  padding: 1.5rem;
  width: 100%;
  max-width: 26.25rem;
}

.modal-close {
  position: absolute;
  top: 0.625rem;
  right: 0.875rem;
  background: none;
  border: none;
  font-size: 1.5rem;
  line-height: 1;
  color: #64748b;
  cursor: pointer;
}

.modal-box h2 {
  margin: 0 0 0.5rem;
  font-size: 1.125rem;
}

.hint {
  margin: 0 0 1rem;
  font-size: 0.8125rem;
  color: #64748b;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  margin-bottom: 1rem;
}

.form-row label {
  font-size: 0.8125rem;
  font-weight: 600;
}

.form-row input {
  padding: 0.5rem 0.625rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.375rem;
  font-size: 0.875rem;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.625rem;
  margin-top: 1rem;
}

.badge-preview {
  text-align: center;
}

.badge-card {
  border: 1px solid #d8e1ea;
  border-radius: 0.75rem;
  padding: 1.5rem;
  margin: 1rem 0;
  background: #f8fafc;
}

.badge-name {
  font-size: 1.25rem;
  font-weight: 700;
  margin-bottom: 0.25rem;
}

.badge-user {
  font-size: 0.875rem;
  color: #64748b;
  margin-bottom: 1rem;
}

.badge-qr {
  width: 15rem;
  height: 15rem;
  image-rendering: pixelated;
}

.success-banner {
  padding: 0.5rem 0.75rem;
  border: 1px solid #86c8a0;
  border-radius: 0.375rem;
  background: #ecf9f1;
  color: #1e7a46;
  font-size: 0.8125rem;
}
</style>
