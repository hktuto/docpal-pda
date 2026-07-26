<script setup lang="ts">
import {
  buildRegex,
  parseWithRegex,
  decodeKoaQty,
  detectMode,
  FIELD_ROLES,
  type QrTemplateConfig,
  type FieldRole,
} from "~/utils/qrTemplate";

// QR-template editor for one supplier profile. Builds supplier_profiles.qr_template
// (regex) from a structured config a non-technical user edits; saves both.
// Spec: docs/superpowers/specs/2026-07-24-supplier-qr-template-editor-design.md

const props = defineProps<{
  supplierCode: string;
  profile: any | null; // existing supplier_profiles row, or null for a new one
  serverError?: string;
}>();
const emit = defineEmits<{
  save: [payload: Record<string, unknown>];
  cancel: [];
}>();

const dismiss = useOverlayDismiss(() => emit("cancel"));

// ---- profile basics ----
const name = ref(props.profile?.name ?? "");
const remark = ref(props.profile?.remark ?? "");
const QR_TYPES = ["QR Code", "PDF417", "Code 128", "EAN-13 / ISBN", "Data Matrix"];
const initialQrType = props.profile?.qrType ?? "";
const qrTypePreset = ref(QR_TYPES.includes(initialQrType) ? initialQrType : initialQrType ? "other" : "");
const qrTypeOther = ref(QR_TYPES.includes(initialQrType) ? "" : initialQrType);
const qrType = computed(() => (qrTypePreset.value === "other" ? qrTypeOther.value.trim() : qrTypePreset.value));
const qtyEncoding = ref(props.profile?.qtyEncoding ?? "");

// ---- template builder ----
type Mode = "delimited" | "fixed" | "advanced";
const stored = detectMode(props.profile ?? {});
const mode = ref<Mode>(stored.mode);
const sample = ref("");

const DELIMITERS: { value: string; label: string }[] = [
  { value: ":", label: ":" },
  { value: ";", label: ";" },
  { value: ",", label: "," },
  { value: "|", label: "|" },
  { value: "\t", label: "Tab" },
];
const initialDelimiter = stored.mode === "delimited" ? stored.delimiter : ":";
const delimiterPreset = ref(DELIMITERS.some((d) => d.value === initialDelimiter) ? initialDelimiter : "other");
const delimiterOther = ref(DELIMITERS.some((d) => d.value === initialDelimiter) ? "" : initialDelimiter);
const delimiter = computed(() => (delimiterPreset.value === "other" ? delimiterOther.value || ":" : delimiterPreset.value));

const fields = ref<{ role: FieldRole }[]>(
  stored.mode === "delimited" ? stored.fields.map((f) => ({ role: f.role })) : []
);
const fixedFields = ref<{ role: FieldRole; start: number; length: number }[]>(
  stored.mode === "fixed" ? stored.fields.map((f) => ({ ...f })) : []
);
const advancedRegex = ref(stored.mode === "advanced" ? props.profile?.qrTemplate ?? "" : "");
const testScans = ref("");

// delimited: split the sample; pad field roles when the piece count grows.
// Never truncate on shrink (typing/pasting fires intermediate lengths —
// truncating would destroy role assignments); config slices at build time.
const segments = computed(() => (sample.value === "" ? [] : sample.value.trim().split(delimiter.value)));
watch(
  () => segments.value.length,
  (n) => {
    if (mode.value !== "delimited") return;
    while (fields.value.length < n) fields.value.push({ role: "ignore" });
  }
);

// fixed: add-field form
const newFixed = ref({ role: "itemId" as FieldRole, start: 0, length: 8 });
function addFixedField() {
  if (newFixed.value.length <= 0 || newFixed.value.start < 0) return;
  fixedFields.value.push({ ...newFixed.value });
  fixedFields.value.sort((a, b) => a.start - b.start);
}
function removeFixedField(i: number) {
  fixedFields.value.splice(i, 1);
}

// the fields that actually participate: sliced to the sample's piece count
// when a sample is present (fields is never truncated — see the watcher)
const effectiveFields = computed(() =>
  segments.value.length ? fields.value.slice(0, segments.value.length) : fields.value
);

const config = computed<QrTemplateConfig>(() => {
  if (mode.value === "delimited") {
    return { version: 1, mode: "delimited", delimiter: delimiter.value, fields: effectiveFields.value };
  }
  if (mode.value === "fixed") {
    return { version: 1, mode: "fixed", fields: fixedFields.value };
  }
  return { version: 1, mode: "advanced" };
});

