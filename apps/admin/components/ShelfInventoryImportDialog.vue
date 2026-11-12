<script setup lang="ts">
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

// Per-shelf inventory Excel import (spec 2026-11-13-uat-inventory-tools-
// design.md). Opened from the shelves page row-actions "Import" button: the
// admin picks the target (org, sub-inventory) pair (offered pairs come from
// GET /admin/shelves/import-inventory/org-options — already restricted to the
// shelf's sub_inventory_scopes), picks an .xlsx with exactly the columns
// wcl_item_no | date_code | qty, and the decoded rows are validated
// client-side and POSTed as JSON. Per-row errors (e.g. unknown wcl_item_no)
// are rendered in the dialog; valid rows still commit.

interface ShelfRow {
  code: string;
  displayName?: string | null;
}

const props = defineProps<{
  shelf: ShelfRow;
}>();

const emit = defineEmits<{
  saved: [];
  close: [];
}>();

const flow = useFlowApi();
const { t } = useI18n();
const { onMousedown, onClick } = useOverlayDismiss(() => emit("close"));

const REQUIRED_HEADERS = ["wcl_item_no", "date_code", "qty"];

const loading = ref(false);
const submitting = ref(false);
const error = ref("");
const pair = ref("");
const pairs = ref<{ orgId: number; code: string; description: string | null }[]>([]);
const rows = ref<{ wclItemNo: string; dateCode: string | null; qty: number }[] | null>(null);
const rowErrors = ref<{ row: number; message: string }[]>([]);
const result = ref<{ inserted: number; merged: number } | null>(null);
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
    const res = await flow.shelfOrgOptions(props.shelf.code);
    pairs.value = res.pairs;
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    loading.value = false;
  }
});

function triggerFile() {
  document
    .querySelector<HTMLInputElement>(`input[data-import-shelf="${props.shelf.code}"]`)
    ?.click();
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

    const parsed: { wclItemNo: string; dateCode: string | null; qty: number }[] = [];
    const problems: string[] = [];
    for (let i = 1; i < aoa.length; i++) {
      const row = aoa[i];
      const wclItemNo = String(row[idx.wcl_item_no] ?? "").trim();
      const dateCode = String(row[idx.date_code] ?? "").trim() || null;
      const qtyRaw = row[idx.qty];
      const qty = typeof qtyRaw === "number" ? qtyRaw : Number(String(qtyRaw).trim());
      if (!wclItemNo) {
        problems.push(t("admin.shelves.importInventory.emptyWclItemNo", { row: i + 1 }));
        continue;
      }
      if (!Number.isInteger(qty) || qty <= 0) {
        problems.push(t("admin.shelves.importInventory.badQty", { row: i + 1 }));
        continue;
      }
      parsed.push({ wclItemNo, dateCode, qty });
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
  submitting.value = true;
  try {
    const [orgId, subInventoryCode] = pair.value.split(":");
    const res = await flow.importShelfInventory({
      shelfCode: props.shelf.code,
      orgId: Number(orgId),
      subInventoryCode,
      rows: rows.value,
    });
    result.value = { inserted: res.inserted, merged: res.merged };
    rowErrors.value = res.errors ?? [];
    if (res.ok || res.inserted + res.merged > 0) emit("saved");
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="overlay" @mousedown="onMousedown" @click="onClick">
    <div class="dialog" role="dialog" :aria-label="$t('admin.shelves.importInventory.title')">
      <h2>{{ $t("admin.shelves.importInventory.title", { shelf: shelf.displayName || shelf.code }) }}</h2>
      <p class="muted">{{ $t("admin.shelves.importInventory.hint") }}</p>

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
            :data-import-shelf="shelf.code"
            @change="onFile"
          />
        </div>

        <div v-if="rows" class="muted">
          {{ $t("admin.shelves.importInventory.rowsReady", { count: rows.length }) }}
        </div>
        <div v-if="result" class="success-banner">
          {{ $t("admin.shelves.importInventory.result", { inserted: result.inserted, merged: result.merged }) }}
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
