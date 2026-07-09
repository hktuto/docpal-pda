<script setup lang="ts">
import { ref, computed, nextTick, watch } from "vue";
import QRCode from "qrcode";
import JsBarcode from "jsbarcode";

interface LabelItem {
  invoiceNo: string;
  poNo: string;
  poLine: string;
  partNo: string;
  qty: number;
  boxId: string;
  dateCode: string;
  traceCode: string;
  unknown: string;
  fullName: string;
  qrValue: string;
}

interface LabelsData {
  receivingOrderNo: string;
  invoiceCount: number;
  itemCount: number;
  generatedAt: string;
  labels: LabelItem[];
}

const { data } = await useFetch<LabelsData>("/labels-data.json", {
  server: false,
  default: () => null,
});

const search = ref("");
const filteredLabels = computed(() => {
  if (!data.value) return [];
  if (!search.value.trim()) return data.value.labels;
  const term = search.value.trim().toLowerCase();
  return data.value.labels.filter(
    (l) =>
      l.partNo.toLowerCase().includes(term) ||
      l.poNo.toLowerCase().includes(term) ||
      l.invoiceNo.toLowerCase().includes(term) ||
      l.boxId.toLowerCase().includes(term)
  );
});

const qrSvgs = ref<Record<number, string>>({});

async function generateQrSvgs(labels: LabelItem[]) {
  const result: Record<number, string> = {};
  await Promise.all(
    labels.map(async (label, index) => {
      try {
        const svg = await QRCode.toString(label.qrValue, {
          type: "svg",
          width: 200,
          margin: 1,
          errorCorrectionLevel: "M",
        });
        result[index] = svg;
      } catch {
        result[index] = "";
      }
    })
  );
  qrSvgs.value = result;
}

function renderBarcodes() {
  nextTick(() => {
    document.querySelectorAll<SVGElement>("[data-barcode]").forEach((el) => {
      const value = el.getAttribute("data-barcode") ?? "";
      if (!value) return;
      try {
        JsBarcode(el, value, {
          format: "CODE128",
          width: 1.5,
          height: 28,
          displayValue: false,
          margin: 0,
          background: "transparent",
        });
      } catch {
        el.textContent = "";
      }
    });
  });
}

watch(
  filteredLabels,
  async (labels) => {
    await generateQrSvgs(labels);
    renderBarcodes();
  },
  { immediate: true }
);
</script>

<template>
  <div class="labels-page">
    <header class="no-print">
      <h1>Warehouse PDA — Receiving Labels</h1>
      <p class="subtitle">
        Receiving order <strong>{{ data?.receivingOrderNo ?? "—" }}</strong>
        · {{ data?.itemCount ?? 0 }} items across {{ data?.invoiceCount ?? 0 }} invoices
      </p>
      <div class="toolbar">
        <input
          v-model="search"
          type="search"
          placeholder="Search part, PO, invoice or box..."
          class="search-input"
        />
        <button class="print-btn" @click="() => window.print()">Print labels</button>
      </div>
    </header>

    <main class="labels-grid">
      <div
        v-for="(label, index) in filteredLabels"
        :key="index"
        class="label label--koa"
      >
        <div class="label__use">{{ label.invoiceNo }}</div>
        <div class="label__koa-rohs">RoHS</div>
        <div class="label__koa-order">{{ label.invoiceNo }}</div>
        <div class="label__koa-po">PO: {{ label.poNo }} · Line {{ label.poLine }}</div>

        <div class="label__koa-field">
          <div class="label__koa-label">(P)CUSTOMER P/N:</div>
          <div class="label__koa-value">{{ label.fullName }}</div>
          <svg class="barcode" :data-barcode="label.fullName" aria-hidden="true"></svg>
        </div>

        <div class="label__koa-field">
          <div class="label__koa-label">(Q)QUANTITY:</div>
          <div class="label__koa-value label__qty">{{ label.qty }}</div>
          <svg class="barcode" :data-barcode="String(label.qty)" aria-hidden="true"></svg>
        </div>

        <div class="label__koa-row">
          <div class="label__koa-field">
            <div class="label__koa-label">(1T)TRACE CODE:</div>
            <div class="label__koa-value">{{ label.traceCode }}</div>
            <svg class="barcode" :data-barcode="label.traceCode" aria-hidden="true"></svg>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(D)DATE CODE:</div>
            <div class="label__koa-value">{{ label.dateCode }}</div>
            <svg class="barcode" :data-barcode="label.dateCode" aria-hidden="true"></svg>
          </div>
        </div>

        <div class="label__koa-field">
          <div class="label__koa-label">(1P)MPN:</div>
          <div class="label__koa-value">{{ label.partNo }}</div>
          <svg class="barcode" :data-barcode="label.partNo" aria-hidden="true"></svg>
        </div>

        <div class="label__koa-markings">
          <span>{{ label.partNo }} F</span>
          <span>{{ label.boxId }}</span>
        </div>

        <div class="label__koa-bottom">
          <div v-if="qrSvgs[index]" class="qr-code" v-html="qrSvgs[index]"></div>
          <div class="label__koa-enc">{{ label.qrValue }}</div>
        </div>

        <div class="label__koa-footer">KOA MADE IN CN</div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.labels-page {
  margin: 0;
  padding: 1rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  background-color: #c7a87e;
  background-image:
    repeating-linear-gradient(45deg, transparent, transparent 12px, rgba(0, 0, 0, 0.04) 12px, rgba(0, 0, 0, 0.04) 24px),
    repeating-linear-gradient(-45deg, transparent, transparent 12px, rgba(255, 255, 255, 0.06) 12px, rgba(255, 255, 255, 0.06) 24px);
  color: #111111;
  min-height: 100vh;
}

