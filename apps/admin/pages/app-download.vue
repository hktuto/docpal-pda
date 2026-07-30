<script setup lang="ts">
interface AppDownloadInfo {
  versionName: string;
  versionCode: number;
  webUrl: string;
  builtAt: string;
  fileName: string;
  sizeBytes: number;
}

const api = useApi();
const config = useRuntimeConfig();
const apiBaseUrl = config.public.apiBaseUrl as string;

const info = ref<AppDownloadInfo | null>(null);
const loading = ref(true);
const notAvailable = ref(false);
const error = ref("");
const downloading = ref(false);
const downloadError = ref("");

onMounted(async () => {
  try {
    info.value = await api.get("/admin/app-download");
  } catch (e: any) {
    if (String(e.message).includes("apk_not_available")) {
      notAvailable.value = true;
    } else {
      error.value = e.message;
    }
  } finally {
    loading.value = false;
  }
});

const sizeMb = computed(() => (info.value ? `${(info.value.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : ""));

async function download() {
  if (!info.value || downloading.value) return;
  downloading.value = true;
  downloadError.value = "";
  try {
    const token = localStorage.getItem("admin_token");
    const res = await fetch(`${apiBaseUrl}/admin/app-download/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) throw new Error((await res.text()).trim() || `Request failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = info.value.versionName ? `warehouse-pda-${info.value.versionName}.apk` : "warehouse-pda.apk";
    a.click();
    URL.revokeObjectURL(url);
  } catch (e: any) {
    downloadError.value = e.message;
  } finally {
    downloading.value = false;
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.appDownload.title") }}</h1>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <template v-else-if="notAvailable">
      <h2 class="section-title">{{ $t("admin.pages.appDownload.emptyTitle") }}</h2>
      <p class="muted">{{ $t("admin.pages.appDownload.emptyMessage") }}</p>
    </template>

    <template v-else-if="info">
      <div class="detail-grid">
        <div>
          <div class="dt">{{ $t("admin.pages.appDownload.version") }}</div>
          <div class="dd">{{ info.versionName }} ({{ info.versionCode }})</div>
        </div>
        <div>
          <div class="dt">{{ $t("admin.pages.appDownload.builtAt") }}</div>
          <div class="dd">{{ formatCell(info.builtAt) }}</div>
        </div>
        <div>
          <div class="dt">{{ $t("admin.pages.appDownload.webUrl") }}</div>
          <div class="dd">{{ info.webUrl }}</div>
        </div>
        <div>
          <div class="dt">{{ $t("admin.pages.appDownload.size") }}</div>
          <div class="dd">{{ sizeMb }}</div>
        </div>
      </div>

      <div class="actions">
        <button class="btn btn-primary" :disabled="downloading" @click="download">
          {{ downloading ? $t("admin.pages.appDownload.downloading") : $t("admin.pages.appDownload.download") }}
        </button>
      </div>
      <div v-if="downloadError" class="error-banner">{{ downloadError }}</div>
    </template>
  </div>
</template>

<style scoped>
.section-title {
  font-size: 15px;
  margin: 18px 0 8px;
  color: #52606d;
}
.actions {
  margin-top: 16px;
}
</style>
