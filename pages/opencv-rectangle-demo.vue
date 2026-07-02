<template>
  <div class="container">
    <h1>OpenCV Rectangle Stream</h1>
    <p class="subtitle">
      Opens a native camera preview that runs OpenCV rectangle detection on each
      frame. Tap a rectangle to capture it, or use the shutter to pick one from
      the detected rectangles.
    </p>

    <button class="btn" :disabled="isStarting" @click="onStartStream">
      {{ isStarting ? 'Opening…' : 'Start camera stream' }}
    </button>

    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="status" class="status">{{ status }}</div>

    <div v-if="capture" class="capture-preview">
      <h2>Captured</h2>
      <img
        v-if="capture.imagePath"
        :src="Capacitor.convertFileSrc(capture.imagePath)"
        alt="Captured rectangle"
      />
      <p class="meta">
        {{ capture.width }}×{{ capture.height }} |
        {{ capture.rectangles.length }} rectangle(s) detected
        <span v-if="capture.selectedRect">| 1 selected</span>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Capacitor } from '@capacitor/core';

definePageMeta({ title: 'OpenCV Rectangle Stream' });

const { startCameraStream } = useRectangleDetection();

const isStarting = ref(false);
const error = ref<string | null>(null);
const status = ref<string | null>(null);
const capture = ref<CameraStreamCaptureResult | null>(null);

async function onStartStream() {
  error.value = null;
  status.value = null;
  capture.value = null;
  isStarting.value = true;

  try {
    const result = await startCameraStream();
    capture.value = result;
    status.value = 'Capture returned successfully.';
  } catch (e: any) {
    if (e?.message === 'Cancelled') {
      status.value = 'Camera stream was cancelled.';
    } else {
      error.value = e?.message ?? String(e);
    }
  } finally {
    isStarting.value = false;
  }
}
</script>

<style scoped>
.subtitle {
  color: var(--muted);
  font-size: 0.875rem;
  margin: -0.5rem 0 1.5rem;
}

.error {
  color: var(--danger);
  font-size: 0.875rem;
  margin-top: 1rem;
}

.status {
  margin-top: 1rem;
  font-size: 0.875rem;
  color: var(--muted);
}

.capture-preview {
  margin-top: 1.5rem;
}

.capture-preview h2 {
  font-size: 1rem;
  margin-bottom: 0.5rem;
}

.capture-preview img {
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}

.capture-preview .meta {
  color: var(--muted);
  font-size: 0.875rem;
  margin-top: 0.5rem;
}
</style>