const regex = computed(() => {
  if (mode.value === "advanced") return advancedRegex.value.trim();
  try {
    return buildRegex(config.value);
  } catch {
    return "";
  }
});

const itemIdCount = computed(
  () =>
    (mode.value === "delimited" ? effectiveFields.value : fixedFields.value).filter((f) => f.role === "itemId").length
);
const structureError = computed(() => {
  if (mode.value === "advanced") {
    if (!regex.value) return "Enter the pattern.";
    try {
      new RegExp(regex.value, "u");
      return "";
    } catch {
      return "This pattern is not a valid regular expression.";
    }
  }
  const pieces = mode.value === "delimited" ? effectiveFields.value.length : fixedFields.value.length;
  if (pieces === 0) return mode.value === "delimited" ? "Paste a sample scan first." : "Add at least one field.";
  if (itemIdCount.value === 0) return "Mark exactly one piece as Part number.";
  if (itemIdCount.value > 1) return "Only one piece can be the Part number.";
  return "";
});

// ---- live preview + test bench ----
const parsedSample = computed(() =>
  sample.value.trim() && regex.value && !structureError.value ? parseWithRegex(regex.value, sample.value) : null
);
const sampleError = computed(() => {
  if (!sample.value.trim() || structureError.value) return "";
  if (!parsedSample.value) return "The sample does not match the template.";
  if (!parsedSample.value.itemId) return "The template must capture a Part number from the sample.";
  return "";
});

function displayQty(raw: string | undefined): string {
  if (raw === undefined) return "";
  if (qtyEncoding.value === "koa_zeros") {
    const n = decodeKoaQty(raw);
    return n !== undefined ? `${n.toLocaleString()} (KOA format)` : raw;
  }
  return raw;
}

const previewRows = computed(() => {
  const p = parsedSample.value;
  if (!p) return [];
  const rows: { label: string; value: string }[] = [];
  const push = (label: string, v: string | undefined) => {
    if (v !== undefined) rows.push({ label, value: label === "Quantity" ? displayQty(v) : v });
  };
  push("Part number", p.itemId);
  push("Quantity", p.qty);
  push("Lot code", p.lotCode);
  push("Date code", p.dateCode);
  push("Country of origin", p.coo);
  push("Country of warehousing", p.cow);
  push("Serial number", p.serialNo);
  return rows;
});

interface TestLine {
  line: string;
  ok: boolean;
  reason: string;
  parsed: Record<string, string> | null;
}
const testLines = computed<TestLine[]>(() => {
  if (structureError.value || !regex.value) return [];
  return testScans.value
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((line) => {
      const parsed = parseWithRegex(regex.value, line);
      if (!parsed || !parsed.itemId) {
        let reason = "Does not match the template.";
        if (mode.value === "delimited") {
          const n = line.split(delimiter.value).length;
          if (n !== effectiveFields.value.length) {
            reason = `This scan has ${n} pieces but the template expects ${effectiveFields.value.length}.`;
          }
        }
        return { line, ok: false, reason, parsed: null };
      }
      return { line, ok: true, reason: "", parsed };
    });
});
const failedTests = computed(() => testLines.value.filter((t) => !t.ok).length);

const canSave = computed(() => !structureError.value && !sampleError.value && failedTests.value === 0);

function rebuildFromSample() {
  mode.value = "delimited";
  fields.value = [];
}

function save() {
  if (!canSave.value) return;
  emit("save", {
    supplierCode: props.supplierCode,
    name: name.value,
    remark: remark.value,
    qrType: qrType.value,
    qtyEncoding: qtyEncoding.value,
    qrTemplate: regex.value,
    qrTemplateConfig: config.value,
  });
}
</script>

