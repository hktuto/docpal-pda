<script setup lang="ts">
import { submitCnPdfUpload } from "~/utils/flowApi";

const { t } = useI18n();

// Phase 2 (PDF + OCR): pick the scanned receiving confirmation PDF(s) and
// start the DocPal workflow — DocPal extracts the receiving data (no
// browser-side verify step; the workflow-verify screen comes later). Multiple
// PDFs go into ONE upload: all are kicked under the same workflow.
const fileInput = ref<HTMLInputElement | null>(null);
const files = ref<File[]>([]);
const error = ref("");
const submitting = ref(false);

function triggerPick() {
  fileInput.value?.click();
}

function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const picked = input.files ? Array.from(input.files) : [];
  input.value = ""; // reset so the same file can be re-selected
  acceptFiles(picked);
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
  const dropped = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
  acceptFiles(dropped);
}

function acceptFiles(picked: File[]) {
  const rejected = picked.filter((f) => !f.name.toLowerCase().endsWith(".pdf"));
  if (rejected.length > 0) {
    error.value = t("admin.pages.receivingCn.invalidFileType");
    return;
  }
  // Skip exact duplicates (same name + size already in the list).
  const existing = new Set(files.value.map((f) => `${f.name}:${f.size}`));
  files.value = [...files.value, ...picked.filter((f) => !existing.has(`${f.name}:${f.size}`))];
  error.value = "";
}

function removeFile(index: number) {
  files.value = files.value.filter((_, i) => i !== index);
  error.value = "";
}

async function submit() {
  if (files.value.length === 0 || submitting.value) return;
  submitting.value = true;
  error.value = "";
  try {
    await submitCnPdfUpload(files.value);
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
        multiple
        style="display: none"
        @change="onFilePicked"
      />

      <ul v-if="files.length > 0" class="selected-files">
        <li v-for="(f, i) in files" :key="`${f.name}:${f.size}`" class="selected-file">
          {{ f.name }}
          <button class="btn btn-small" @click="removeFile(i)">×</button>
        </li>
      </ul>

      <div class="wizard-actions">
        <button class="btn" @click="cancel">{{ $t("admin.common.cancel") }}</button>
        <button class="btn btn-primary" :disabled="submitting || files.length === 0" @click="submit">
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
.selected-files {
  display: grid;
  gap: 0.375rem;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 0.875rem;
}
.selected-file {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.wizard-actions {
  display: flex;
  gap: 0.625rem;
}
</style>
