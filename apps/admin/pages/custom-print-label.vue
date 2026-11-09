<script setup lang="ts">
// Placeholder: CSV upload → client-side parse → label printing comes next.
const { t } = useI18n();
const fileName = ref("");
const fileSize = ref(0);

function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  fileName.value = file?.name ?? "";
  fileSize.value = file?.size ?? 0;
}

const sizeLabel = computed(() =>
  fileSize.value < 1024 ? `${fileSize.value} B` : `${(fileSize.value / 1024).toFixed(1)} KB`
);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ t("admin.pages.customPrintLabel.title") }}</h1>
    </div>

    <div class="card">
      <p>{{ t("admin.pages.customPrintLabel.description") }}</p>
      <div class="form-row">
        <label for="custom-label-csv">{{ t("admin.pages.customPrintLabel.chooseFile") }}</label>
        <input id="custom-label-csv" type="file" accept=".csv,text/csv" @change="onFile" />
        <p v-if="fileName" class="hint">
          {{ t("admin.pages.customPrintLabel.selected", { name: fileName, size: sizeLabel }) }}
        </p>
        <p class="hint">{{ t("admin.pages.customPrintLabel.comingSoon") }}</p>
      </div>
    </div>
  </div>
</template>
