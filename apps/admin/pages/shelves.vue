<script setup lang="ts">
import QRCode from "qrcode";
import { entities } from "~/utils/entities";
import { renderShelfLabelPng, type LabelSizeId } from "~/utils/print";
import { useWarehouseLabelLayout } from "~/composables/useWarehouseLabelLayout";
import { useApi } from "~/composables/useApi";

const { layout: labelLayout } = useWarehouseLabelLayout();
const api = useApi();

// Label printing: per-row Print button (row-actions slot) renders the label
// to a PNG here and prints it via the print service's /print/files; multi-
// select Print selected / Print all (bulk-actions slot) renders A4 batch
// sheets (grid per the chosen label size) to PNGs and prints them the same
// way. The label itself shows the shelf code (the QR encodes the same code);
// only the dialog's item title uses the display name.
const printItems = ref<{ title: string; render: (size: LabelSizeId) => Promise<Blob>; filename: string }[] | null>(
  null
);
const batchPrintItems = ref<string[] | null>(null);

function printOne(row: any) {
  printItems.value = [
    {
      title: row.displayName || row.code,
      render: (size) => renderShelfLabelPng(row.code, labelLayout.value, size),
      filename: `shelf-label-${row.code}.png`,
    },
  ];
}

function printSelected(rows: any[], clear: () => void) {
  batchPrintItems.value = rows.map((r) => r.code);
  clear();
}

function printAll(rows: any[]) {
  batchPrintItems.value = rows.map((r) => r.code);
}

// Download the shelf label as a PNG with the same layout as the A4 batch
// sheet cells (QR on top, shelf display name below, zone when set), drawn
// onto a canvas in the browser (no print service involved).
async function downloadQr(row: any) {
  const W = 620;
  const H = 780;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  const qrSize = 440;
  const qrCanvas = document.createElement("canvas");
  await QRCode.toCanvas(qrCanvas, row.code, {
    width: qrSize,
    margin: 1,
    errorCorrectionLevel: "M",
  });
  ctx.drawImage(qrCanvas, (W - qrSize) / 2, 30);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const textY = 30 + qrSize + 90;
  ctx.fillStyle = "#000000";
  ctx.font = "900 112px system-ui, sans-serif";
  ctx.fillText(row.displayName || row.code, W / 2, textY, W - 40);
  const zone = row.zone?.trim();
  if (zone) {
    ctx.fillStyle = "#4b5563";
    ctx.font = "36px system-ui, sans-serif";
    ctx.fillText(zone, W / 2, textY + 100, W - 40);
  }

  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `shelf-${row.code}.png`;
  a.click();
}
// Batch edit of the selected shelves (sub-inventory affinity + warning —
// ShelfBulkEditDialog): saving PATCHes each shelf, then the table reloads and
// the selection clears.
const table = ref<{ reload: () => Promise<void> } | null>(null);
const bulkEdit = ref<{ rows: any[]; clear: () => void } | null>(null);

async function onBulkEditSaved() {
  bulkEdit.value?.clear();
  bulkEdit.value = null;
  await table.value?.reload();
}

// ---- Excel export / import ----
// Export all shelves (code, name, group, warning, sub_inventory) as .xlsx.
// Import reads the same columns; shelf code decides create vs update.

interface ShelfExportRow {
  code: string;
  displayName: string;
  zone: string;
  warning: string;
  subInventory: string;
}

function parseSubInventory(raw: string): { orgId: number; code: string }[] | null {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const scopes: { orgId: number; code: string }[] = [];
  for (const part of parts) {
    const idx = part.indexOf(":");
    if (idx < 0) throw new Error(`Invalid sub_inventory format: "${part}". Expected "orgId:code".`);
    const orgId = parseInt(part.slice(0, idx), 10);
    const code = part.slice(idx + 1).trim();
    if (!orgId || !code) throw new Error(`Invalid sub_inventory format: "${part}". Expected "orgId:code".`);
    scopes.push({ orgId, code });
  }
  return scopes;
}

