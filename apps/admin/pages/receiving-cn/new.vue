<script setup lang="ts">
import { checkCnDraft, cnDraftToEntry, fillMergedCells, parseCnManifestAoa, parseCnReceivingAoa, type AoaMergeRange, type CnDraftIssue, type CnReceivingDraft, type CnReceivingParseResult } from "~/utils/cnReceivingExcel";
import { submitCnExcelUpload, submitCnPdfUpload } from "~/utils/flowApi";

const { t } = useI18n();
const parts = usePartsBrandCheck();

// Two upload paths (spec
// docs/superpowers/specs/2026-11-08-receiving-cn-excel-local-upload-design.md):
// - PDF(s): kick the DocPal OCR workflow, one upload per file set (unchanged).
// - Excel(s): decode LOCALLY in the browser, batch-check every part key and
//   the row shapes — all clean creates the pending CN orders directly (one
//   per file); problems open the verify/edit step with the issue list. The
//   two types never mix in one upload.
const fileInput = ref<HTMLInputElement | null>(null);
const files = ref<File[]>([]); // PDFs
const drafts = ref<CnReceivingDraft[]>([]); // decoded Excels
const parsing = ref(false);
const error = ref("");
const submitting = ref(false);
const step = ref<1 | 2>(1);
let nextUid = 1;

const PDF_EXT = /\.pdf$/i;
const EXCEL_EXT = /\.(xls|xlsx)$/i;

function triggerPick() {
  fileInput.value?.click();
}

function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const picked = input.files ? Array.from(input.files) : [];
  input.value = ""; // reset so the same file can be re-selected
  void acceptFiles(picked);
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
  void acceptFiles(dropped);
}

async function acceptFiles(picked: File[]) {
  if (picked.length === 0) return;
  if (picked.some((f) => !PDF_EXT.test(f.name) && !EXCEL_EXT.test(f.name))) {
    error.value = t("admin.pages.receivingCn.invalidFileType");
    return;
  }
  const pdfs = picked.filter((f) => PDF_EXT.test(f.name));
  const excels = picked.filter((f) => EXCEL_EXT.test(f.name));
  if ((pdfs.length > 0 && excels.length > 0) || (pdfs.length > 0 && drafts.value.length > 0) || (excels.length > 0 && files.value.length > 0)) {
    error.value = t("admin.pages.receivingCn.mixedTypes");
    return;
  }
  error.value = "";
  if (pdfs.length > 0) {
    // Skip exact duplicates (same name + size already in the list).
    const existing = new Set(files.value.map((f) => `${f.name}:${f.size}`));
    files.value = [...files.value, ...pdfs.filter((f) => !existing.has(`${f.name}:${f.size}`))];
    return;
  }
  parsing.value = true;
  try {
    const added: CnReceivingDraft[] = [];
    for (const f of excels) added.push(...(await addExcelDraft(f)));
    await gateAndAutoCreate(added);
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    parsing.value = false;
  }
}

async function addExcelDraft(picked: File): Promise<CnReceivingDraft[]> {
  const XLSX = await import("xlsx");
  const buf = await picked.arrayBuffer();
  const wb = XLSX.read(buf);
  // Some workbooks lead with an empty cover sheet (e.g. 入数) and multi-tab
  // sheets mirror subsets of the master — scan every sheet and use the first
  // one whose item table actually decodes. Truck manifests (車單) carry MANY
  // supplier invoices per file: the confirmation parse finds nothing, so fall
  // back to the manifest decoder → one draft (one pending order) per INVOICE
  // NO (spec docs/superpowers/specs/2026-11-10-receiving-cn-truck-manifest-
  // upload-design.md).
  let results: CnReceivingParseResult[] | null = null;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (aoa.length === 0) continue;
    const merged = fillMergedCells(aoa as unknown[][], (ws["!merges"] as AoaMergeRange[] | undefined) ?? []);
    const single = parseCnReceivingAoa(merged.aoa, merged.filled);
    const sheetResults = single.items.length > 0 ? [single] : parseCnManifestAoa(merged.aoa);
    if (sheetResults.length > 0) {
      results = sheetResults;
      break;
    }
    results ??= [single]; // keep the first decode for the error path below
  }
  const decoded = (results ?? []).filter((r) => r.items.length > 0);
  if (decoded.length === 0) {
    throw new Error(`${picked.name}: ${t("admin.pages.receivingCn.noItems")}`);
  }
  const created: CnReceivingDraft[] = [];
  for (const result of decoded) {
    drafts.value = [
      ...drafts.value,
      {
        uid: nextUid++,
        // Multi-invoice manifest split — tag the source filename so the N
        // tracking rows stay traceable to their invoice.
        filename: decoded.length > 1 ? `${picked.name} (${result.invoiceNo})` : picked.name,
        brand: "",
        header: {
          receivedOffice: result.receivedOffice,
          supplier: result.supplier,
          receiptNo: result.receiptNo,
          invoiceNo: result.invoiceNo,
          receivedDate: result.receivedDate,
        },
        items: result.items.map((item) => ({ ...item, uid: nextUid++ })),
        totals: result.totals,
        sheetTotals: result.sheetTotals,
      },
    ];
    // Return the REACTIVE entries (raw-object writes skip the editor's inputs).
    created.push(drafts.value[drafts.value.length - 1]!);
  }
  return created;
}

