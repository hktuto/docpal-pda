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

const { t } = useI18n();

// Role labels are translated here; FIELD_ROLES keeps the English source labels
// as documentation/fallback.
const roleOptions = computed(() =>
  FIELD_ROLES.map((r) => ({ value: r.value, label: t(`admin.pages.supplierProfile.roles.${r.value}`) }))
);

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
    if (!regex.value) return t("admin.pages.supplierProfile.errors.enterPattern");
    try {
      new RegExp(regex.value, "u");
      return "";
    } catch {
      return t("admin.pages.supplierProfile.errors.invalidRegex");
    }
  }
  const pieces = mode.value === "delimited" ? effectiveFields.value.length : fixedFields.value.length;
  if (pieces === 0)
    return mode.value === "delimited"
      ? t("admin.pages.supplierProfile.errors.pasteSampleFirst")
      : t("admin.pages.supplierProfile.errors.addOneField");
  if (itemIdCount.value === 0) return t("admin.pages.supplierProfile.errors.markOneItemId");
  if (itemIdCount.value > 1) return t("admin.pages.supplierProfile.errors.onlyOneItemId");
  return "";
});

// ---- live preview + test bench ----
const parsedSample = computed(() =>
  sample.value.trim() && regex.value && !structureError.value ? parseWithRegex(regex.value, sample.value) : null
);
const sampleError = computed(() => {
  if (!sample.value.trim() || structureError.value) return "";
  if (!parsedSample.value) return t("admin.pages.supplierProfile.errors.sampleNoMatch");
  if (!parsedSample.value.itemId) return t("admin.pages.supplierProfile.errors.sampleNoItemId");
  return "";
});

function displayQty(raw: string | undefined): string {
  if (raw === undefined) return "";
  if (qtyEncoding.value === "koa_zeros") {
    const n = decodeKoaQty(raw);
    return n !== undefined ? `${n.toLocaleString()} (${t("admin.pages.supplierProfile.koaFormat")})` : raw;
  }
  return raw;
}

