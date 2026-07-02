<template>
  <div class="container">
    <h1>Document Scanner Demo</h1>
    <p class="subtitle">
      Use Google ML Kit Document Scanner to detect a label/note rectangle, crop it,
      then optionally run OCR on the cropped image.
    </p>

    <div class="controls">
      <label class="control checkbox">
        <input v-model="letUserAdjustCrop" type="checkbox" />
        <span>Let user adjust crop</span>
      </label>

      <label class="control checkbox">
        <input v-model="runOcrAfterScan" type="checkbox" />
        <span>Run OCR after scan</span>
      </label>
    </div>

    <button class="btn" :disabled="isScanning" @click="onScan">
      {{ isScanning ? 'Scanning…' : 'Scan document' }}
    </button>

    <div v-if="error" class="error">{{ error }}</div>

    <div v-if="scannedImages.length" class="results">
      <h3>Scanned images ({{ scannedImages.length }})</h3>
      <div class="image-list">
        <img
          v-for="(img, index) in scannedImages"
          :key="index"
          :src="`data:image/jpeg;base64,${img}`"
          alt="Scanned document"
          class="scanned-image"
        />
      </div>
    </div>

    <div v-if="ocrResult" class="card" style="margin-top: 1.5rem;">
      <h2 style="margin-top: 0; font-size: 1rem;">OCR result</h2>
      <pre>{{ ocrResult.text }}</pre>

      <h3 style="font-size: 0.875rem; color: var(--muted); margin: 1rem 0 0.5rem;">Detected lines</h3>
      <ul class="line-list">
        <li v-for="(line, index) in detectedLines" :key="index">{{ line }}</li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TextDetectionResult } from '@pantrist/capacitor-plugin-ml-kit-text-recognition';

definePageMeta({ title: 'Document Scanner Demo' });

const { isScanning, error, scanDocuments } = useDocumentScanner();

const letUserAdjustCrop = ref(true);
const runOcrAfterScan = ref(true);
const scannedImages = ref<string[]>([]);
const ocrResult = ref<TextDetectionResult | null>(null);

const detectedLines = computed(() => {
  if (!ocrResult.value?.blocks) return [];
  const lines: string[] = [];
  for (const block of ocrResult.value.blocks) {
    for (const line of block.lines ?? []) {
      if (line.text?.trim()) lines.push(line.text.trim());
    }
  }
  return lines;
});

async function onScan() {
  error.value = null;
  scannedImages.value = [];
  ocrResult.value = null;

  try {
    const result = await scanDocuments({
      maxNumDocuments: 1,
      letUserAdjustCrop: letUserAdjustCrop.value,
    });

    if (result.status === 'cancel') {
      return;
    }

    scannedImages.value = result.images;

    if (runOcrAfterScan.value && result.images.length > 0) {
      ocrResult.value = await detectTextFromBase64(result.images[0], 0);
    }
  } catch (e: any) {
    console.error('[document-scanner-demo] scan failed:', e);
  }
}
</script>

<style scoped>
.subtitle {
  color: var(--muted);
  font-size: 0.875rem;
  margin: -0.5rem 0 1.5rem;
}

.controls {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.control {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.875rem;
}

.control.checkbox {
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
}

.error {
  color: var(--danger);
  font-size: 0.875rem;
  margin-top: 1rem;
}

.results {
  margin-top: 1.5rem;
}

.results h3 {
  margin: 0 0 0.5rem;
  font-size: 0.875rem;
  color: var(--muted);
}

.image-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.scanned-image {
  max-width: 100%;
  height: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

pre {
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg);
  padding: 0.75rem;
  border-radius: var(--radius);
  font-size: 0.9375rem;
}

.line-list {
  margin: 0;
  padding-left: 1.25rem;
  font-size: 0.9375rem;
}

.line-list li {
  margin-bottom: 0.25rem;
}
</style>
