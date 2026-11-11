<script setup lang="ts">
// Custom Print Label — CSV upload step: parse in the browser into JS objects
// keyed by the header names (conversion to A4-LWXY print params happens
// backend-side, see docs/dev-guide-zh/flows/custom-print-label.md §3.1).
import { parseCustomLabelCsv, type CustomLabelCsvError } from "~/utils/customLabelCsv";

const { t } = useI18n();
const PREVIEW_LIMIT = 10;

const fileName = ref("");
const fileSize = ref(0);
const inputEl = ref()
const header = ref<string[]>([]);
const rows = ref<Record<string, string>[]>([]);
const converted = ref<Record<string, string>[]>([]);
const errors = ref<CustomLabelCsvError[]>([]);
const parseError = ref("");
const parsed = ref(false);

function errorText(e: CustomLabelCsvError): string {
  if (e.kind === "empty") return t("admin.pages.customPrintLabel.emptyError");
  return t("admin.pages.customPrintLabel.rowCountError", {
    line: e.line,
    actual: e.actual,
    expected: e.expected,
  });
}

function cancel() {
  header.value = []
  rows.value = []
  converted.value = []
  errors.value = []
  parsed.value = false
  inputEl.value.value = ''
  fileName.value = ''
  fileSize.value = null;
}

async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  fileName.value = file?.name ?? "";
  fileSize.value = file?.size ?? 0;
  header.value = [];
  rows.value = [];
  errors.value = [];
  parseError.value = "";
  parsed.value = false;
  if (!file) return;
  parsed.value = true;
  try {
    const txt = await file.text()
    const res = await parseCustomLabelCsv(txt);
    header.value = res.header;
    rows.value = res.rows;
    errors.value = res.errors;
    converted.value = res.converted
  } catch (err) {
    parseError.value = String(err);
  }
}

const sizeLabel = computed(() =>
  fileSize.value < 1024 ? `${fileSize.value} B` : `${(fileSize.value / 1024).toFixed(1)} KB`
);

const preview = computed(() => rows.value.slice(0, PREVIEW_LIMIT));
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
        <input id="custom-label-csv" ref="inputEl" type="file" accept=".csv,text/csv" @change="onFile" />
        <p v-if="fileName" class="hint">
          {{ t("admin.pages.customPrintLabel.selected", { name: fileName, size: sizeLabel }) }}
        </p>
      </div>
    </div>

    <template v-if="parsed">
      <div v-if="rows.length > 0" class="success-banner">
        {{ t("admin.pages.customPrintLabel.parsed", { count: rows.length }) }}
      </div>

      <div v-if="parseError || errors.length > 0" class="error-banner">
        <div>
          <div v-if="parseError">{{ parseError }}</div>
          <div v-for="e in errors" :key="e.line + String(e.actual)" :data-kind="e.kind">
            {{ errorText(e) }}
          </div>
        </div>
      </div>

      <template v-if="header.length > 0 && preview.length > 0">
        <div class="form-row">
          <p class="hint">
            {{ t("admin.pages.customPrintLabel.preview", { limit: PREVIEW_LIMIT }) }}
          </p>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>#</th>
                <th v-for="h in header" :key="h">{{ h }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in preview" :key="i">
                <td>{{ i + 1 }}</td>
                <td v-for="h in header" :key="h">{{ row[h] }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>

    <div class="form-row">
      <p class="hint">{{ t("admin.pages.customPrintLabel.comingSoon") }}</p>
      <button @click="cancel" >Clean</button>
    </div>
  </div>
</template>