const previewRows = computed(() => {
  const p = parsedSample.value;
  if (!p) return [];
  const rows: { label: string; value: string }[] = [];
  const push = (labelKey: string, v: string | undefined, isQty = false) => {
    if (v !== undefined) {
      rows.push({ label: t(`admin.pages.supplierProfile.preview.${labelKey}`), value: isQty ? displayQty(v) : v });
    }
  };
  push("itemId", p.itemId);
  push("qty", p.qty, true);
  push("lotCode", p.lotCode);
  push("dateCode", p.dateCode);
  push("coo", p.coo);
  push("cow", p.cow);
  push("serialNo", p.serialNo);
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
        let reason = t("admin.pages.supplierProfile.errors.noMatch");
        if (mode.value === "delimited") {
          const n = line.split(delimiter.value).length;
          if (n !== effectiveFields.value.length) {
            reason = t("admin.pages.supplierProfile.errors.pieceCount", { n, m: effectiveFields.value.length });
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
  <div class="profile-editor">
    <div v-if="serverError" class="error-banner">{{ serverError }}</div>
    <form @submit.prevent="save">
      <div class="form-row">
        <label for="qt-name">{{ $t("admin.fields.name") }}</label>
        <input id="qt-name" v-model="name" type="text" :placeholder="$t('admin.pages.supplierProfile.namePlaceholder')" />
      </div>
      <div class="form-row">
        <label for="qt-type">{{ $t("admin.pages.supplierProfile.labelCodeType") }}</label>
        <select id="qt-type" v-model="qrTypePreset">
          <option value="">{{ $t("admin.pages.supplierProfile.notSpecified") }}</option>
          <option v-for="qt in QR_TYPES" :key="qt" :value="qt">{{ qt }}</option>
          <option value="other">{{ $t("admin.pages.supplierProfile.other") }}</option>
        </select>
        <input
          v-if="qrTypePreset === 'other'"
          v-model="qrTypeOther"
          type="text"
          :placeholder="$t('admin.pages.supplierProfile.otherTypePlaceholder')"
          class="inline-other"
        />
        <div class="hint">{{ $t("admin.pages.supplierProfile.labelCodeTypeHint") }}</div>
      </div>
      <div class="form-row">
        <label for="qt-qty">{{ $t("admin.pages.supplierProfile.qtyFormat") }}</label>
        <select id="qt-qty" v-model="qtyEncoding">
          <option value="">{{ $t("admin.pages.supplierProfile.qtyPlain") }}</option>
          <option value="koa_zeros">{{ $t("admin.pages.supplierProfile.qtyKoa") }}</option>
        </select>
      </div>
      <div class="form-row">
        <label for="qt-remark">{{ $t("admin.fields.remark") }}</label>
        <input id="qt-remark" v-model="remark" type="text" />
      </div>

      <hr class="dlg-sep" />
      <h3>{{ $t("admin.pages.supplierProfile.scanTemplate") }}</h3>

      <div class="form-row">
        <label for="qt-sample">{{ $t("admin.pages.supplierProfile.sampleScan") }}</label>
        <textarea
          id="qt-sample"
          v-model="sample"
          rows="2"
          :placeholder="$t('admin.pages.supplierProfile.samplePlaceholder')"
        ></textarea>
        <div class="hint">{{ $t("admin.pages.supplierProfile.sampleHint") }}</div>
      </div>

      <div class="form-row">
        <label>{{ $t("admin.pages.supplierProfile.format") }}</label>
        <div class="mode-radios">
          <label><input v-model="mode" type="radio" value="delimited" /> {{ $t("admin.pages.supplierProfile.modeDelimited") }}</label>
          <label><input v-model="mode" type="radio" value="fixed" /> {{ $t("admin.pages.supplierProfile.modeFixed") }}</label>
          <label><input v-model="mode" type="radio" value="advanced" /> {{ $t("admin.pages.supplierProfile.modeAdvanced") }}</label>
        </div>
      </div>

      <!-- delimited mode -->
      <template v-if="mode === 'delimited'">
        <div class="form-row">
          <label for="qt-delim">{{ $t("admin.pages.supplierProfile.separator") }}</label>
          <select id="qt-delim" v-model="delimiterPreset">
            <option v-for="d in DELIMITERS" :key="d.value" :value="d.value">{{ d.label }}</option>
            <option value="other">{{ $t("admin.pages.supplierProfile.other") }}</option>
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
          <label>{{ $t("admin.pages.supplierProfile.labelEachPiece") }}</label>
          <div class="chips">
            <div v-for="(seg, i) in segments" :key="i" class="chip">
              <span class="chip-value" :class="{ muted: seg === '' }">
                {{ seg === "" ? $t("admin.pages.supplierProfile.emptyPiece") : seg }}
              </span>
              <select v-model="fields[i].role">
                <option v-for="r in roleOptions" :key="r.value" :value="r.value">{{ r.label }}</option>
              </select>
            </div>
          </div>
        </div>
      </template>

      <!-- fixed mode -->
      <template v-else-if="mode === 'fixed'">
        <div class="form-row">
          <label>{{ $t("admin.pages.supplierProfile.fieldsByPosition") }}</label>
          <div v-if="sample" class="mono-sample">{{ sample.trim() }}</div>
          <div v-for="(f, i) in fixedFields" :key="i" class="fixed-row">
            <span class="mono">{{ $t("admin.pages.supplierProfile.charsRange", { start: f.start, end: f.start + f.length - 1 }) }}</span>
            <span class="mono fixed-value">{{ sample.trim().slice(f.start, f.start + f.length) }}</span>
            <select v-model="f.role">
              <option v-for="r in roleOptions" :key="r.value" :value="r.value">{{ r.label }}</option>
            </select>
            <button type="button" class="tag-x" :title="$t('admin.pages.supplierProfile.removeField')" @click="removeFixedField(i)">×</button>
          </div>
          <div class="fixed-row">
            <label class="fixed-lab">{{ $t("admin.pages.supplierProfile.start") }} <input v-model.number="newFixed.start" type="number" min="0" class="num" /></label>
            <label class="fixed-lab">{{ $t("admin.pages.supplierProfile.length") }} <input v-model.number="newFixed.length" type="number" min="1" class="num" /></label>
            <select v-model="newFixed.role">
              <option v-for="r in roleOptions" :key="r.value" :value="r.value">{{ r.label }}</option>
            </select>
            <button type="button" class="btn btn-small" @click="addFixedField">{{ $t("admin.pages.supplierProfile.add") }}</button>
          </div>
          <div class="hint">{{ $t("admin.pages.supplierProfile.positionsHint") }}</div>
        </div>
      </template>

      <!-- advanced mode -->
      <template v-else>
        <div class="form-row">
          <label for="qt-regex">{{ $t("admin.pages.supplierProfile.pattern") }}</label>
          <textarea id="qt-regex" v-model="advancedRegex" rows="3" class="mono"></textarea>
          <div class="hint">
            {{ $t("admin.pages.supplierProfile.namedGroupsHint") }}
            <button type="button" class="btn-link" @click="rebuildFromSample">{{ $t("admin.pages.supplierProfile.rebuildFromSample") }}</button>
          </div>
        </div>
      </template>

      <div v-if="structureError" class="error-banner">{{ structureError }}</div>
      <div v-else-if="sampleError" class="error-banner">{{ sampleError }}</div>

      <!-- live preview -->
      <div v-if="previewRows.length" class="preview">
        <h4>{{ $t("admin.pages.supplierProfile.parsedFromSample") }}</h4>
        <table>
          <tbody>
            <tr v-for="r in previewRows" :key="r.label">
              <td class="pv-label">{{ r.label }}</td>
              <td class="mono">{{ r.value }}</td>
            </tr>
          </tbody>
        </table>
        <div class="hint">{{ $t("admin.pages.supplierProfile.generatedPattern") }} <code class="mono">{{ regex }}</code></div>
      </div>

      <!-- test bench -->
      <div class="form-row">
        <label for="qt-tests">
          {{ $t("admin.pages.supplierProfile.testMore") }}
          <span class="muted">{{ $t("admin.pages.supplierProfile.optional") }}</span>
        </label>
        <textarea
          id="qt-tests"
          v-model="testScans"
          rows="3"
          :placeholder="$t('admin.pages.supplierProfile.testPlaceholder')"
        ></textarea>
      </div>
      <div v-if="testLines.length" class="tests">
        <div v-for="(tl, i) in testLines" :key="i" class="test-line" :class="tl.ok ? 'ok' : 'bad'">
          <span class="test-mark">{{ tl.ok ? "✓" : "✗" }}</span>
          <span class="mono test-src">{{ tl.line }}</span>
          <span v-if="tl.ok" class="test-parsed">
            → {{ tl.parsed!.itemId
            }}<template v-if="tl.parsed!.qty"> · {{ $t("admin.fields.qty") }} {{ displayQty(tl.parsed!.qty) }}</template>
          </span>
          <span v-else class="test-reason">{{ tl.reason }}</span>
        </div>
      </div>

      <div class="dialog-actions">
        <button type="button" class="btn" @click="emit('cancel')">{{ $t("admin.common.cancel") }}</button>
        <button type="submit" class="btn btn-primary" :disabled="!canSave">{{ $t("admin.pages.supplierProfile.saveProfile") }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.profile-editor {
  max-width: 720px;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
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
