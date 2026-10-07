<template>
  <div class="dev-scan-sim">
    <button type="button" class="dev-scan-sim__toggle" @click="open = !open">
      DEV SCAN
    </button>
    <div v-if="open" class="dev-scan-sim__panel">
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

      <p v-if="status" class="dev-scan-sim__status">{{ status }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { simulateScan } from "~/composables/useHardwareScanner";
import { captureRawLabelValue, parseBrowserScanPrompt } from "~/composables/useLabelScan";

const open = ref(false);
const qrValue = ref("");
const ocrValue = ref("");
const status = ref("");

async function simulateQr() {
  const value = qrValue.value.trim();
  if (!value) return;
  status.value = (await simulateScan(value))
    ? `Sent: ${value}`
    : "No active scanner on this page";
}

async function simulateOcr() {
  // OCR context is page-specific; every page's hardware scan handler already
  // parses a full label value via parseRawValue, so an OCR capture is
  // simulated as its QR barcode value (falling back to the raw text).
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
  width: 18rem;
  padding: 0.75rem;
  border: 1px dashed var(--primary);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
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
.dev-scan-sim__panel textarea {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.375rem 0.5rem;
  font: inherit;
}

.dev-scan-sim__status {
  margin: 0;
  color: var(--muted);
  word-break: break-all;
}
</style>
