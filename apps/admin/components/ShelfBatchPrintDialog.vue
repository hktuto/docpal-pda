<script setup lang="ts">
import QRCode from "qrcode";

// Batch A4 shelf-label sheet: selected shelves are laid out 3 x 4 per A4
// page with padding; each cell shows the shelf QR, the shelf code, and the
// zone (when set). Printing uses the browser print dialog (any A4 printer),
// unlike the single-label PrintLabelsDialog which goes through the label
// print service.
const props = defineProps<{
  items: { code: string; zone?: string | null }[];
}>();
const emit = defineEmits<{ close: [] }>();

const dlg = useOverlayDismiss(() => emit("close"));

interface SheetCell {
  code: string;
  zone: string | null;
  qr: string;
}

const CELLS_PER_PAGE = 12; // 3 columns x 4 rows
const pages = ref<SheetCell[][]>([]);

onMounted(async () => {
  const cells = await Promise.all(
    props.items.map(async (item) => ({
      code: item.code,
      zone: item.zone?.trim() || null,
      qr: await QRCode.toDataURL(item.code, {
        width: 512,
        margin: 1,
        errorCorrectionLevel: "M",
      }),
    }))
  );
  const chunked: SheetCell[][] = [];
  for (let i = 0; i < cells.length; i += CELLS_PER_PAGE) {
    chunked.push(cells.slice(i, i + CELLS_PER_PAGE));
  }
  pages.value = chunked;
  document.body.classList.add("shelf-batch-printing");
});

onBeforeUnmount(() => document.body.classList.remove("shelf-batch-printing"));

function printSheet() {
  window.print();
}
</script>

<template>
  <Teleport to="body">
    <div class="shelf-batch-print-root">
      <div class="shelf-batch-overlay" @mousedown="dlg.onMousedown" @click="dlg.onClick">
        <div class="shelf-batch-chrome">
          <h2>{{ $t("admin.print.batchTitle", { count: items.length }) }}</h2>
          <div class="shelf-batch-actions">
            <button class="btn" @click="emit('close')">{{ $t("admin.common.close") }}</button>
            <button class="btn btn-primary" :disabled="!pages.length" @click="printSheet">
              {{ $t("admin.print.print") }}
            </button>
          </div>
        </div>
        <div class="shelf-sheet-preview">
          <div v-for="(page, pi) in pages" :key="pi" class="shelf-sheet-page">
            <div v-for="cell in page" :key="cell.code" class="shelf-sheet-cell">
              <img :src="cell.qr" :alt="cell.code" />
              <div class="shelf-sheet-code">{{ cell.code }}</div>
              <div v-if="cell.zone" class="shelf-sheet-zone">{{ cell.zone }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.shelf-batch-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px;
  background: rgba(0, 0, 0, 0.45);
}
.shelf-batch-chrome {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: min(760px, 100%);
  padding: 12px 16px;
  background: #fff;
  border-radius: 8px;
}
.shelf-batch-chrome h2 {
  margin: 0;
  font-size: 16px;
}
.shelf-batch-actions {
  display: flex;
  gap: 8px;
}
.shelf-sheet-preview {
  overflow: auto;
  max-height: calc(100vh - 130px);
  padding: 16px;
  background: #e5e7eb;
  border-radius: 8px;
}
.shelf-sheet-page {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(4, 1fr);
  gap: 4mm;
  width: 190mm; /* A4 minus 2 x 10mm page margin */
  height: 277mm;
  padding: 2mm;
  background: #fff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}
.shelf-sheet-page + .shelf-sheet-page {
  margin-top: 16px;
}
.shelf-sheet-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2mm;
  padding: 4mm;
  overflow: hidden;
}
.shelf-sheet-cell img {
  width: 44mm;
  height: 44mm;
}
.shelf-sheet-code {
  font-size: 20pt;
  font-weight: 700;
  text-align: center;
  word-break: break-all;
}
.shelf-sheet-zone {
  font-size: 12pt;
  color: #4b5563;
  text-align: center;
  word-break: break-all;
}
</style>

<style>
/* Print: hide the whole app (everything teleported under body except the
   sheet root) and the dialog chrome, then flow the sheet pages normally so
   multi-page selections paginate onto real A4 pages. */
@page {
  size: A4;
  margin: 10mm;
}
@media print {
  body.shelf-batch-printing > *:not(.shelf-batch-print-root) {
    display: none !important;
  }
  body.shelf-batch-printing .shelf-batch-overlay {
    position: static;
    display: block;
    padding: 0;
    background: none;
  }
  body.shelf-batch-printing .shelf-batch-chrome {
    display: none !important;
  }
  body.shelf-batch-printing .shelf-sheet-preview {
    overflow: visible;
    max-height: none;
    padding: 0;
    background: none;
  }
  body.shelf-batch-printing .shelf-sheet-page {
    box-shadow: none;
    break-after: page;
    page-break-after: always;
  }
  body.shelf-batch-printing .shelf-sheet-page + .shelf-sheet-page {
    margin-top: 0;
  }
  body.shelf-batch-printing .shelf-sheet-page:last-child {
    break-after: auto;
    page-break-after: auto;
  }
}
</style>
