<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted } from "vue";
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
  pickingOrderRefs: string[];
}

interface LabelsData {
  receivingOrderNo: string;
  invoiceCount: number;
  itemCount: number;
  generatedAt: string;
  labels: LabelItem[];
}

interface Carton {
  index: number;
  total: number;
  invoiceNo: string;
  boxId: string;
  items: LabelItem[];
  totalQty: number;
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

// One carton label per (invoice, box id) group — mirrors the carton grouping
// of the original receiving xlsx (e.g. 65878 carton 00003 holds many items).
const cartons = computed<Carton[]>(() => {
  const groups = new Map<string, LabelItem[]>();
  for (const label of filteredLabels.value) {
    const key = `${label.invoiceNo}|${label.boxId}`;
    const group = groups.get(key);
    if (group) group.push(label);
    else groups.set(key, [label]);
  }
  const list = [...groups.values()].map((items) => ({
    invoiceNo: items[0].invoiceNo,
    boxId: items[0].boxId,
    items,
    totalQty: items.reduce((sum, l) => sum + l.qty, 0),
  }));
  list.sort(
    (a, b) =>
      a.invoiceNo.localeCompare(b.invoiceNo) || a.boxId.localeCompare(b.boxId)
  );
  return list.map((g, i) => ({ index: i + 1, total: list.length, ...g }));
});

const today = new Date().toISOString().slice(0, 10).replace(/-/g, "/");

function formatQty(qty: number) {
  return qty.toLocaleString("en-US");
}

function renderBarcodes() {
  nextTick(() => {
    document.querySelectorAll<SVGElement>("[data-barcode]").forEach((el) => {
      const value = el.getAttribute("data-barcode") ?? "";
      if (!value || el.childElementCount > 0) return;
      try {
        JsBarcode(el, value, {
          format: "CODE128",
          width: 1.6,
          height: 36,
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

onMounted(renderBarcodes);
watch(cartons, renderBarcodes, { flush: "post" });
</script>

<template>
  <div class="carton-page">
    <header class="no-print">
      <h1>Warehouse PDA — Carton Labels</h1>
      <p class="subtitle">
        {{ cartons.length }} cartons from receiving order
        <strong>{{ data?.receivingOrderNo ?? "—" }}</strong>
        — grouped by box id, one label per printed page
      </p>
      <div class="toolbar">
        <input
          v-model="search"
          type="search"
          placeholder="Search part, PO, invoice or box..."
          class="search-input"
        />
        <button class="print-btn" @click="() => window.print()">Print carton labels</button>
      </div>
    </header>

    <main class="cartons">
      <div v-for="carton of cartons" :key="`${carton.invoiceNo}|${carton.boxId}`" class="carton">
        <div class="carton__count">{{ carton.index }}/{{ carton.total }}</div>

        <div class="carton__top">
          <div class="carton__left">
            <div class="carton__supplier-code">WEL-D06</div>
            <div class="carton__shipper">
              <div>WELTRONICS</div>
              <div>MCE</div>
              <div>C/NO.{{ carton.boxId }}</div>
              <div>MADE IN JAPAN</div>
            </div>
          </div>
          <div class="carton__right">
            <div class="carton__field">
              <span class="carton__caption">Invoice No</span>
              <span class="carton__value carton__value--big">{{ carton.invoiceNo }}</span>
            </div>
            <div class="carton__meta">
              <span>{{ carton.items[0].unknown }}</span>
              <span>{{ today }}</span>
              <span>{{ carton.index }}/{{ carton.total }}</span>
            </div>
            <div class="carton__field">
              <span class="carton__caption">Carton No</span>
              <span class="carton__value carton__value--big">{{ carton.boxId }}</span>
            </div>
            <div class="carton__field">
              <span class="carton__caption">Customer Name</span>
              <span class="carton__value">WEL MCE</span>
            </div>
            <svg class="barcode" :data-barcode="carton.boxId" aria-hidden="true"></svg>
            <div class="carton__field carton__field--total">
              <span class="carton__caption">Total Q'ty</span>
              <span class="carton__value carton__value--huge">{{ formatQty(carton.totalQty) }}</span>
            </div>
          </div>
        </div>

        <table class="carton__items">
          <thead>
            <tr>
              <th>Customer PO</th>
              <th>MFG Item</th>
              <th>Customer Item</th>
              <th class="qty">Quantity</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(item, i) of carton.items" :key="i">
              <tr>
                <td>{{ item.poNo }}</td>
                <td>{{ item.partNo }}</td>
                <td></td>
                <td class="qty">{{ formatQty(item.qty) }}</td>
              </tr>
              <tr class="sub">
                <td>{{ item.poLine }}</td>
                <td>{{ item.fullName }}</td>
                <td>K0A/{{ item.partNo }}</td>
                <td class="qty"></td>
              </tr>
            </template>
          </tbody>
        </table>

        <svg class="barcode barcode--bottom" :data-barcode="carton.invoiceNo" aria-hidden="true"></svg>
      </div>
    </main>
  </div>
</template>

<style scoped>
.carton-page {
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
  max-width: 1000px;
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

.cartons {
  max-width: 1000px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.carton {
  background: #ffffff;
  border: 3px solid #000000;
  padding: 1.25rem 1.5rem;
  position: relative;
  box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.15);
}

.carton__count {
  position: absolute;
  top: 0.5rem;
  right: 0.75rem;
  font-size: 1.1rem;
  font-weight: bold;
}

.carton__top {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2rem;
  margin-bottom: 1.5rem;
}

.carton__supplier-code {
  font-size: 2.2rem;
  font-weight: bold;
  letter-spacing: 0.03em;
  margin-bottom: 1rem;
}

.carton__shipper {
  font-size: 1.15rem;
  line-height: 1.7;
  letter-spacing: 0.12em;
}

.carton__right {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.carton__field {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
}

.carton__field--total {
  margin-top: 0.25rem;
}

.carton__caption {
  font-size: 0.8rem;
  color: #444444;
  min-width: 6.5rem;
}

.carton__value {
  font-size: 1.1rem;
  font-weight: bold;
}

.carton__value--big { font-size: 1.5rem; }
.carton__value--huge { font-size: 2rem; }

.carton__meta {
  display: flex;
  gap: 1.5rem;
  font-size: 1.05rem;
  font-weight: bold;
}

.barcode {
  height: 36px;
  width: 70%;
  display: block;
}

.barcode--bottom {
  margin-top: 1rem;
  width: 40%;
}

.carton__items {
  width: 100%;
  border-collapse: collapse;
  font-size: 1.05rem;
}

.carton__items th {
  text-align: left;
  font-size: 0.8rem;
  font-weight: normal;
  color: #444444;
  padding: 0.25rem 0.5rem;
}

.carton__items td {
  border-top: 1px solid #111;
  padding: 0.4rem 0.5rem;
  font-weight: bold;
  height: 1.6rem;
}

.carton__items tr.sub td {
  border-top: none;
  padding-top: 0;
}

.carton__items .qty { text-align: right; }

@media (max-width: 720px) {
  .carton__top {
    grid-template-columns: 1fr;
    gap: 1rem;
  }
  .carton__supplier-code { font-size: 1.6rem; margin-bottom: 0.5rem; }
  .carton__shipper { font-size: 1rem; line-height: 1.5; }
  .carton__value--huge { font-size: 1.5rem; }
  .carton__items { font-size: 0.85rem; }
}

@media print {
  .carton-page { background: #fff; padding: 0; }
  .no-print { display: none; }
  .cartons { max-width: none; gap: 0; }
  .carton {
    border: none;
    box-shadow: none;
    page-break-after: always;
    min-height: 95vh;
  }
  .carton:last-child { page-break-after: auto; }
}
</style>

<!-- Unscoped: hide the app shell header when printing carton labels. -->
<style>
@media print {
  .app-header { display: none; }
}
</style>