<template>
  <div class="overlay" @mousedown="dismiss.onMousedown" @click="dismiss.onClick">
    <div class="dialog qr-dialog">
      <h2>Supplier profile — {{ supplierCode }}</h2>
      <div v-if="serverError" class="error-banner">{{ serverError }}</div>
      <form @submit.prevent="save">
        <div class="form-row">
          <label for="qt-name">Name</label>
          <input id="qt-name" v-model="name" type="text" placeholder="local display name (optional)" />
        </div>
        <div class="form-row">
          <label for="qt-type">Label code type</label>
          <select id="qt-type" v-model="qrTypePreset">
            <option value="">Not specified</option>
            <option v-for="t in QR_TYPES" :key="t" :value="t">{{ t }}</option>
            <option value="other">Other…</option>
          </select>
          <input
            v-if="qrTypePreset === 'other'"
            v-model="qrTypeOther"
            type="text"
            placeholder="e.g. Code 39"
            class="inline-other"
          />
          <div class="hint">The kind of barcode printed on this supplier's labels.</div>
        </div>
        <div class="form-row">
          <label for="qt-qty">Quantity format</label>
          <select id="qt-qty" v-model="qtyEncoding">
            <option value="">Plain number</option>
            <option value="koa_zeros">KOA style — last digit counts zeros (e.g. 253 → 25,000)</option>
          </select>
        </div>
        <div class="form-row">
          <label for="qt-remark">Remark</label>
          <input id="qt-remark" v-model="remark" type="text" />
        </div>

        <hr class="dlg-sep" />
        <h3>Scan template</h3>

        <div class="form-row">
          <label for="qt-sample">Sample scan</label>
          <textarea
            id="qt-sample"
            v-model="sample"
            rows="2"
            placeholder="Scan or paste a real label from this supplier, e.g. :RK73H1JTTD1002F:S1:14:X:L2601A:602:NAME"
          ></textarea>
          <div class="hint">Use the PDA scanner or copy the raw code from a real label.</div>
        </div>

        <div class="form-row">
          <label>Format</label>
          <div class="mode-radios">
            <label><input v-model="mode" type="radio" value="delimited" /> Separated by a character</label>
            <label><input v-model="mode" type="radio" value="fixed" /> Fixed positions</label>
            <label><input v-model="mode" type="radio" value="advanced" /> Advanced (edit pattern directly)</label>
          </div>
        </div>

        <!-- delimited mode -->
        <template v-if="mode === 'delimited'">
          <div class="form-row">
            <label for="qt-delim">Separator</label>
            <select id="qt-delim" v-model="delimiterPreset">
              <option v-for="d in DELIMITERS" :key="d.value" :value="d.value">{{ d.label }}</option>
              <option value="other">Other…</option>
            </select>
            <input
              v-if="delimiterPreset === 'other'"
              v-model="delimiterOther"
              type="text"
              maxlength="1"
              class="inline-other delim-input"
            />
          </div>
          <div v-if="segments.length" class="form-row">
            <label>Label each piece</label>
            <div class="chips">
              <div v-for="(seg, i) in segments" :key="i" class="chip">
                <span class="chip-value" :class="{ muted: seg === '' }">{{ seg === "" ? "(empty)" : seg }}</span>
                <select v-model="fields[i].role">
                  <option v-for="r in FIELD_ROLES" :key="r.value" :value="r.value">{{ r.label }}</option>
                </select>
              </div>
            </div>
          </div>
        </template>

        <!-- fixed mode -->
        <template v-else-if="mode === 'fixed'">
          <div class="form-row">
            <label>Fields by position</label>
            <div v-if="sample" class="mono-sample">{{ sample.trim() }}</div>
            <div v-for="(f, i) in fixedFields" :key="i" class="fixed-row">
              <span class="mono">chars {{ f.start }}–{{ f.start + f.length - 1 }}</span>
              <span class="mono fixed-value">{{ sample.trim().slice(f.start, f.start + f.length) }}</span>
              <select v-model="f.role">
                <option v-for="r in FIELD_ROLES" :key="r.value" :value="r.value">{{ r.label }}</option>
              </select>
              <button type="button" class="tag-x" title="Remove field" @click="removeFixedField(i)">×</button>
            </div>
            <div class="fixed-row">
              <label class="fixed-lab">start <input v-model.number="newFixed.start" type="number" min="0" class="num" /></label>
              <label class="fixed-lab">length <input v-model.number="newFixed.length" type="number" min="1" class="num" /></label>
              <select v-model="newFixed.role">
                <option v-for="r in FIELD_ROLES" :key="r.value" :value="r.value">{{ r.label }}</option>
              </select>
              <button type="button" class="btn btn-small" @click="addFixedField">Add</button>
            </div>
            <div class="hint">Positions are 0-based character offsets on the sample.</div>
          </div>
        </template>

        <!-- advanced mode -->
        <template v-else>
          <div class="form-row">
            <label for="qt-regex">Pattern (regular expression)</label>
            <textarea id="qt-regex" v-model="advancedRegex" rows="3" class="mono"></textarea>
            <div class="hint">
              Named groups: itemId (required), qty, lotCode, dateCode, coo, cow, serialNo.
              <button type="button" class="btn-link" @click="rebuildFromSample">Rebuild from a sample scan</button>
            </div>
          </div>
        </template>

        <div v-if="structureError" class="error-banner">{{ structureError }}</div>
        <div v-else-if="sampleError" class="error-banner">{{ sampleError }}</div>

        <!-- live preview -->
        <div v-if="previewRows.length" class="preview">
          <h4>Parsed from the sample</h4>
          <table>
            <tbody>
              <tr v-for="r in previewRows" :key="r.label">
                <td class="pv-label">{{ r.label }}</td>
                <td class="mono">{{ r.value }}</td>
              </tr>
            </tbody>
          </table>
          <div class="hint">Generated pattern: <code class="mono">{{ regex }}</code></div>
        </div>

        <!-- test bench -->
        <div class="form-row">
          <label for="qt-tests">Test more scans <span class="muted">(optional)</span></label>
          <textarea
            id="qt-tests"
            v-model="testScans"
            rows="3"
            placeholder="Paste more real labels, one per line"
          ></textarea>
        </div>
        <div v-if="testLines.length" class="tests">
          <div v-for="(t, i) in testLines" :key="i" class="test-line" :class="t.ok ? 'ok' : 'bad'">
            <span class="test-mark">{{ t.ok ? "✓" : "✗" }}</span>
            <span class="mono test-src">{{ t.line }}</span>
            <span v-if="t.ok" class="test-parsed">→ {{ t.parsed!.itemId }}<template v-if="t.parsed!.qty"> · qty {{ displayQty(t.parsed!.qty) }}</template></span>
            <span v-else class="test-reason">{{ t.reason }}</span>
          </div>
        </div>

        <div class="dialog-actions">
          <button type="button" class="btn" @click="emit('cancel')">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="!canSave">Save profile</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.qr-dialog {
  max-width: 640px;
  max-height: 90vh;
  overflow-y: auto;
}
.form-row textarea {
  width: 100%;
  padding: 7px 9px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
}
.form-row .num,
.form-row .fixed-row select,
.form-row .chip select {
  width: auto;
}
h3 {
  margin: 4px 0 10px;
  font-size: 15px;
}
h4 {
  margin: 0 0 6px;
  font-size: 13px;
}
.dlg-sep {
  border: none;
  border-top: 1px solid #e3e8ee;
  margin: 14px 0;
}
.mode-radios {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 4px;
}
.mode-radios input[type="radio"] {
  width: auto;
}
.mode-radios label {
  font-weight: normal;
  display: flex;
  align-items: center;
  gap: 6px;
}
.inline-other {
  margin-top: 6px;
}
.delim-input {
  width: 60px;
}
.chips {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #f6f8fa;
  border: 1px solid #e3e8ee;
  border-radius: 6px;
  padding: 4px 8px;
}
.chip-value {
  flex: 1;
  font-family: monospace;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.muted {
  color: #8a94a0;
}
.mono {
  font-family: monospace;
  font-size: 12px;
}
.mono-sample {
  font-family: monospace;
  font-size: 13px;
  background: #f6f8fa;
  border: 1px solid #e3e8ee;
  border-radius: 6px;
  padding: 6px 8px;
  margin-bottom: 8px;
  overflow-wrap: anywhere;
}
.fixed-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.fixed-value {
  flex: 1;
  overflow-wrap: anywhere;
}
.fixed-lab {
  font-weight: normal;
  display: flex;
  align-items: center;
  gap: 4px;
}
.num {
  width: 64px;
}
.tag-x {
  border: none;
  background: none;
  color: #922b21;
  cursor: pointer;
  font-size: 14px;
}
.preview {
  background: #f0f7f0;
  border: 1px solid #d4e6d4;
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.preview table {
  border-collapse: collapse;
  margin-bottom: 6px;
}
.pv-label {
  padding: 2px 12px 2px 0;
  color: #4a5560;
  font-size: 13px;
}
.tests {
  margin-bottom: 12px;
}
.test-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
  font-size: 13px;
}
.test-mark {
  font-weight: bold;
}
.test-line.ok .test-mark {
  color: #1e7e34;
}
.test-line.bad .test-mark,
.test-reason {
  color: #922b21;
}
.test-src {
  overflow-wrap: anywhere;
}
.test-parsed {
  color: #1e7e34;
}
</style>
