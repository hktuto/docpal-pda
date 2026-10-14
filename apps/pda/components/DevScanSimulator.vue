<template>
  <div class="dev-scan-sim">
    <button type="button" class="dev-scan-sim__toggle" @click="open = !open">
      DEV SCAN
    </button>
    <div v-if="open" class="dev-scan-sim__panel">
      <div class="dev-scan-sim__tabs">
        <button
          type="button"
          class="dev-scan-sim__tab"
          :class="{ 'dev-scan-sim__tab--active': tab === 'scan' }"
          @click="tab = 'scan'"
        >
          Scan
        </button>
        <button
          type="button"
          class="dev-scan-sim__tab"
          :class="{ 'dev-scan-sim__tab--active': tab === 'generate' }"
          @click="tab = 'generate'"
        >
          Generate QR
        </button>
      </div>

      <!-- Scan tab -->
      <template v-if="tab === 'scan'">
        <label class="dev-scan-sim__label" for="dev-sim-qr">QR / barcode scan</label>
        <div class="dev-scan-sim__row">
          <input
            id="dev-sim-qr"
            v-model="qrValue"
            type="text"
            placeholder="Scanned value"
            @keydown.enter="simulateQr"
          />
          <button type="button" class="btn" @click="simulateQr">Send</button>
        </div>

        <label class="dev-scan-sim__label" for="dev-sim-ocr">
          OCR label — raw value or {"text","barcodes"} JSON
        </label>
        <textarea
          id="dev-sim-ocr"
          v-model="ocrValue"
          rows="3"
          placeholder='{"text":"...","barcodes":[{"value":"...","format":"4"}]}'
        ></textarea>
        <button type="button" class="btn" @click="simulateOcr">Simulate OCR scan</button>
      </template>

      <!-- Generate QR tab -->
      <template v-if="tab === 'generate'">
        <label class="dev-scan-sim__label" for="dev-gen-brand">Brand</label>
        <select id="dev-gen-brand" v-model="genBrand" class="dev-scan-sim__select">
          <option value="" disabled>Select brand…</option>
          <option v-for="b in brands" :key="b" :value="b">{{ b }}</option>
        </select>

        <label class="dev-scan-sim__label" for="dev-gen-part">Part No</label>
        <input
          id="dev-gen-part"
          v-model="genPartNo"
          type="text"
          placeholder="e.g. SR732ERTTDR200F"
        />

        <label class="dev-scan-sim__label" for="dev-gen-wcl">WCL Item No</label>
        <input
          id="dev-gen-wcl"
          v-model="genWclItemNo"
          type="text"
          placeholder="e.g. KOA/SR732ERTTDR200F"
        />

        <label class="dev-scan-sim__label" for="dev-gen-qty">Qty</label>
        <input
          id="dev-gen-qty"
          v-model.number="genQty"
          type="number"
          min="1"
          placeholder="e.g. 200"
        />

        <label class="dev-scan-sim__label" for="dev-gen-date">Date Code</label>
        <input
          id="dev-gen-date"
          v-model="genDateCode"
          type="text"
          placeholder="e.g. 202607 or 2626"
        />

        <label class="dev-scan-sim__label" for="dev-gen-lot">Lot Code</label>
        <input
          id="dev-gen-lot"
          v-model="genLotCode"
          type="text"
          placeholder="e.g. 1625H713"
        />

        <label class="dev-scan-sim__label" for="dev-gen-coo">COO</label>
        <input
          id="dev-gen-coo"
          v-model="genCoo"
          type="text"
          placeholder="e.g. DE"
        />

        <label class="dev-scan-sim__label" for="dev-gen-cow">COW</label>
        <input
          id="dev-gen-cow"
          v-model="genCow"
          type="text"
          placeholder="e.g. DE"
        />

        <button type="button" class="btn btn--primary" @click="generateQr">
          Generate QR
        </button>

        <div v-if="genQrValue" class="dev-scan-sim__result">
          <label class="dev-scan-sim__label">Generated QR value:</label>
          <div class="dev-scan-sim__qr-text">{{ genQrValue }}</div>
          <canvas ref="qrCanvas" class="dev-scan-sim__qr-canvas"></canvas>
          <div class="dev-scan-sim__row">
            <button type="button" class="btn btn--small" @click="copyQr">Copy</button>
            <button type="button" class="btn btn--small" @click="sendAsScan">Send as scan</button>
          </div>
        </div>
      </template>

      <p v-if="status" class="dev-scan-sim__status">{{ status }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { simulateScan } from "~/composables/useHardwareScanner";
import { captureRawLabelValue, parseBrowserScanPrompt } from "~/composables/useLabelScan";
import { getBrandQrFormat, type LabelQrInput } from "~/utils/generateLabelQr";

const open = ref(false);
const tab = ref<"scan" | "generate">("scan");
const qrValue = ref("");
const ocrValue = ref("");
const status = ref("");

// Generate QR state
const brands = ref<string[]>([]);
const genBrand = ref("");
const genPartNo = ref("");
const genWclItemNo = ref("");
const genQty = ref<number | null>(null);
const genDateCode = ref("");
const genLotCode = ref("");
const genCoo = ref("");
const genCow = ref("");
const genQrValue = ref("");
const qrCanvas = ref<HTMLCanvasElement | null>(null);

async function loadBrands() {
  try {
    const { useWarehouse } = await import("~/composables/useWarehouse");
    const warehouse = useWarehouse();
    brands.value = await warehouse.getAdHocPutAwayBrands();
  } catch {
    // Backend may not be reachable; leave brands empty
  }
}

async function simulateQr() {
  const value = qrValue.value.trim();
  if (!value) return;
  status.value = (await simulateScan(value))
    ? `Sent: ${value}`
    : "No active scanner on this page";
}

async function simulateOcr() {
  const capture = parseBrowserScanPrompt(ocrValue.value);
  if (!capture) {
    status.value = "Invalid OCR input";
    return;
  }
  const value = captureRawLabelValue(capture);
  status.value = (await simulateScan(value))
    ? `Sent: ${value}`
    : "No active scanner on this page";
}

async function generateQr() {
  const brand = genBrand.value;
  if (!brand) {
    status.value = "Select a brand first";
    return;
  }
  const format = getBrandQrFormat(brand);
  if (!format) {
    status.value = `No QR template for brand "${brand}"`;
    return;
  }
  const input: LabelQrInput = {
    brand: brand,
    partNo: genPartNo.value.trim(),
    wclItemNo: genWclItemNo.value.trim() || undefined,
    qty: genQty.value ?? undefined,
    dateCode: genDateCode.value.trim() || undefined,
    lotCode: genLotCode.value.trim() || undefined,
    coo: genCoo.value.trim() || undefined,
    cow: genCow.value.trim() || undefined,
  };
  const value = format.generate(input);
  if (!value) {
    status.value = "Failed to generate QR value";
    return;
  }
  genQrValue.value = value;
  status.value = "";
  await renderQrCode(value);
}

async function renderQrCode(value: string) {
  try {
    const QRCode = await import("qrcode");
    await nextTick();
    if (qrCanvas.value) {
      await QRCode.toCanvas(qrCanvas.value, value, { width: 200, margin: 2 });
    }
  } catch {
    // QR rendering is best-effort; the text value is the primary output
  }
}

async function copyQr() {
  if (!genQrValue.value) return;
  try {
    await navigator.clipboard.writeText(genQrValue.value);
    status.value = "Copied to clipboard";
  } catch {
    status.value = "Copy failed";
  }
}

async function sendAsScan() {
  const value = genQrValue.value.trim();
  if (!value) return;
  status.value = (await simulateScan(value))
    ? `Sent: ${value}`
    : "No active scanner on this page";
}

// Load brands when the panel is first opened
watch(open, (isOpen) => {
  if (isOpen && brands.value.length === 0) {
    loadBrands();
  }
});
</script>

<style scoped>
.dev-scan-sim {
  position: fixed;
  bottom: 1.25rem;
  left: 1.25rem;
  z-index: 70;
  font-size: 0.8125rem;
}

.dev-scan-sim__toggle {
  border: 1px dashed var(--primary);
  border-radius: 9999px;
  background: var(--surface);
  color: var(--primary);
  padding: 0.375rem 0.75rem;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
  box-shadow: var(--shadow);
  opacity: 0.85;
}

.dev-scan-sim__panel {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 0.5rem;
  width: 20rem;
  max-height: 80vh;
  overflow-y: auto;
  padding: 0.75rem;
  border: 1px dashed var(--primary);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.dev-scan-sim__tabs {
  display: flex;
  gap: 0.25rem;
}

.dev-scan-sim__tab {
  flex: 1;
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.dev-scan-sim__tab--active {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}

.dev-scan-sim__label {
  font-weight: 600;
  color: var(--muted);
}

.dev-scan-sim__row {
  display: flex;
  gap: 0.5rem;
}

.dev-scan-sim__row input {
  flex: 1;
  min-width: 0;
}

.dev-scan-sim__panel input,
.dev-scan-sim__panel textarea,
.dev-scan-sim__panel select {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.375rem 0.5rem;
  font: inherit;
}

.dev-scan-sim__select {
  width: 100%;
  background: var(--surface);
}

.dev-scan-sim__result {
  border-top: 1px solid var(--border);
  padding-top: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.dev-scan-sim__qr-text {
  font-family: monospace;
  font-size: 0.75rem;
  word-break: break-all;
  background: var(--bg);
  padding: 0.375rem 0.5rem;
  border-radius: var(--radius);
  max-height: 5rem;
  overflow-y: auto;
}

.dev-scan-sim__qr-canvas {
  align-self: center;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.dev-scan-sim__status {
  margin: 0;
  color: var(--muted);
  word-break: break-all;
}
</style>