.no-print {
  max-width: 1200px;
  margin: 0 auto 1.5rem;
}

h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
.subtitle { margin: 0 0 1rem; color: #555555; font-size: 0.875rem; }

.toolbar {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  align-items: center;
}

.search-input {
  flex: 1;
  min-width: 240px;
  padding: 0.5rem 0.75rem;
  border: 1px solid #000;
  font-family: inherit;
  font-size: 0.9rem;
}

.print-btn {
  padding: 0.5rem 1rem;
  background: #111;
  color: #fff;
  border: 1px solid #000;
  font-family: inherit;
  font-size: 0.9rem;
  cursor: pointer;
}

.labels-grid {
  max-width: 1200px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 1.5rem;
}

.label {
  background: #ffffff;
  border: 3px solid #000000;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-height: 260px;
  box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.15);
  position: relative;
  overflow: hidden;
}

.label__use {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  font-size: 0.7rem;
  color: #555555;
  background: #f3f4f6;
  padding: 0.2rem 0.45rem;
  border: 1px solid #e5e7eb;
  z-index: 1;
}

.label__qty {
  font-size: 2.2rem;
  font-weight: bold;
  line-height: 1;
  color: #2563eb;
}

.barcode {
  height: 28px;
  width: 100%;
  display: block;
}

.qr-code {
  width: 80px;
  height: 80px;
  flex-shrink: 0;
}

.qr-code :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}

.label--koa { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
.label--koa .label__koa-rohs { position: absolute; top: 0.75rem; right: 0.75rem; font-size: 1.2rem; font-weight: bold; font-family: Arial, Helvetica, sans-serif; }
.label--koa .label__koa-order { font-size: 1rem; font-weight: bold; }
.label--koa .label__koa-po { font-size: 0.75rem; color: #555555; margin-bottom: 0.25rem; }
.label--koa .label__koa-field { display: flex; flex-direction: column; gap: 0.1rem; }
.label--koa .label__koa-row { display: grid; grid-template-columns: 1.2fr 1fr; gap: 1rem; }
.label--koa .label__koa-label { font-size: 0.85rem; font-weight: bold; letter-spacing: 0.02em; }
.label--koa .label__koa-value { font-size: 1.35rem; font-weight: bold; }
.label--koa .label__qty { font-size: 2rem; color: #2563eb; }
.label--koa .label__koa-markings { display: flex; justify-content: space-between; font-size: 0.95rem; font-weight: bold; border-top: 1px solid #ddd; border-bottom: 1px solid #ddd; padding: 0.35rem 0; margin: 0.2rem 0; }
.label--koa .label__koa-bottom { display: flex; align-items: center; gap: 1rem; margin-top: 0.25rem; }
.label--koa .label__koa-enc { font-size: 0.65rem; color: #555555; word-break: break-all; flex: 1; line-height: 1.3; }
.label--koa .label__koa-footer { text-align: right; font-weight: bold; font-size: 0.8rem; margin-top: auto; }

@media print {
  .labels-page { background: #fff; padding: 0; }
  .no-print { display: none; }
  .labels-grid { max-width: none; grid-template-columns: 1fr; gap: 0; }
  .label { border: none; box-shadow: none; page-break-inside: avoid; min-height: auto; }
}
</style>
