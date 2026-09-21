<script setup lang="ts">
import type { FlowConfigState } from "~/utils/flowApi";
import { formatDateCodeDisplay } from "~/utils/dateCodeDisplay";
import { formatReceivingOrderName } from "~/utils/receivingOrderName";
import {
  DEFAULT_PDA_LIST_TEMPLATES,
  PDA_LIST_FIELDS,
  PDA_LIST_KEYS,
  formatListRow,
  type PdaListKey,
  type PdaListTemplate,
  type PdaListTemplates,
} from "~/utils/listRowTemplate";

// Display template editors (specs
// docs/superpowers/specs/2026-09-17-date-code-display-template-design.md,
// docs/superpowers/specs/2026-09-21-receiving-order-name-template-design.md
// and docs/superpowers/specs/2026-09-21-pda-list-row-templates-design.md):
// - dateCodeDisplayTemplate — how lot date code / lot code / COO / COW render
//   in the receiving and picking detail screens.
// - receivingOrderNameTemplate — how the receiving order NAME renders on the
//   PDA and in the admin receiving list/detail (backend-computed displayName).
// - pdaListTemplates — per-PDA-list {title, meta} templates for the six PDA
//   list pages (applied client-side in the PDA app).
// Saves through the same /admin/flow-config endpoint; the backend PUT stores
// the raw body as the whole row, so we merge our keys over the stored JSON.

const flow = useFlowApi();
const { t } = useI18n();

const PLACEHOLDERS = ["date_code", "lot_code", "coo", "cow"] as const;
const RO_PLACEHOLDERS = [
  "batch_no",
  "invoice_no",
  "supplier_code",
  "supplier_name",
  "delivery_date",
  "date_code",
] as const;

// Preview samples: a full lot and one with no COO/COW (shows the empty-
// placeholder behavior — no dangling separator).
const SAMPLE_FULL = { dateCode: "3626", lotCode: "L01", coo: "cn", cow: "tw" };
const SAMPLE_PARTIAL = { dateCode: "3626", lotCode: "L01", coo: null, cow: null };

// Preview samples for the receiving order name: a full order and one with no
// invoice (shows the batch-no fallback when the render would be empty).
const RO_SAMPLE_FULL = {
  batchNo: "BATCH-20260921-01",
  invoiceNo: "INV-100234, INV-100235",
  supplierCode: "SUP",
  supplierName: "Supplier Ltd",
  deliveryDate: "2026-09-21",
  dateCode: "3626",
};
const RO_SAMPLE_NO_INVOICE = {
  batchNo: "BATCH-20260921-01",
  invoiceNo: null,
  supplierCode: null,
  supplierName: null,
  deliveryDate: null,
  dateCode: null,
};

// PDA list-row editor: which list is being edited, the placeholder chips for
// it, and full/partial sample rows for the live preview. The partial sample
// shows the title fallback and the hidden-meta behavior.
const PDA_LIST_I18N: Record<PdaListKey, string> = {
  receiving: "receiving",
  picking: "picking",
  "put-away": "putAway",
  "goods-verify": "goodsVerify",
  verify: "verify",
  measuring: "measuring",
};

const PDA_SAMPLE_FULL: Record<PdaListKey, Record<string, unknown>> = {
  receiving: {
    displayName: "BATCH-20260921-01 · INV-100234",
    batchNo: "BATCH-20260921-01",
    invoiceNos: "INV-100234, INV-100235",
    supplierCode: "SUP",
    supplierName: "Supplier Ltd",
    deliveryDate: "2026-09-21",
    dateCode: "3626",
    status: "pending",
    orgId: 2,
    invoiceCount: 2,
    itemCount: 12,
    remainingItems: 5,
    pendingPickingOrders: 1,
  },
  picking: {
    orderNo: "SO-100234",
    status: "pending",
    allocationStatus: "allocated",
    customerCode: "CUST-01",
    poNo: "PO-556677",
    shipTo: "Hong Kong",
    deliveryDate: "2026-09-22",
    itemCount: 8,
    totalQty: 120,
    pickedQty: 0,
    workingByName: "chan.tm",
    orgId: 2,
    subInventoryCode: "STORE1",
  },
  "put-away": {
    displayName: "BATCH-20260921-01 · INV-100234",
    batchNo: "BATCH-20260921-01",
    invoiceNos: "INV-100234, INV-100235",
    supplierCode: "SUP",
    supplierName: "Supplier Ltd",
    deliveryDate: "2026-09-21",
    dateCode: "3626",
    status: "in_hand",
    orgId: 2,
    subInventoryCode: "STORE1",
    unboxedItems: 3,
    receivedItems: 10,
  },
  "goods-verify": {
    wclItemNo: "WCL-001",
    partNo: "PN-001",
    shelfCode: "A-01-01",
    boxId: "BOX-1",
    taskDate: "2026-09-21",
    expectedQty: 24,
    status: "pending",
    verifiedBy: "chan.tm",
    verifiedAt: "2026-09-21T08:30:00.000Z",
  },
  verify: {
    shippingBoxId: "BOX-HK-001",
    boxStatus: "closed",
    orderNos: ["SO-100234", "SO-100235"],
    destinationCountry: "DE",
    packageCount: 12,
    verifyVerifiedCount: 5,
  },
  measuring: {
    boxId: "BOX-HK-001",
    status: "pending",
    orderNos: ["SO-100234"],
    packageCount: 12,
    verifiedCount: 0,
  },
};

