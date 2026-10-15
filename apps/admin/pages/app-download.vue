<script setup lang="ts">
interface AppDownloadInfo {
  versionName: string;
  versionCode: number;
  webUrl: string;
  builtAt: string;
  fileName: string;
  sizeBytes: number;
  region?: string;
}

const api = useApi();
const config = useRuntimeConfig();
const apiBaseUrl = config.public.apiBaseUrl as string;

const regions = ref<string[]>([]);
const selectedRegion = ref("hk");
const info = ref<AppDownloadInfo | null>(null);
const loading = ref(true);
const notAvailable = ref(false);
const error = ref("");
const downloading = ref(false);
const downloadError = ref("");

onMounted(async () => {
  try {
    const res = await api.get("/admin/app-download/regions");
    regions.value = res.regions || [];
    if (regions.value.length > 0 && !regions.value.includes(selectedRegion.value)) {
      selectedRegion.value = regions.value[0];
    }
  } catch {
    // regions endpoint may not exist yet; fall back to empty list
  }
  await loadInfo();
});

async function loadInfo() {
  loading.value = true;
  notAvailable.value = false;
  error.value = "";
  try {
    info.value = await api.get(`/admin/app-download?region=${selectedRegion.value}`);
  } catch (e: any) {
    if (String(e.message).includes("apk_not_available")) {
      notAvailable.value = true;
    } else {
      error.value = e.message;
    }
  } finally {
    loading.value = false;
  }
}

function onRegionChange() {
  loadInfo();
}

const sizeMb = computed(() => (info.value ? `${(info.value.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : ""));

async function download() {
  if (!info.value || downloading.value) return;
  downloading.value = true;
  downloadError.value = "";
  try {
    const token = localStorage.getItem("admin_token");
    const res = await fetch(`${apiBaseUrl}/admin/app-download/file?region=${selectedRegion.value}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) throw new Error((await res.text()).trim() || `Request failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = info.value.versionName ? `warehouse-pda-${info.value.versionName}.apk` : `warehouse-pda-${selectedRegion.value}.apk`;
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
      <div v-if="regions.length > 1" class="region-select">
        <label for="region">{{ $t("admin.pages.appDownload.region") }}</label>
        <select id="region" v-model="selectedRegion" @change="onRegionChange">
          <option v-for="r in regions" :key="r" :value="r">
            {{ r.toUpperCase() }}
          </option>
        </select>
      </div>

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
.region-select {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.region-select label {
  font-weight: 600;
  font-size: 0.875rem;
}
.region-select select {
  padding: 0.375rem 0.75rem;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  font-size: 0.875rem;
}
.section-title {
  font-size: 0.9375rem;
  margin: 1.125rem 0 0.5rem;
  color: #52606d;
}
.actions {
  margin-top: 1rem;
}
</style>
