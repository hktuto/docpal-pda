<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import QRCode from "qrcode";
import type { BoxSearchResult } from "~/services/types";

const warehouse = useWarehouse();

const search = ref("");
const boxes = ref<BoxSearchResult[]>([]);
const qrSvgs = ref<Record<string, string>>({});
const loading = ref(false);
const error = ref("");

async function generateQrSvgs(list: BoxSearchResult[]) {
  const result: Record<string, string> = {};
  await Promise.all(
    list.map(async (box) => {
      try {
        result[box.id] = await QRCode.toString(box.id, {
          type: "svg",
          width: 200,
          margin: 1,
          errorCorrectionLevel: "M",
        });
      } catch {
        result[box.id] = "";
      }
    })
  );
  qrSvgs.value = result;
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    boxes.value = await warehouse.searchBoxes(search.value);
    await generateQrSvgs(boxes.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    boxes.value = [];
  } finally {
    loading.value = false;
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(load, 300);
});

onMounted(load);
onUnmounted(() => {
  if (debounce) clearTimeout(debounce);
});

function print() {
  window.print();
}
</script>

<template>
  <div class="box-page">
    <header class="no-print">
      <h1>Warehouse PDA — Box QR Codes</h1>
      <p class="subtitle">
        Shipping (<code>BOX-S-…</code>) and shelf (<code>BOX-H-…</code>) boxes.
        Search by seq (e.g. <code>0001</code>) or any part of the box id.
      </p>
      <div class="toolbar">
        <input
          v-model="search"
          type="search"
          placeholder="Search box id or seq..."
          class="search-input"
        />
        <button class="print-btn" @click="print">Print</button>
      </div>
    </header>

    <p v-if="error" class="status no-print">{{ error }}</p>
    <p v-else-if="!loading && boxes.length === 0" class="status no-print">
      No boxes found.
    </p>

    <main class="box-grid">
      <div v-for="box in boxes" :key="box.id" class="box-card">
        <div class="box-card__kind" :class="`box-card__kind--${box.kind}`">
          {{ box.kind === "shipping" ? "Shipping" : "Shelf" }}
        </div>
        <div v-if="qrSvgs[box.id]" class="qr-code" v-html="qrSvgs[box.id]"></div>
        <div class="box-card__id">{{ box.id }}</div>
        <div class="box-card__meta">
          <span>{{ box.status }}</span>
          <span v-if="box.orderNo">{{ box.orderNo }}</span>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.box-page {
  margin: 0;
  padding: 1rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  background-color: #f3f4f6;
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

.status {
  color: #555555;
  font-size: 0.9rem;
}

.box-grid {
  max-width: 1200px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 1.5rem;
}

.box-card {
  background: #ffffff;
  border: 3px solid #000000;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  position: relative;
  box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.15);
}

.box-card__kind {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  font-size: 0.7rem;
  padding: 0.2rem 0.45rem;
  border: 1px solid #e5e7eb;
  background: #f3f4f6;
  color: #555555;
}

.box-card__kind--shipping {
  background: #dbeafe;
  border-color: #bfdbfe;
  color: #1d4ed8;
}

.qr-code {
  width: 160px;
  height: 160px;
}

.qr-code :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}

.box-card__id {
  font-size: 0.95rem;
  font-weight: bold;
  word-break: break-all;
  text-align: center;
}

.box-card__meta {
  display: flex;
  gap: 0.75rem;
  font-size: 0.75rem;
  color: #555555;
}

@media print {
  .box-page { background: #fff; padding: 0; }
  .no-print { display: none; }
  .box-grid { max-width: none; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
  .box-card { box-shadow: none; page-break-inside: avoid; }
}
</style>
