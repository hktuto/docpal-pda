<script setup lang="ts">
import QRCode from "qrcode";
import { entities } from "~/utils/entities";
import { shelfLabelParams } from "~/utils/print";

// Label printing: per-row Print button (row-actions slot) and multi-select
// checkboxes + Print selected (bulk-actions slot) via CrudTable's `selectable`.
const printItems = ref<{ title: string; params: Record<string, unknown> }[] | null>(null);

function printOne(row: any) {
  printItems.value = [{ title: row.code, params: shelfLabelParams(row.code) }];
}

function printSelected(rows: any[], clear: () => void) {
  printItems.value = rows.map((r) => ({ title: r.code, params: shelfLabelParams(r.code) }));
  clear();
}

// Generate the shelf QR as a PNG in the browser and download it directly
// (no print service involved).
async function downloadQr(row: any) {
  const url = await QRCode.toDataURL(row.code, {
    width: 512,
    margin: 2,
    errorCorrectionLevel: "M",
  });
  const a = document.createElement("a");
  a.href = url;
  a.download = `shelf-${row.code}.png`;
  a.click();
}
</script>

<template>
  <div>
    <CrudTable :config="entities.shelves">
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
  </div>
</template>
