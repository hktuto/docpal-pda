<script setup lang="ts">
import { submitCnPdfUpload } from "~/utils/flowApi";

const { t } = useI18n();

// Phase 2 (PDF + OCR): pick the scanned receiving confirmation PDF and start
// the DocPal workflow — DocPal extracts the receiving data (no browser-side
// verify step; the workflow-verify screen comes later).
const fileInput = ref<HTMLInputElement | null>(null);
const file = ref<File | null>(null);
const error = ref("");
const submitting = ref(false);

function triggerPick() {
  fileInput.value?.click();
}

function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const picked = input.files?.[0];
  input.value = ""; // reset so the same file can be re-selected
  if (!picked) return;
  acceptFile(picked);
}

// ---- drag & drop ----

const dragOver = ref(false);
let dragDepth = 0;

function onDragEnter(e: DragEvent) {
  e.preventDefault();
  dragDepth++;
  dragOver.value = true;
}

function onDragLeave(e: DragEvent) {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragOver.value = false;
}

function onDragOver(e: DragEvent) {
  e.preventDefault(); // required so the drop event fires
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  dragDepth = 0;
  dragOver.value = false;
  const dropped = e.dataTransfer?.files?.[0];
  if (!dropped) return;
  acceptFile(dropped);
}

function acceptFile(picked: File) {
  if (!picked.name.toLowerCase().endsWith(".pdf")) {
    error.value = t("admin.pages.receivingCn.invalidFileType");
    return;
  }
  file.value = picked;
  error.value = "";
}

function clearFile() {
  file.value = null;
  error.value = "";
}

async function submit() {
  if (!file.value || submitting.value) return;
  submitting.value = true;
  error.value = "";
  try {
    await submitCnPdfUpload(file.value);
    await navigateTo("/receiving-cn");
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    submitting.value = false;
  }
}

function cancel() {
  navigateTo("/receiving-cn");
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.receivingCn.newTitle") }}</h1>
      <div class="head-actions">
        <button class="btn" @click="cancel">{{ $t("admin.common.cancel") }}</button>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <div class="panel">
      <div
        class="dropzone"
        :class="{ over: dragOver }"
        role="button"
        tabindex="0"
        @click="triggerPick"
        @keydown.enter.prevent="triggerPick"
        @dragenter="onDragEnter"
        @dragleave="onDragLeave"
        @dragover="onDragOver"
        @drop="onDrop"
      >
        <p class="hint">{{ $t("admin.pages.receivingCn.uploadHint") }}</p>
        <p class="drop-hint">{{ $t("admin.pages.receivingCn.dropHint") }}</p>
        <button class="btn btn-primary" @click.stop="triggerPick">
          {{ $t("admin.pages.receivingCn.pickFile") }}
        </button>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept=".pdf,application/pdf"
        style="display: none"
        @change="onFilePicked"
      />

      <div v-if="file" class="selected-file">
        <span class="dt">{{ $t("admin.pages.receivingCn.filename") }}:</span>
        {{ file.name }}
        <button class="btn btn-small" @click="clearFile">×</button>
      </div>

      <div class="wizard-actions">
        <button class="btn" @click="cancel">{{ $t("admin.common.cancel") }}</button>
        <button class="btn btn-primary" :disabled="submitting || !file" @click="submit">
          {{ submitting ? $t("admin.pages.receivingCn.submitting") : $t("admin.pages.receivingCn.submit") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 0.625rem;
}
.panel {
  display: grid;
  gap: 0.75rem;
  justify-items: start;
  width: 100%;
}
.hint {
  color: #52606d;
  margin: 0;
}
.dropzone {
  display: grid;
  gap: 0.5rem;
  justify-items: center;
  width: 100%;
  padding: 2.5rem 1rem;
  border: 2px dashed #b6c2cd;
  border-radius: var(--radius);
  background: #fff;
  cursor: pointer;
  text-align: center;
  box-sizing: border-box;
}
.dropzone:hover,
.dropzone.over {
  border-color: var(--brand-teal);
  background: #f4fafb;
}
.dropzone:focus-visible {
  outline: 2px solid var(--brand-teal);
  outline-offset: 2px;
}
.drop-hint {
  margin: 0;
  font-size: 0.8125rem;
  color: #7d8a97;
}
.selected-file {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
}
.selected-file .dt {
  font-weight: 600;
}
.wizard-actions {
  display: flex;
  gap: 0.625rem;
}
</style>
