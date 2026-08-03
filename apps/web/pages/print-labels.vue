<script setup lang="ts">
// Printable scannable labels for the demo warehouse: shelf box ids, shelf
// codes, receiving cartons, and part labels (raw value built server-side per
// the supplier QR template — see GET /labels-data). Print via the browser's
// print dialog; each label is a scannable QR / Code128 card.
import { ref, computed, onMounted } from "vue";
import type { LabelsData, LabelPartRow } from "~/services/types";

const warehouse = useWarehouse();

const data = ref<LabelsData | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    data.value = await warehouse.getLabelsData();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function print() {
  window.print();
}

// --- filters ---------------------------------------------------------------

const search = ref("");
const selectedPickingOrder = ref("");
const sections = ref({
  shelfBoxes: true,
  shelfCodes: true,
  cartons: true,
  pickLabels: true,
  receivingParts: true,
  shelfParts: true,
});

const pickingOrderOptions = computed(() => {
  if (!data.value) return [];
  const refs = new Set<string>();
  for (const o of data.value.receivingOrders)
    for (const inv of o.invoices)
      for (const it of inv.items) it.pickingOrderRefs.forEach((r) => refs.add(r));
  for (const l of data.value.shelfLots) l.pickingOrderRefs.forEach((r) => refs.add(r));
  return [...refs].sort();
});

const term = computed(() => search.value.trim().toLowerCase());
function matches(...values: (string | null | undefined)[]): boolean {
  if (!term.value) return true;
  return values.some((v) => v?.toLowerCase().includes(term.value));
}
function matchesRefs(refs: string[]): boolean {
  return !selectedPickingOrder.value || refs.includes(selectedPickingOrder.value);
}

// --- sections ---------------------------------------------------------------

const shelfBoxes = computed(() =>
  (data.value?.shelfBoxes ?? []).filter((b) =>
    matches(b.id, b.shelfCode, ...b.items.map((i) => i.partNo))
  )
);

const shelfCodes = computed(() =>
  (data.value?.shelfCodes ?? []).filter((s) => matches(s))
);

interface CartonRow {
  ctnNo: string;
  batchNo: string;
  invoiceNo: string;
  items: LabelPartRow[];
}
const cartons = computed<CartonRow[]>(() => {
  const out: CartonRow[] = [];
  for (const o of data.value?.receivingOrders ?? []) {
    for (const inv of o.invoices) {
      const byCtn = new Map<string, LabelPartRow[]>();
      for (const it of inv.items) {
        if (!it.ctnNo) continue;
        byCtn.set(it.ctnNo, [...(byCtn.get(it.ctnNo) ?? []), it]);
      }
      for (const [ctnNo, items] of byCtn) {
        if (selectedPickingOrder.value && !items.some((i) => matchesRefs(i.pickingOrderRefs)))
          continue;
        if (!matches(ctnNo, o.batchNo, inv.invoiceNo, ...items.map((i) => i.partNo))) continue;
        out.push({ ctnNo, batchNo: o.batchNo, invoiceNo: inv.invoiceNo, items });
      }
    }
  }
  return out;
});

interface ReceivingPartRow extends LabelPartRow {
  id: string;
  ctnNo: string | null;
  poNo: string | null;
  batchNo: string;
  invoiceNo: string;
}
const receivingParts = computed<ReceivingPartRow[]>(() => {
  const out: ReceivingPartRow[] = [];
  for (const o of data.value?.receivingOrders ?? []) {
    for (const inv of o.invoices) {
      for (const it of inv.items) {
        if (!matchesRefs(it.pickingOrderRefs)) continue;
        if (!matches(it.partNo, it.ctnNo, o.batchNo, inv.invoiceNo, it.poNo)) continue;
        out.push({ ...it, batchNo: o.batchNo, invoiceNo: inv.invoiceNo });
      }
    }
  }
  return out;
});

const shelfParts = computed(() =>
  (data.value?.shelfLots ?? []).filter(
    (l) => matchesRefs(l.pickingOrderRefs) && matches(l.partNo, l.boxId, l.shelfCode, l.lotCode)
  )
);

const pickLabels = computed(() =>
  (data.value?.pickLabels ?? []).filter(
    (l) =>
      (!selectedPickingOrder.value || l.orderNo === selectedPickingOrder.value) &&
      matches(l.partNo, l.orderNo, l.source, l.lotCode)
  )
);
</script>