const PDA_SAMPLE_PARTIAL: Record<PdaListKey, Record<string, unknown>> = {
  receiving: { batchNo: "BATCH-20260921-01", displayName: "BATCH-20260921-01" },
  picking: { orderNo: "SO-100234" },
  "put-away": { batchNo: "BATCH-20260921-01" },
  "goods-verify": { partNo: "PN-001" },
  verify: { shippingBoxId: "BOX-HK-001" },
  measuring: { boxId: "BOX-HK-001" },
};

const state = ref<FlowConfigState | null>(null);
const templateText = ref("");
const templateInput = ref<HTMLInputElement | null>(null);
const roTemplateText = ref("");
const roTemplateInput = ref<HTMLInputElement | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const saved = ref(false);

// PDA list-row editor state: the six lists' {title, meta} texts (defaults
// until the config loads), the selected list, and which input the chips
// insert into (title/meta — set by focus).
const pdaTemplates = ref<Record<PdaListKey, PdaListTemplate>>({ ...DEFAULT_PDA_LIST_TEMPLATES });
const pdaList = ref<PdaListKey>("receiving");
const pdaTarget = ref<"title" | "meta">("title");
const pdaTitleInput = ref<HTMLInputElement | null>(null);
const pdaMetaInput = ref<HTMLInputElement | null>(null);

const pdaPlaceholders = computed(() => Object.keys(PDA_LIST_FIELDS[pdaList.value]));
const pdaCurrentTemplates = computed(
  () => ({ ...DEFAULT_PDA_LIST_TEMPLATES, [pdaList.value]: pdaTemplates.value[pdaList.value] }) as PdaListTemplates
);
const pdaPreviewTitleFull = computed(() => formatListRow(pdaList.value, "title", PDA_SAMPLE_FULL[pdaList.value], pdaCurrentTemplates.value));
const pdaPreviewMetaFull = computed(() => formatListRow(pdaList.value, "meta", PDA_SAMPLE_FULL[pdaList.value], pdaCurrentTemplates.value));
const pdaPreviewTitlePartial = computed(() => formatListRow(pdaList.value, "title", PDA_SAMPLE_PARTIAL[pdaList.value], pdaCurrentTemplates.value));
const pdaPreviewMetaPartial = computed(() => formatListRow(pdaList.value, "meta", PDA_SAMPLE_PARTIAL[pdaList.value], pdaCurrentTemplates.value));

const previewFull = computed(() => formatDateCodeDisplay(SAMPLE_FULL, templateText.value) || "—");
const previewPartial = computed(() => formatDateCodeDisplay(SAMPLE_PARTIAL, templateText.value) || "—");
const roPreviewFull = computed(() => formatReceivingOrderName(RO_SAMPLE_FULL, roTemplateText.value) || "—");
const roPreviewFallback = computed(() => formatReceivingOrderName(RO_SAMPLE_NO_INVOICE, roTemplateText.value) || "—");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    state.value = await flow.getFlowConfig();
    templateText.value = state.value.config.dateCodeDisplayTemplate ?? "[date_code][coo]";
    roTemplateText.value = state.value.config.receivingOrderNameTemplate ?? "[batch_no]";
    const storedPda = state.value.config.pdaListTemplates ?? {};
    pdaTemplates.value = Object.fromEntries(
      PDA_LIST_KEYS.map((key) => [key, { ...DEFAULT_PDA_LIST_TEMPLATES[key], ...(storedPda[key] ?? {}) }])
    ) as Record<PdaListKey, PdaListTemplate>;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function insertPlaceholder(name: (typeof PLACEHOLDERS)[number] | (typeof RO_PLACEHOLDERS)[number], target: "lot" | "order") {
  const token = `[${name}]`;
  const textRef = target === "lot" ? templateText : roTemplateText;
  const el = target === "lot" ? templateInput.value : roTemplateInput.value;
  if (!el) {
    textRef.value += token;
    return;
  }
  const start = el.selectionStart ?? textRef.value.length;
  const end = el.selectionEnd ?? start;
  textRef.value = textRef.value.slice(0, start) + token + textRef.value.slice(end);
  nextTick(() => {
    el.focus();
    el.setSelectionRange(start + token.length, start + token.length);
  });
}

