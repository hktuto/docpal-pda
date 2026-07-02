<template>
  <div class="container">
    <h1>Camera OCR Demo</h1>
    <p class="subtitle">Take a photo with the device camera and run on-device ML Kit text recognition.</p>

    <button class="btn" @click="showModal = true">Open camera OCR</button>

    <div v-if="lastResult" class="card" style="margin-top: 1.5rem;">
      <h2 style="margin-top: 0; font-size: 1rem;">Last result</h2>
      <pre>{{ lastResult.text }}</pre>

      <h3 style="font-size: 0.875rem; color: var(--muted); margin: 1rem 0 0.5rem;">Detected lines</h3>
      <ul class="line-list">
        <li v-for="(line, index) in detectedLines" :key="index">{{ line }}</li>
      </ul>
    </div>

    <OcrCameraModal v-model="showModal" @result="onResult" />
  </div>
</template>

<script setup lang="ts">
import type { TextDetectionResult } from '@pantrist/capacitor-plugin-ml-kit-text-recognition';

const showModal = ref(false);
const lastResult = ref<TextDetectionResult | null>(null);

const detectedLines = computed(() => {
  if (!lastResult.value?.blocks) return [];
  const lines: string[] = [];
  for (const block of lastResult.value.blocks) {
    for (const line of block.lines ?? []) {
      if (line.text?.trim()) lines.push(line.text.trim());
    }
  }
  return lines;
});

function onResult(result: TextDetectionResult) {
  lastResult.value = result;
}
</script>

<style scoped>
.subtitle {
  color: var(--muted);
  font-size: 0.875rem;
  margin: -0.5rem 0 1.5rem;
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