<template>
  <div class="print-labels">
    <header class="no-print toolbar">
      <h1>Print labels</h1>
      <p class="subtitle" v-if="data">
        Live data · generated {{ new Date(data.generatedAt).toLocaleString() }}
      </p>
      <div class="controls">
        <input
          v-model="search"
          type="search"
          placeholder="Search part, box, shelf, carton, order..."
          class="search-input"
        />
        <select v-model="selectedPickingOrder" class="order-select">
          <option value="">All picking orders</option>
          <option v-for="refNo of pickingOrderOptions" :key="refNo" :value="refNo">
            {{ refNo }}
          </option>
        </select>
        <button class="btn" @click="load">Reload</button>
        <button class="btn btn--primary" @click="print">Print</button>
      </div>
      <div class="section-toggles">
        <label><input type="checkbox" v-model="sections.shelfBoxes" /> Shelf boxes</label>
        <label><input type="checkbox" v-model="sections.shelfCodes" /> Shelf codes</label>
        <label><input type="checkbox" v-model="sections.cartons" /> Cartons</label>
        <label><input type="checkbox" v-model="sections.pickLabels" /> Pick labels (per order)</label>
        <label><input type="checkbox" v-model="sections.receivingParts" /> Part labels (receiving)</label>
        <label><input type="checkbox" v-model="sections.shelfParts" /> Part labels (shelf stock)</label>
      </div>
      <p v-if="loadError" class="error">Failed to load labels: {{ loadError }}</p>
      <p v-else-if="loading">Loading…</p>
    </header>

    <main v-if="data">
      <!-- Shelf boxes -->
      <section v-if="sections.shelfBoxes && shelfBoxes.length">
        <h2>Shelf boxes</h2>
        <div class="grid">
          <div v-for="box of shelfBoxes" :key="box.id" class="label label--code">
            <div class="label__type">Shelf box{{ box.items.length ? "" : " · empty" }}</div>
            <LabelsScanCode :value="box.id" kind="qr" class="label__qr" />
            <LabelsScanCode :value="box.id" kind="code128" :height="26" />
            <div class="label__code">{{ box.id }}</div>
            <div class="label__meta">
              Shelf {{ box.shelfCode ?? "—" }} · {{ box.status }}
              <template v-if="box.items.length">
                <br />{{ box.items.map((i) => `${i.partNo}×${i.qty}`).join(", ") }}
              </template>
            </div>
          </div>
        </div>
      </section>

      <!-- Shelf codes -->
      <section v-if="sections.shelfCodes && shelfCodes.length">
        <h2>Shelf codes</h2>
        <div class="grid">
          <div v-for="code of shelfCodes" :key="code" class="label label--code">
            <div class="label__type">Shelf</div>
            <LabelsScanCode :value="code" kind="qr" class="label__qr" />
            <LabelsScanCode :value="code" kind="code128" :height="26" />
            <div class="label__code">{{ code }}</div>
          </div>
        </div>
      </section>

      <!-- Receiving cartons -->
      <section v-if="sections.cartons && cartons.length">
        <h2>Receiving cartons</h2>
        <div class="grid">
          <div v-for="c of cartons" :key="`${c.invoiceNo}-${c.ctnNo}`" class="label label--code">
            <div class="label__type">Carton · RO {{ c.batchNo }}</div>
            <LabelsScanCode :value="c.ctnNo" kind="qr" class="label__qr" />
            <LabelsScanCode :value="c.ctnNo" kind="code128" :height="26" />
            <div class="label__code">{{ c.ctnNo }}</div>
            <div class="label__meta">
              {{ c.invoiceNo }}<br />{{ c.items.map((i) => `${i.partNo}×${i.qty}`).join(", ") }}
            </div>
          </div>
        </div>
      </section>

      <!-- Pick labels: one per order allocation (exact qty per share) -->
      <section v-if="sections.pickLabels && pickLabels.length">
        <h2>Pick labels — per order allocation</h2>
        <div class="grid grid--parts">
          <div v-for="(p, i) of pickLabels" :key="`pick-${i}`" class="label label--part">
            <div class="label__type">{{ p.orderNo }}</div>
            <div class="label__partno">{{ p.partNo }}</div>
            <div class="label__part-body">
              <LabelsScanCode v-if="p.qrValue" :value="p.qrValue" kind="qr" class="label__qr" />
              <div class="label__fields">
                <div class="label__qty">{{ p.qty }}</div>
                <div>LOT: {{ p.lotCode ?? "—" }}</div>
                <div>DC: {{ p.dateCode ?? "—" }}</div>
                <div>FROM: {{ p.source }}</div>
              </div>
            </div>
            <div v-if="p.qrValue" class="label__raw">{{ p.qrValue }}</div>
          </div>
        </div>
      </section>

      <!-- Part labels: receiving -->
      <section v-if="sections.receivingParts && receivingParts.length">
        <h2>Part labels — receiving</h2>
        <div class="grid grid--parts">
          <div v-for="p of receivingParts" :key="p.id" class="label label--part">
            <div class="label__type">
              {{ p.pickingOrderRefs.length ? p.pickingOrderRefs.join(", ") : `RO ${p.batchNo}` }}
            </div>
            <div class="label__partno">{{ p.partNo }}</div>
            <div class="label__part-body">
              <LabelsScanCode v-if="p.qrValue" :value="p.qrValue" kind="qr" class="label__qr" />
              <div class="label__fields">
                <div class="label__qty">{{ p.qty }}</div>
                <div>LOT: {{ p.lotCode ?? "—" }}</div>
                <div>DC: {{ p.dateCode ?? "—" }}</div>
                <div>CTN: {{ p.ctnNo ?? "—" }}</div>
                <div>PO: {{ p.poNo ?? "—" }}</div>
                <div>RO: {{ p.batchNo }} · {{ p.invoiceNo }}</div>
              </div>
            </div>
            <div v-if="p.qrValue" class="label__raw">{{ p.qrValue }}</div>
          </div>
        </div>
      </section>

      <!-- Part labels: shelf stock -->
      <section v-if="sections.shelfParts && shelfParts.length">
        <h2>Part labels — shelf stock</h2>
        <div class="grid grid--parts">
          <div v-for="p of shelfParts" :key="`${p.boxId}-${p.partNo}`" class="label label--part">
            <div class="label__type">
              {{ p.pickingOrderRefs.length ? p.pickingOrderRefs.join(", ") : "Shelf stock" }}
            </div>
            <div class="label__partno">{{ p.partNo }}</div>
            <div class="label__part-body">
              <LabelsScanCode v-if="p.qrValue" :value="p.qrValue" kind="qr" class="label__qr" />
              <div class="label__fields">
                <div class="label__qty">{{ p.qty }}</div>
                <div>LOT: {{ p.lotCode ?? "—" }}</div>
                <div>DC: {{ p.dateCode ?? "—" }}</div>
                <div>BOX: {{ p.boxId }}</div>
                <div>SHELF: {{ p.shelfCode ?? "—" }}</div>
              </div>
            </div>
            <div v-if="p.qrValue" class="label__raw">{{ p.qrValue }}</div>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.print-labels {
  padding: 1rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  color: #111;
}