function insertPdaPlaceholder(name: string) {
  const token = `[${name}]`;
  const slot = pdaTarget.value;
  const cur = pdaTemplates.value[pdaList.value];
  const el = slot === "title" ? pdaTitleInput.value : pdaMetaInput.value;
  if (!el) {
    cur[slot] += token;
    return;
  }
  const text = cur[slot];
  const start = el.selectionStart ?? text.length;
  const end = el.selectionEnd ?? start;
  cur[slot] = text.slice(0, start) + token + text.slice(end);
  nextTick(() => {
    el.focus();
    el.setSelectionRange(start + token.length, start + token.length);
  });
}

async function save() {
  if (templateText.value.trim() === "" || roTemplateText.value.trim() === "") {
    error.value = t("admin.pages.displayConfig.templateInvalid");
    return;
  }
  if (PDA_LIST_KEYS.some((key) => pdaTemplates.value[key].title.trim() === "" || pdaTemplates.value[key].meta.trim() === "")) {
    error.value = t("admin.pages.displayConfig.templateInvalid");
    return;
  }
  saving.value = true;
  error.value = "";
  saved.value = false;
  try {
    // Store only lists that differ from the built-in defaults, keeping the
    // warehouse_config row minimal.
    const pdaListTemplates: Record<string, PdaListTemplate> = {};
    for (const key of PDA_LIST_KEYS) {
      const cur = pdaTemplates.value[key];
      if (cur.title !== DEFAULT_PDA_LIST_TEMPLATES[key].title || cur.meta !== DEFAULT_PDA_LIST_TEMPLATES[key].meta) {
        pdaListTemplates[key] = cur;
      }
    }
    state.value = await flow.saveFlowConfig({
      ...(state.value?.stored ?? {}),
      dateCodeDisplayTemplate: templateText.value,
      receivingOrderNameTemplate: roTemplateText.value,
      pdaListTemplates,
    });
    saved.value = true;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.displayConfig.title") }}</h1>
    </div>

    <p v-if="loading">{{ $t("admin.common.loading") }}</p>
    <template v-else-if="state">
      <div v-if="state.envOverride" class="warn-banner">
        {{ $t("admin.pages.displayConfig.envOverrideWarning") }}
      </div>

      <div class="card form-card">
        <h2>{{ $t("admin.pages.displayConfig.templateSection") }}</h2>
        <div class="form-row">
          <label for="dc-template">{{ $t("admin.pages.displayConfig.template") }}</label>
          <input id="dc-template" ref="templateInput" v-model="templateText" type="text" class="template-input" />
        </div>
        <div class="chip-row">
          <button
            v-for="p in PLACEHOLDERS"
            :key="p"
            type="button"
            class="btn chip"
            :title="$t(`admin.pages.displayConfig.placeholderLabels.${p}`)"
            @click="insertPlaceholder(p, 'lot')"
          >
            [{{ p }}]
          </button>
        </div>
        <p class="hint-text">{{ $t("admin.pages.displayConfig.templateHint") }}</p>

        <h2>{{ $t("admin.pages.displayConfig.previewSection") }}</h2>
        <div class="preview-row">
          <span class="preview-label">{{ $t("admin.pages.displayConfig.previewFull") }}</span>
          <code class="preview-value">{{ previewFull }}</code>
        </div>
        <div class="preview-row">
          <span class="preview-label">{{ $t("admin.pages.displayConfig.previewNoCoo") }}</span>
          <code class="preview-value">{{ previewPartial }}</code>
        </div>
      </div>

      <div class="card form-card">
        <h2>{{ $t("admin.pages.displayConfig.roTemplateSection") }}</h2>
        <div class="form-row">
          <label for="ro-template">{{ $t("admin.pages.displayConfig.roTemplate") }}</label>
          <input id="ro-template" ref="roTemplateInput" v-model="roTemplateText" type="text" class="template-input" />
        </div>
        <div class="chip-row">
          <button
            v-for="p in RO_PLACEHOLDERS"
            :key="p"
            type="button"
            class="btn chip"
            :title="$t(`admin.pages.displayConfig.roPlaceholderLabels.${p}`)"
            @click="insertPlaceholder(p, 'order')"
          >
            [{{ p }}]
          </button>
        </div>
        <p class="hint-text">{{ $t("admin.pages.displayConfig.roTemplateHint") }}</p>

        <h2>{{ $t("admin.pages.displayConfig.previewSection") }}</h2>
        <div class="preview-row">
          <span class="preview-label">{{ $t("admin.pages.displayConfig.roPreviewFull") }}</span>
          <code class="preview-value">{{ roPreviewFull }}</code>
        </div>
        <div class="preview-row">
          <span class="preview-label">{{ $t("admin.pages.displayConfig.roPreviewFallback") }}</span>
          <code class="preview-value">{{ roPreviewFallback }}</code>
        </div>
      </div>

      <div class="card form-card">
        <h2>{{ $t("admin.pages.displayConfig.pdaSection") }}</h2>
        <div class="form-row">
          <label for="pda-list">{{ $t("admin.pages.displayConfig.pdaList") }}</label>
          <select id="pda-list" v-model="pdaList" class="pda-list-select">
            <option v-for="key in PDA_LIST_KEYS" :key="key" :value="key">
              {{ $t(`admin.pages.displayConfig.pdaLists.${PDA_LIST_I18N[key]}`) }}
            </option>
          </select>
        </div>
        <div class="form-row">
          <label for="pda-title">{{ $t("admin.pages.displayConfig.pdaTitle") }}</label>
          <input
            id="pda-title"
            ref="pdaTitleInput"
            v-model="pdaTemplates[pdaList].title"
            type="text"
            class="template-input"
            @focus="pdaTarget = 'title'"
          />
        </div>
        <div class="form-row">
          <label for="pda-meta">{{ $t("admin.pages.displayConfig.pdaMeta") }}</label>
          <input
            id="pda-meta"
            ref="pdaMetaInput"
            v-model="pdaTemplates[pdaList].meta"
            type="text"
            class="template-input"
            @focus="pdaTarget = 'meta'"
          />
        </div>
        <div class="chip-row">
          <button
            v-for="p in pdaPlaceholders"
            :key="p"
            type="button"
            class="btn chip"
            :title="$t(`admin.pages.displayConfig.pdaFieldLabels.${p}`)"
            @click="insertPdaPlaceholder(p)"
          >
            [{{ p }}]
          </button>
        </div>
        <p class="hint-text">{{ $t("admin.pages.displayConfig.pdaHint") }}</p>

        <h2>{{ $t("admin.pages.displayConfig.previewSection") }}</h2>
        <div class="preview-row">
          <span class="preview-label">{{ $t("admin.pages.displayConfig.pdaPreviewTitleFull") }}</span>
          <code class="preview-value">{{ pdaPreviewTitleFull }}</code>
        </div>
        <div class="preview-row">
          <span class="preview-label">{{ $t("admin.pages.displayConfig.pdaPreviewMetaFull") }}</span>
          <code class="preview-value">{{ pdaPreviewMetaFull || "—" }}</code>
        </div>
        <div class="preview-row">
          <span class="preview-label">{{ $t("admin.pages.displayConfig.pdaPreviewTitlePartial") }}</span>
          <code class="preview-value">{{ pdaPreviewTitlePartial }}</code>
        </div>
        <div class="preview-row">
          <span class="preview-label">{{ $t("admin.pages.displayConfig.pdaPreviewMetaPartial") }}</span>
          <code class="preview-value">{{ pdaPreviewMetaPartial || "—" }}</code>
        </div>
      </div>

      <div class="actions-row">
        <button class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? $t("admin.common.saving") : $t("admin.common.save") }}
        </button>
        <span v-if="saved" class="ok-text">{{ $t("admin.pages.displayConfig.saved") }}</span>
        <span v-if="error" class="error-text">{{ error }}</span>
      </div>
    </template>
    <p v-else class="error-text">{{ error }}</p>
  </div>
</template>

<style scoped>
.form-card {
  margin-bottom: 1rem;
}

.form-card h2 {
  margin: 0 0 0.75rem;
  font-size: 1rem;
}

.form-card h2 + .preview-row,
.form-row + .chip-row {
  margin-top: 0.5rem;
}

.form-card h2:not(:first-child) {
  margin-top: 1.25rem;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.template-input {
  width: 24rem;
  font-family: ui-monospace, monospace;
}

.pda-list-select {
  min-width: 12rem;
}

.chip-row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.chip {
  font-family: ui-monospace, monospace;
  font-size: 0.8125rem;
  padding: 0.25rem 0.625rem;
}

.preview-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.25rem 0;
}

.preview-label {
  min-width: 14rem;
  font-size: 0.875rem;
}

.preview-value {
  padding: 0.125rem 0.5rem;
  background: #f2f5f8;
  border-radius: 0.25rem;
}

.hint-text {
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
  color: var(--muted, #666);
}

.warn-banner {
  background: #fff8e1;
  border: 1px solid #f0c36d;
  border-radius: 0.375rem;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
}

.actions-row {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.ok-text {
  color: var(--ok, #2e7d32);
}

.error-text {
  color: var(--danger, #c62828);
}
</style>
