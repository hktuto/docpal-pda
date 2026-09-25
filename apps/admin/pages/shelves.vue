<script setup lang="ts">
import QRCode from "qrcode";
import { entities } from "~/utils/entities";
import { renderShelfLabelPng } from "~/utils/print";

// Label printing: per-row Print button (row-actions slot) renders the label
// to a PNG here and prints it via the print service's /print/files; multi-
// select Print selected / Print all (bulk-actions slot) renders A4 batch
// sheets (3 x 4 grid) to PNGs and prints them the same way.
const printItems = ref<{ title: string; render: () => Promise<Blob>; filename: string }[] | null>(null);
const batchPrintItems = ref<{ code: string; zone?: string | null }[] | null>(null);

function printOne(row: any) {
  printItems.value = [
    {
      title: row.code,
      render: () => renderShelfLabelPng(row.code, row.zone),
      filename: `shelf-label-${row.code}.png`,
    },
  ];
}

function printSelected(rows: any[], clear: () => void) {
  batchPrintItems.value = rows.map((r) => ({ code: r.code, zone: r.zone }));
  clear();
}

function printAll(rows: any[]) {
  batchPrintItems.value = rows.map((r) => ({ code: r.code, zone: r.zone }));
}

// Download the shelf label as a PNG with the same layout as the A4 batch
// sheet cells (QR on top, shelf code below, zone when set), drawn onto a
// canvas in the browser (no print service involved).
async function downloadQr(row: any) {
  const W = 620;
  const H = 700;
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
  const textY = 30 + qrSize + 70;
  ctx.fillStyle = "#000000";
  ctx.font = "700 56px system-ui, sans-serif";
  ctx.fillText(row.code, W / 2, textY, W - 40);
  const zone = row.zone?.trim();
  if (zone) {
    ctx.fillStyle = "#4b5563";
    ctx.font = "36px system-ui, sans-serif";
    ctx.fillText(zone, W / 2, textY + 65, W - 40);
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
</script>

<template>
  <div>
    <CrudTable ref="table" :config="entities.shelves">
      <template #head-actions="{ rows }">
        <button class="btn" :disabled="!rows.length" @click="printAll(rows)">
          {{ $t("admin.print.printAll", { count: rows.length }) }}
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
    <PrintLabelsDialog v-if="printItems" :items="printItems" @close="printItems = null" />
    <ShelfBatchPrintDialog
      v-if="batchPrintItems"
      :items="batchPrintItems"
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