.toolbar h1 { font-size: 1.3rem; margin: 0 0 0.25rem; }
.subtitle { margin: 0 0 0.75rem; color: #555; font-size: 0.85rem; }
.controls { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center; margin-bottom: 0.5rem; }
.search-input {
  flex: 1;
  min-width: 220px;
  padding: 0.5rem 0.75rem;
  border: 1px solid #000;
  font: inherit;
}
.order-select { padding: 0.5rem; border: 1px solid #000; font: inherit; background: #fff; }
.btn {
  padding: 0.5rem 1rem;
  border: 1px solid #000;
  background: #fff;
  color: #111;
  font: inherit;
  cursor: pointer;
}
.btn--primary { background: #111; color: #fff; }
.section-toggles { display: flex; gap: 1rem; flex-wrap: wrap; font-size: 0.85rem; margin-bottom: 0.5rem; }
.section-toggles label { display: flex; gap: 0.3rem; align-items: center; cursor: pointer; }
.error { color: #b91c1c; }

h2 {
  font-size: 1.05rem;
  margin: 1.5rem 0 0.75rem;
  border-bottom: 2px solid #111;
  padding-bottom: 0.25rem;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
}
.grid--parts { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }

.label {
  background: #fff;
  border: 2px solid #000;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  position: relative;
  break-inside: avoid;
}
.label__type {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #555;
}
.label__qr { width: 120px; margin: 0 auto; }
.label--code .label__code {
  font-size: 1rem;
  font-weight: bold;
  text-align: center;
  word-break: break-all;
}
.label__meta { font-size: 0.7rem; color: #444; text-align: center; line-height: 1.4; }

.label__partno { font-size: 1.05rem; font-weight: bold; }
.label__part-body { display: flex; gap: 0.75rem; align-items: flex-start; }
.label--part .label__qr { width: 110px; margin: 0; flex-shrink: 0; }
.label__fields { font-size: 0.75rem; line-height: 1.5; }
.label__qty { font-size: 1.6rem; font-weight: bold; color: #2563eb; line-height: 1.1; }
.label__raw { font-size: 0.6rem; color: #666; word-break: break-all; line-height: 1.3; }

@media print {
  .no-print { display: none; }
  .print-labels { padding: 0; }
  .grid { grid-template-columns: repeat(3, 1fr); gap: 6mm; }
  .grid--parts { grid-template-columns: repeat(2, 1fr); }
  h2 { page-break-after: avoid; }
}
</style>

<!-- Unscoped: hide the app shell header when printing labels. -->
<style>
@media print {
  .app-header { display: none; }
}
@page { size: A4 portrait; margin: 10mm; }
</style>
