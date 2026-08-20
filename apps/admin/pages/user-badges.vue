<script setup lang="ts">
import QRCode from "qrcode";
import { getPrintBaseUrl, printFile, waitForPrintJob } from "~/utils/print";

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

const { page, pageSize, total, paged } = usePaging(filtered);

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
const printing = ref(false);
const printed = ref(false);

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
    const baseUrl = getPrintBaseUrl();
    const png = await renderBadgePng();
    const job = await printFile(baseUrl, png, `badge-${u.username}.png`, { printerName: printer });
    // Submission accepted — now confirm the job actually printed.
    await waitForPrintJob(baseUrl, job.jobId);
    printed.value = true;
    localStorage.setItem("badge_printer", printer);
  } catch (e) {
    badgeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    printing.value = false;
  }
}

onMounted(load);
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

    <div v-else class="table-wrap" :class="{ 'is-loading': loading }">
      <table class="data">
        <thead>
          <tr>
            <th>{{ $t("admin.userBadges.username") }}</th>
            <th>{{ $t("admin.userBadges.displayName") }}</th>
            <th>{{ $t("admin.userBadges.groups") }}</th>
            <th>{{ $t("admin.common.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in paged" :key="u.id">
            <td>{{ u.username }}</td>
            <td>{{ u.displayName }}</td>
            <td>{{ u.groupCodes.join(", ") || "—" }}</td>
            <td class="actions">
              <button class="btn-link" @click="startBadge(u)">
                {{ $t("admin.userBadges.createBadge") }}
              </button>
            </td>
          </tr>
          <tr v-if="paged.length === 0">
            <td colspan="4" class="muted">{{ $t("admin.common.noRecords") }}</td>
          </tr>
        </tbody>
      </table>
    </div>

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
              autocomplete="off"
              data-1p-ignore
              data-lpignore="true"
              :placeholder="$t('admin.userBadges.printerPlaceholder')"
            />
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
  margin-bottom: 12px;
}
.search-input {
  width: 320px;
  max-width: 100%;
  padding: 6px 10px;
  border: 1px solid #b6c2cd;
  border-radius: 6px;
  font-size: 14px;
}

.table-wrap.is-loading {
  opacity: 0.5;
  pointer-events: none;
}

.actions {
  white-space: nowrap;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 20px;
}

.modal-box {
  position: relative;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 16px 40px rgba(15, 23, 32, 0.25);
  padding: 24px;
  width: 100%;
  max-width: 420px;
}

.modal-close {
  position: absolute;
  top: 10px;
  right: 14px;
  background: none;
  border: none;
  font-size: 24px;
  line-height: 1;
  color: #64748b;
  cursor: pointer;
}

.modal-box h2 {
  margin: 0 0 8px;
  font-size: 18px;
}

.hint {
  margin: 0 0 16px;
  font-size: 13px;
  color: #64748b;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
}

.form-row label {
  font-size: 13px;
  font-weight: 600;
}

.form-row input {
  padding: 8px 10px;
  border: 1px solid #b6c2cd;
  border-radius: 6px;
  font-size: 14px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}

.badge-preview {
  text-align: center;
}

.badge-card {
  border: 1px solid #d8e1ea;
  border-radius: 12px;
  padding: 24px;
  margin: 16px 0;
  background: #f8fafc;
}

.badge-name {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 4px;
}

.badge-user {
  font-size: 14px;
  color: #64748b;
  margin-bottom: 16px;
}

.badge-qr {
  width: 240px;
  height: 240px;
  image-rendering: pixelated;
}

.success-banner {
  padding: 8px 12px;
  border: 1px solid #86c8a0;
  border-radius: 6px;
  background: #ecf9f1;
  color: #1e7a46;
  font-size: 13px;
}
</style>
