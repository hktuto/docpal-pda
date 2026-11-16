<script setup lang="ts">
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

// Bulk multi-shelf inventory Excel import — top-of-table button on the
// shelves page. Same Excel as the per-shelf import (wcl_item_no | date_code |
// drawing_no | qty) plus a REQUIRED shelf_code column; one Org / sub-inventory
// pair is chosen once and applied to every shelf in the file. Rows are
// grouped by shelf code and POSTed through the existing per-shelf endpoint
// (/admin/shelves/import-inventory) one shelf at a time; an unknown or
// out-of-scope shelf is reported per shelf and the remaining shelves still
// import.

const emit = defineEmits<{
  saved: [];
  close: [];
}>();

const flow = useFlowApi();
const { t } = useI18n();
const { onMousedown, onClick } = useOverlayDismiss(() => emit("close"));

const REQUIRED_HEADERS = ["wcl_item_no", "date_code", "qty", "shelf_code"];
// drawing_no is OPTIONAL — recognized when present (case-insensitive header
// match, like the required columns); files without the column still import.
const OPTIONAL_HEADERS = ["drawing_no"];

const loading = ref(false);
const submitting = ref(false);
const error = ref("");
const pair = ref("");
const pairs = ref<{ orgId: number; code: string; description: string | null }[]>([]);
const rows = ref<{ shelfCode: string; wclItemNo: string; dateCode: string | null; drawingNo: string | null; qty: number }[] | null>(null);
const rowErrors = ref<{ row: number; message: string }[]>([]);
const result = ref<{ shelves: number; inserted: number; merged: number } | null>(null);
const shelfErrors = ref<string[]>([]);
const fileName = ref("");

const pairOptions = computed<SearchableSelectOption[]>(() =>
  pairs.value.map((p) => ({
    value: `${p.orgId}:${p.code}`,
    label: p.description ? `${p.orgId} / ${p.code} (${p.description})` : `${p.orgId} / ${p.code}`,
  }))
);

onMounted(async () => {
  loading.value = true;
  try {
    const res = await flow.shelfOrgOptions(); // no shelfCode = all pairs
    pairs.value = res.pairs;
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    loading.value = false;
  }
});

function triggerFile() {
  document.querySelector<HTMLInputElement>("input[data-import-shelf-bulk]")?.click();
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // reset so the same file can be re-selected
  if (!file) return;
  error.value = "";
  rows.value = null;
  rowErrors.value = [];
  result.value = null;
  shelfErrors.value = [];
  fileName.value = file.name;
  try {
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" });
    if (aoa.length < 2) throw new Error(t("admin.shelves.importInventory.noRows"));

    // Header row decides the column indices — extra columns are ignored;
    // missing/renamed required columns are a hard client-side error.
    const headers = aoa[0].map((h) => String(h).trim().toLowerCase());
    const idx: Record<string, number> = {};
    for (const col of REQUIRED_HEADERS) {
      const i = headers.indexOf(col);
      if (i < 0) throw new Error(t("admin.shelves.importInventory.missingColumn", { column: col }));
      idx[col] = i;
    }
    for (const col of OPTIONAL_HEADERS) {
      const i = headers.indexOf(col);
      if (i >= 0) idx[col] = i;
    }

    const parsed: { shelfCode: string; wclItemNo: string; dateCode: string | null; drawingNo: string | null; qty: number }[] = [];
    const problems: string[] = [];
    for (let i = 1; i < aoa.length; i++) {
      const row = aoa[i];
      const shelfCode = String(row[idx.shelf_code] ?? "").trim();
      const wclItemNo = String(row[idx.wcl_item_no] ?? "").trim();
      const dateCode = String(row[idx.date_code] ?? "").trim() || null;
      const drawingNo =
        idx.drawing_no !== undefined ? String(row[idx.drawing_no] ?? "").trim() || null : null;
      const qtyRaw = row[idx.qty];
      const qty = typeof qtyRaw === "number" ? qtyRaw : Number(String(qtyRaw).trim());
      if (!shelfCode) {
        problems.push(t("admin.shelves.importInventory.bulkEmptyShelfCode", { row: i + 1 }));
        continue;
      }
      if (!wclItemNo) {
        problems.push(t("admin.shelves.importInventory.emptyWclItemNo", { row: i + 1 }));
        continue;
      }
      if (!Number.isInteger(qty) || qty <= 0) {
        problems.push(t("admin.shelves.importInventory.badQty", { row: i + 1 }));
        continue;
      }
      parsed.push({ shelfCode, wclItemNo, dateCode, drawingNo, qty });
    }
    if (problems.length) throw new Error(problems.join("; "));
    if (!parsed.length) throw new Error(t("admin.shelves.importInventory.noRows"));
    rows.value = parsed;
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  }
}

