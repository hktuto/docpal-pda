<template>
  <div class="container">
    <h1>Subject Segmentation Demo</h1>
    <p class="subtitle">Take a photo and isolate the main subject from the background using on-device ML Kit.</p>

    <div class="actions">
      <button class="btn" :disabled="isProcessing" @click="onSegment">
        {{ isProcessing ? 'Processing…' : 'Take photo & segment' }}
      </button>

      <button class="btn btn--secondary" :disabled="isInstalling" @click="checkAndInstall">
        {{ isInstalling ? 'Installing model…' : 'Check / install model' }}
      </button>
    </div>

    <div v-if="modelStatus" class="status" :class="{ ok: modelAvailable }">
      {{ modelStatus }}
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <div v-if="originalUrl || segmentedUrl" class="gallery">
      <div v-if="originalUrl" class="card">
        <h3>Original</h3>
        <img :src="originalUrl" alt="Original photo" />
      </div>

      <div v-if="segmentedUrl" class="card">
        <h3>Segmented</h3>
        <img :src="segmentedUrl" alt="Segmented subject" />
        <p v-if="resultSize" class="meta">{{ resultSize.width }} × {{ resultSize.height }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Capacitor } from '@capacitor/core';
import { SubjectSegmentation } from '@capacitor-mlkit/subject-segmentation';

const isProcessing = ref(false);
const isInstalling = ref(false);
const modelAvailable = ref<boolean | null>(null);
const modelStatus = ref<string | null>(null);
const originalUrl = ref<string | null>(null);
const segmentedUrl = ref<string | null>(null);
const resultSize = ref<{ width: number; height: number } | null>(null);
const error = ref<string | null>(null);

async function checkAndInstall() {
  error.value = null;
  modelStatus.value = null;

  try {
    const { available } = await SubjectSegmentation.isGoogleSubjectSegmentationModuleAvailable();
    modelAvailable.value = available;

    if (available) {
      modelStatus.value = 'Subject segmentation model is available.';
      return;
    }

    modelStatus.value = 'Model not available. Starting download…';
    isInstalling.value = true;

    await SubjectSegmentation.addListener(
      'googleSubjectSegmentationModuleInstallProgress',
      (event) => {
        modelStatus.value = `Model download: ${event.state} (${event.progress}%)`;
        if (event.state === 4) {
          modelAvailable.value = true;
          modelStatus.value = 'Model download completed.';
        }
      },
    );

    await SubjectSegmentation.installGoogleSubjectSegmentationModule();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    isInstalling.value = false;
  }
}

async function onSegment() {
  error.value = null;
  originalUrl.value = null;
  segmentedUrl.value = null;
  resultSize.value = null;

  try {
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');

    isProcessing.value = true;

    const photo = await Camera.getPhoto({
      quality: 85,
      allowEditing: false,
      resultType: CameraResultType.Uri,
      source: CameraSource.Camera,
      width: 1280,
    });

    if (!photo.path) {
      throw new Error('No image file path returned from camera.');
    }

    originalUrl.value = photo.webPath ?? Capacitor.convertFileSrc(photo.path);

    const result = await SubjectSegmentation.processImage({
      path: photo.path,
      confidence: 0.7,
    });

    segmentedUrl.value = Capacitor.convertFileSrc(result.path);
    resultSize.value = { width: result.width, height: result.height };
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    isProcessing.value = false;
  }
}
</script>

<style scoped>
.subtitle {
  color: var(--muted);
  font-size: 0.875rem;
  margin: -0.5rem 0 1.5rem;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.btn--secondary {
  background: var(--surface);
  color: var(--primary);
  border-color: var(--primary);
}

.status {
  font-size: 0.875rem;
  color: var(--muted);
  margin-bottom: 1rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.status.ok {
  color: #16a34a;
  border-color: #16a34a;
}

.error {
  color: var(--danger);
  font-size: 0.875rem;
  margin-bottom: 1rem;
}

.gallery {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
}

.gallery img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: var(--radius);
  border: 1px solid var(--border);
}

.meta {
  font-size: 0.75rem;
  color: var(--muted);
  margin: 0.5rem 0 0;
}
</style>
