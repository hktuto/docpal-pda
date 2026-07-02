<template>
  <div class="container">
    <h1>Object Detection Demo</h1>
    <p class="subtitle">Take a photo and detect objects with the bundled ML Kit model.</p>

    <div class="controls">
      <label class="control">
        <span>Confidence threshold: {{ confidence }}</span>
        <input v-model.number="confidence" type="range" min="0" max="1" step="0.05" />
      </label>

      <label class="control checkbox">
        <input v-model="enableClassification" type="checkbox" />
        <span>Enable classification</span>
      </label>

      <label class="control checkbox">
        <input v-model="enableMultipleObjects" type="checkbox" />
        <span>Detect multiple objects</span>
      </label>
    </div>

    <button class="btn" :disabled="isProcessing" @click="onDetect">
      {{ isProcessing ? 'Detecting…' : 'Take photo & detect' }}
    </button>

    <div v-if="error" class="error">{{ error }}</div>

    <div v-if="imageUrl" class="preview-wrapper">
      <div class="preview">
        <img ref="imageEl" :src="imageUrl" alt="Captured photo" @load="onImageLoad" />
        <div
          v-for="(obj, index) in objects"
          :key="index"
          class="box"
          :style="boxStyle(obj.boundingBox)"
        >
          <span class="box__label">{{ labelText(obj) }}</span>
        </div>
      </div>
    </div>

    <div v-if="objects.length" class="result">
      <h3>Detected objects ({{ objects.length }})</h3>
      <ul>
        <li v-for="(obj, index) in objects" :key="index">
          <strong>#{{ index + 1 }}</strong>
          {{ obj.labels.length
            ? obj.labels.map((l) => `${l.text} (${Math.round(l.confidence * 100)}%)`).join(', ')
            : 'No label (unclassified)' }}
          <span class="meta">
            box [{{ obj.boundingBox.left }}, {{ obj.boundingBox.top }}, {{ obj.boundingBox.right }}, {{ obj.boundingBox.bottom }}]
          </span>
        </li>
      </ul>
      <p class="hint">
        The bundled base model only returns coarse categories such as Fashion good, Food, Home good, Place, Plant.
        If it isn't confident, the label list is empty.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Capacitor } from '@capacitor/core';
import type { DetectedObject } from '~/composables/useObjectDetection';

const confidence = ref(0.2);
const enableClassification = ref(true);
const enableMultipleObjects = ref(true);
const isProcessing = ref(false);
const imageUrl = ref<string | null>(null);
const objects = ref<DetectedObject[]>([]);
const error = ref<string | null>(null);
const imageEl = ref<HTMLImageElement | null>(null);
const imageSize = ref<{ width: number; height: number } | null>(null);

function onImageLoad() {
  if (!imageEl.value) return;
  imageSize.value = {
    width: imageEl.value.naturalWidth,
    height: imageEl.value.naturalHeight,
  };
}

function boxStyle(box: DetectedObject['boundingBox']) {
  if (!imageSize.value) return {};
  const img = imageSize.value;
  return {
    left: `${(box.left / img.width) * 100}%`,
    top: `${(box.top / img.height) * 100}%`,
    width: `${((box.right - box.left) / img.width) * 100}%`,
    height: `${((box.bottom - box.top) / img.height) * 100}%`,
  };
}

function labelText(obj: DetectedObject) {
  if (!obj.labels.length) return 'object (no label)';
  return obj.labels
    .map((l) => `${l.text} ${Math.round(l.confidence * 100)}%`)
    .join(', ');
}

async function onDetect() {
  error.value = null;
  imageUrl.value = null;
  objects.value = [];
  imageSize.value = null;

  try {
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
    const { detectFromPath } = useObjectDetection();

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

    imageUrl.value = photo.webPath ?? Capacitor.convertFileSrc(photo.path);

    const result = await detectFromPath(photo.path, {
      confidence: confidence.value,
      enableMultipleObjects: enableMultipleObjects.value,
      enableClassification: enableClassification.value,
    });

    objects.value = result.objects;
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

.control input[type="range"] {
  width: 100%;
}

.error {
  color: var(--danger);
  font-size: 0.875rem;
  margin-top: 1rem;
}

.preview-wrapper {
  margin-top: 1.5rem;
}

.preview {
  position: relative;
  display: inline-block;
  max-width: 100%;
}

.preview img {
  display: block;
  max-width: 100%;
  height: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.box {
  position: absolute;
  border: 2px solid #16a34a;
  background: rgba(22, 163, 74, 0.1);
  pointer-events: none;
}

.box__label {
  position: absolute;
  top: 0;
  left: 0;
  transform: translateY(-100%);
  background: #16a34a;
  color: white;
  font-size: 0.7rem;
  padding: 0.125rem 0.375rem;
  white-space: nowrap;
}

.result {
  margin-top: 1.5rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem;
}

.result h3 {
  margin: 0 0 0.5rem;
  font-size: 0.875rem;
  color: var(--muted);
}

.result ul {
  margin: 0;
  padding-left: 1.25rem;
  font-size: 0.875rem;
}

.result li {
  margin-bottom: 0.5rem;
}

.meta {
  display: block;
  color: var(--muted);
  font-size: 0.75rem;
}

.hint {
  margin: 0.75rem 0 0;
  font-size: 0.75rem;
  color: var(--muted);
}
</style>