async function exportExcel() {
  const XLSX = await import("xlsx");
  const shelves = await api.get<any[]>("/admin/shelves");
  const rows: ShelfExportRow[] = shelves.map((r: any) => ({
    code: r.code ?? "",
    displayName: r.displayName ?? "",
    zone: r.zone ?? "",
    warning: r.warning ?? "",
    subInventory: r.subInventoryScopes?.length
      ? r.subInventoryScopes.map((s: any) => `${s.orgId}:${s.code}`).join(", ")
      : "",
  }));
  const aoa = [
    ["Code", "Name", "Group", "Warning", "Sub-Inventory"],
    ...rows.map((r) => [r.code, r.displayName, r.zone, r.warning, r.subInventory]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Shelves");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  XLSX.writeFile(wb, `shelves-${stamp}.xlsx`);
}

const importing = ref(false);
const importError = ref("");
const importResult = ref<{ created: number; updated: number; skipped: number } | null>(null);

function triggerImport() {
  document.querySelector<HTMLInputElement>('input[type="file"][accept=".xlsx,.xls"]')?.click();
}

async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // reset so same file can be re-selected
  if (!file) return;

  importing.value = true;
  importError.value = "";
  importResult.value = null;

  try {
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" });

    if (aoa.length < 2) {
      importError.value = "The file contains no data rows.";
      return;
    }

    // Find column indices from the header row (case-insensitive)
    const headers = aoa[0].map((h) => h.trim().toLowerCase());
    const codeIdx = headers.findIndex((h) => h === "code" || h === "shelf code" || h === "shelf_code");
    const nameIdx = headers.findIndex((h) => h === "name" || h === "display name" || h === "display_name");
    const groupIdx = headers.findIndex((h) => h === "group" || h === "zone");
    const warnIdx = headers.findIndex((h) => h === "warning");
    const subInvIdx = headers.findIndex(
      (h) => h === "sub-inventory" || h === "sub inventory" || h === "sub_inventory"
    );

    if (codeIdx < 0) {
      importError.value = 'Could not find "Code" column in the file.';
      return;
    }

    // Build the batch payload — one API call for all rows
    const payload: Record<string, any>[] = [];
    for (let i = 1; i < aoa.length; i++) {
      const row = aoa[i];
      const code = String(row[codeIdx] ?? "").trim();
      if (!code) continue;

      const item: Record<string, any> = { code };
      if (nameIdx >= 0) item.displayName = String(row[nameIdx] ?? "").trim() || null;
      if (groupIdx >= 0) item.zone = String(row[groupIdx] ?? "").trim() || null;
      if (warnIdx >= 0) item.warning = String(row[warnIdx] ?? "").trim() || null;
      if (subInvIdx >= 0) {
        const raw = String(row[subInvIdx] ?? "").trim();
        item.subInventoryScopes = raw ? parseSubInventory(raw) : null;
      }
      payload.push(item);
    }

    const result = await api.post<{ created: number; updated: number; skipped: number; errors: any[] }>(
      "/admin/shelves/batch-import",
      { shelves: payload }
    );

    importResult.value = { created: result.created, updated: result.updated, skipped: result.skipped };
    if (result.errors?.length) {
      importError.value = result.errors.map((e: any) => `${e.code}: ${e.message}`).join("; ");
    }
    await table.value?.reload();
  } catch (err: any) {
    importError.value = err?.message ?? String(err);
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div>
    <div v-if="importResult" class="alert alert-success">
      Import complete: {{ importResult.created }} created, {{ importResult.updated }} updated,
      {{ importResult.skipped }} skipped.
    </div>
    <div v-if="importError" class="alert alert-error">{{ importError }}</div>
    <CrudTable ref="table" :config="entities.shelves">
      <template #head-actions="{ rows }">
        <button class="btn" :disabled="!rows.length" @click="printAll(rows)">
          {{ $t("admin.print.printAll", { count: rows.length }) }}
        </button>
        <button class="btn btn-secondary" @click="exportExcel">Export Excel</button>
        <button class="btn btn-secondary" :disabled="importing" @click="triggerImport">
          {{ importing ? "Importing..." : "Import Excel" }}
        </button>
      </template>
      <template #row-actions="{ row }">
        <button class="btn-link" @click="printOne(row)">{{ $t("admin.print.print") }}</button>
        <button class="btn-link" @click="downloadQr(row)">{{ $t("admin.print.downloadQr") }}</button>
      </template>
      <template #bulk-actions="{ rows, clear }">
        <button class="btn btn-primary" @click="printSelected(rows, clear)">
          {{ $t("admin.print.printSelected", { count: rows.length }) }}
        </button>
        <button class="btn" @click="bulkEdit = { rows, clear }">
          {{ $t("admin.shelves.bulkEdit", { count: rows.length }) }}
        </button>
      </template>
    </CrudTable>
    <input
      ref="fileInput"
      type="file"
      accept=".xlsx,.xls"
      style="display: none"
      @change="onImportFile"
    />
    <PrintLabelsDialog v-if="printItems" :items="printItems" @close="printItems = null" />
    <ShelfBatchPrintDialog
      v-if="batchPrintItems"
      :codes="batchPrintItems"
      @close="batchPrintItems = null"
    />
    <ShelfBulkEditDialog
      v-if="bulkEdit"
      :shelves="bulkEdit.rows"
      @saved="onBulkEditSaved"
      @close="bulkEdit = null"
    />
  </div>
</template>
