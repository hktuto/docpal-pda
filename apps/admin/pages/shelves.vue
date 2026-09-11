<script setup lang="ts">
import QRCode from "qrcode";
import { entities } from "~/utils/entities";
import { shelfLabelParams } from "~/utils/print";

// Label printing: per-row Print button (row-actions slot) goes through the
// label print service; multi-select Print selected (bulk-actions slot) opens
// an A4 batch sheet (3 x 4 grid, browser print) instead.
const printItems = ref<{ title: string; params: Record<string, unknown> }[] | null>(null);
const batchPrintItems = ref<{ code: string; zone?: string | null }[] | null>(null);

function printOne(row: any) {
  printItems.value = [{ title: row.code, params: shelfLabelParams(row.code) }];
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
</script>

<template>
  <div>
    <CrudTable :config="entities.shelves">
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
      </template>
    </CrudTable>
    <PrintLabelsDialog v-if="printItems" :items="printItems" @close="printItems = null" />
    <ShelfBatchPrintDialog
      v-if="batchPrintItems"
      :items="batchPrintItems"
      @close="batchPrintItems = null"
    />
  </div>
</template>