// Decode→create gate: batch-check every 型號 once, prefill the brand from
// the parts master, and auto-create when the data is clean. Problems keep
// the verify/edit step open with the issues banner (inline fix beats a
// re-upload round-trip).
async function gateAndAutoCreate(added: CnReceivingDraft[]) {
  const keys = added.flatMap((d) => d.items.map((i) => i.partNo.trim())).filter((k) => k !== "");
  if (keys.length > 0) {
    const failed = await parts.ensure(keys);
    if (failed) {
      error.value = t("admin.pages.receivingCn.partsCheckFailed");
      step.value = 2;
      return;
    }
  }
  const msgs: string[] = [];
  for (const d of added) {
    for (const iss of checkCnDraft(d, (k) => parts.check(k)?.found === true)) {
      msgs.push(fmtIssue(d.filename, iss));
    }
    if (d.brand.trim() === "") {
      const b = parts.brandOf(d.items[0]?.partNo ?? "");
      if (typeof b === "string") d.brand = b;
    }
  }
  if (msgs.length > 0) {
    error.value = msgs.join("\n");
    step.value = 2;
    return;
  }
  await submitExcelDrafts();
}

function fmtIssue(file: string, iss: CnDraftIssue): string {
  const key = `admin.pages.receivingCn.gate.${iss.code}`;
  const msg = iss.partNo !== undefined ? t(key, { partNo: iss.partNo }) : t(key);
  return `${file}${iss.row !== undefined ? ` #${iss.row}` : ""}: ${msg}`;
}

function removeFile(index: number) {
  files.value = files.value.filter((_, i) => i !== index);
}

function removeDraft(uid: number) {
  drafts.value = drafts.value.filter((d) => d.uid !== uid);
  if (drafts.value.length === 0) error.value = "";
}

function backToPick() {
  step.value = 1;
  error.value = "";
}

async function submit() {
  if (submitting.value || (files.value.length === 0 && drafts.value.length === 0)) return;
  if (drafts.value.length > 0) {
    await submitExcelDrafts();
    return;
  }
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

/** POST all decoded drafts — blank brand derives server-side from each
 *  sheet's first item. Failures land in the verify/edit step with the
 *  message banner (the data is fixable there). */
async function submitExcelDrafts() {
  if (submitting.value || drafts.value.length === 0) return;
  submitting.value = true;
  error.value = "";
  try {
    const { orders } = await submitCnExcelUpload(drafts.value.map(cnDraftToEntry));
    // Open the created order detail (multi-file uploads land on the first;
    // back returns to the tracking list with the rest).
    await navigateTo(orders[0] ? `/receiving-cn/${encodeURIComponent(orders[0].batchNo)}` : "/receiving-cn");
  } catch (e: any) {
    error.value = e?.message ?? String(e);
    step.value = 2;
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

    <div v-if="drafts.length > 0" class="steps">
      <span :class="['step', { active: step === 1 }]">1. {{ $t("admin.pages.receivingCn.stepUpload") }}</span>
      <span :class="['step', { active: step === 2 }]">2. {{ $t("admin.pages.receivingCn.stepVerify") }}</span>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <!-- Step 1: pick PDF(s) or Excel(s) (click to browse or drag & drop) -->
    <div v-if="step === 1" class="panel">
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
        <button class="btn btn-primary" :disabled="parsing" @click.stop="triggerPick">
          {{ parsing ? $t("admin.common.loading") : $t("admin.pages.receivingCn.pickFile") }}
        </button>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept=".pdf,.xls,.xlsx"
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
        <button class="btn btn-primary" :disabled="submitting || parsing || files.length === 0" @click="submit">
          {{ submitting ? $t("admin.pages.receivingCn.submitting") : $t("admin.pages.receivingCn.submit") }}
        </button>
      </div>
    </div>

    <!-- Step 2: verify/edit one section per decoded Excel, then create -->
    <div v-else class="panel">
      <ReceivingCnExcelDraftEditor
        v-for="draft in drafts"
        :key="draft.uid"
        :draft="draft"
        @remove="removeDraft(draft.uid)"
      />

      <div class="wizard-actions">
        <button class="btn" :disabled="submitting" @click="backToPick">
          {{ $t("admin.common.back") }}
        </button>
        <button
          class="btn btn-primary"
          :disabled="submitting || drafts.length === 0"
          @click="submit"
        >
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
.steps {
  display: flex;
  gap: 1rem;
  margin-bottom: 0.75rem;
  font-size: 0.875rem;
}
.step {
  color: #9aa5b1;
}
.step.active {
  color: #0b5cab;
  font-weight: 600;
}
.panel {
  display: grid;
  gap: 0.75rem;
  justify-items: start;
  width: 100%;
  overflow: auto;
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
/* Gate issue lists are newline-joined. */
.error-banner {
  white-space: pre-line;
}
</style>