async function submit() {
  if (!pair.value || !rows.value?.length) return;
  error.value = "";
  rowErrors.value = [];
  result.value = null;
  shelfErrors.value = [];
  submitting.value = true;
  try {
    const [orgId, subInventoryCode] = pair.value.split(":");

    // Group the parsed rows by shelf code (input order preserved).
    const byShelf = new Map<string, { wclItemNo: string; dateCode: string | null; drawingNo: string | null; qty: number }[]>();
    for (const row of rows.value) {
      let group = byShelf.get(row.shelfCode);
      if (!group) {
        group = [];
        byShelf.set(row.shelfCode, group);
      }
      group.push({ wclItemNo: row.wclItemNo, dateCode: row.dateCode, drawingNo: row.drawingNo, qty: row.qty });
    }

    let inserted = 0;
    let merged = 0;
    let shelvesOk = 0;
    const errors: { row: number; message: string }[] = [];
    const shelfErrorsLocal: string[] = [];
    for (const [shelfCode, shelfRows] of byShelf) {
      try {
        const res = await flow.importShelfInventory({
          shelfCode,
          orgId: Number(orgId),
          subInventoryCode,
          rows: shelfRows,
        });
        inserted += res.inserted;
        merged += res.merged;
        for (const e of res.errors ?? []) {
          errors.push({ row: e.row, message: `${shelfCode}: ${e.message}` });
        }
        if (res.inserted + res.merged > 0) shelvesOk++;
      } catch (e: any) {
        shelfErrorsLocal.push(`${shelfCode}: ${e?.message ?? String(e)}`);
      }
    }
    result.value = { shelves: shelvesOk, inserted, merged };
    rowErrors.value = errors;
    shelfErrors.value = shelfErrorsLocal;
    if (inserted + merged > 0) emit("saved");
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="overlay" @mousedown="onMousedown" @click="onClick">
    <div class="dialog" role="dialog" :aria-label="$t('admin.shelves.importInventory.bulkTitle')">
      <h2>{{ $t("admin.shelves.importInventory.bulkTitle") }}</h2>
      <p class="muted">{{ $t("admin.shelves.importInventory.bulkHint") }}</p>

      <div v-if="error" class="error-banner">{{ error }}</div>
      <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

      <template v-else>
        <label class="form-row">
          <span>{{ $t("admin.shelves.importInventory.orgSubInventory") }}</span>
          <SearchableSelect
            v-model="pair"
            :options="pairOptions"
            :all-label="$t('admin.shelves.importInventory.pickOrgSubInventory')"
            :aria-label="$t('admin.shelves.importInventory.orgSubInventory')"
            :multiple="false"
            :show-all="false"
          />
        </label>

        <div class="form-row">
          <span>{{ $t("admin.shelves.importInventory.file") }}</span>
          <button type="button" class="btn btn-secondary" @click="triggerFile">
            {{ $t("admin.shelves.importInventory.pickFile") }}
          </button>
          <span v-if="fileName" class="muted">{{ fileName }}</span>
          <input
            type="file"
            accept=".xlsx,.xls"
            style="display: none"
            data-import-shelf-bulk
            @change="onFile"
          />
        </div>

        <div v-if="rows" class="muted">
          {{ $t("admin.shelves.importInventory.bulkRowsReady", { count: rows.length, shelves: new Set(rows.map((r) => r.shelfCode)).size }) }}
        </div>
        <div v-if="result" class="success-banner">
          {{ $t("admin.shelves.importInventory.bulkResult", { shelves: result.shelves, inserted: result.inserted, merged: result.merged }) }}
        </div>
        <div v-if="shelfErrors.length" class="error-banner">
          <div v-for="(e, i) in shelfErrors" :key="`s${i}`">{{ e }}</div>
        </div>
        <div v-if="rowErrors.length" class="error-banner">
          <div v-for="(e, i) in rowErrors" :key="i">
            {{ $t("admin.shelves.importInventory.rowError", { row: e.row, message: e.message }) }}
          </div>
        </div>

        <div class="dialog-actions">
          <button class="btn" @click="emit('close')">{{ $t("admin.common.cancel") }}</button>
          <button class="btn btn-primary" :disabled="submitting || !pair || !rows" @click="submit">
            {{ $t("admin.shelves.importInventory.submit") }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
