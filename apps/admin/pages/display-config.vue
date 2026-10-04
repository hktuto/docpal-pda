<script setup lang="ts">
import type { FlowConfigState } from "~/utils/flowApi";
import { formatDateCodeDisplay } from "~/utils/dateCodeDisplay";
import { formatReceivingOrderName } from "~/utils/receivingOrderName";
import { PDA_LIST_FIELDS, type PdaListRow } from "~/utils/listRowTemplate";
import {
  PDA_DETAIL_FIELDS,
  PDA_DETAIL_GROUPINGS,
  PDA_DETAIL_PAGE_KEYS,
  PDA_LIST_CHIP_FIELDS,
  PDA_VIEW_LIST_KEYS,
  defaultPdaViewConfig,
  pdaViewConfigOverrides,
  resolvePdaViewConfig,
  viewListRow,
  type PdaDetailPageKey,
  type PdaViewConfig,
  type PdaViewListKey,
} from "~/utils/viewConfig";

// Display template editors (specs
// docs/superpowers/specs/2026-09-17-date-code-display-template-design.md,
// docs/superpowers/specs/2026-09-21-receiving-order-name-template-design.md
// and docs/superpowers/specs/2026-10-04-pda-app-rewrite-design.md):
// - dateCodeDisplayTemplate — how lot date code / lot code / COO / COW render
//   in the receiving and picking detail screens.
// - receivingOrderNameTemplate — how the receiving order NAME renders on the
//   PDA and in the admin receiving list/detail (backend-computed displayName).
// - pdaViewConfig — per-page PDA view config: list rows (title / meta[1-2] /
//   chip) for the six flow lists + stock-search, and the row/expanded field
//   allow-lists + default grouping for the receiving/picking/put-away detail
//   pages. Supersedes the deprecated pdaListTemplates (the backend migrates
//   legacy per-list customizations when a list has no pdaViewConfig entry).
// Saves through the same /admin/flow-config endpoint; the backend PUT stores
// the raw body as the whole row, so we merge our keys over the stored JSON.

const flow = useFlowApi();
const { t } = useI18n();

const PLACEHOLDERS = ["date_code", "lot_code", "coo", "cow", "coo_short", "cow_short"] as const;
const RO_PLACEHOLDERS = [
  "batch_no",
  "invoice_no",
  "invoice_no_first",
  "supplier_code",
  "supplier_name",
  "delivery_date",
  "date_code",
] as const;

// Preview samples: a full lot and one with no COO/COW (shows the empty-
// placeholder behavior — no dangling separator).
const SAMPLE_FULL = { dateCode: "3626", lotCode: "L01", coo: "cn", cow: "tw" };
const SAMPLE_PARTIAL = { dateCode: "3626", lotCode: "L01", coo: null, cow: null };
// Sample country_list.short_code lookup for the [coo_short]/[cow_short] preview.
const SAMPLE_SHORT_CODES = { CN: "C", TW: "T" };

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

// PDA view editor: page selector covers the seven lists (six flow lists +
// stock-search) and the three detail pages.
type PdaEditorPage = PdaViewListKey | PdaDetailPageKey;
const PDA_LIST_PAGE_I18N: Record<PdaViewListKey, string> = {
  receiving: "receiving",
  picking: "picking",
  "put-away": "putAway",
  "goods-verify": "goodsVerify",
  verify: "verify",
  measuring: "measuring",
  "stock-search": "stockSearch",
};
const PDA_DETAIL_PAGE_I18N: Record<PdaDetailPageKey, string> = {
  receivingDetail: "receivingDetail",
  pickingDetail: "pickingDetail",
  putAwayDetail: "putAwayDetail",
};

const PDA_SAMPLE_FULL: Record<PdaViewListKey, Record<string, unknown>> = {
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
  "stock-search": {
    wclItemNo: "WCL-001",
    partNo: "PN-001",
    description: "Hex screw M4x20",
    onHandQty: 1240,
  },
};

const PDA_SAMPLE_PARTIAL: Record<PdaViewListKey, Record<string, unknown>> = {
  receiving: { batchNo: "BATCH-20260921-01", displayName: "BATCH-20260921-01" },
  picking: { orderNo: "SO-100234" },
  "put-away": { batchNo: "BATCH-20260921-01" },
  "goods-verify": { partNo: "PN-001" },
  verify: { shippingBoxId: "BOX-HK-001" },
  measuring: { boxId: "BOX-HK-001" },
  "stock-search": { partNo: "PN-001" },
};

// Detail-page preview samples: one item per page covering the whole catalog.
const DETAIL_SAMPLE: Record<PdaDetailPageKey, Record<string, string>> = {
  receivingDetail: {
    wcl_item_no: "WCL-001", part_no: "PN-001", expected_qty: "12", received_qty: "10",
    po_no: "PO-556677", po_line: "3", box_id: "CTN-9", date_code: "3626", lot_code: "L01",
    coo: "cn", cow: "tw", reserved_qty: "3", picked_qty: "2", put_away_qty: "1", available_qty: "4",
  },
  pickingDetail: {
    wcl_item_no: "WCL-001", part_no: "PN-001", qty: "24", picked_qty: "10", allocated_qty: "24",
    status: "picking", shelf_code: "A-01-01", box_id: "BOX-1", date_code: "3626", lot_code: "L01",
    coo: "cn", cow: "tw", source: "Receiving area",
  },
  putAwayDetail: {
    wcl_item_no: "WCL-001", part_no: "PN-001", expected_qty: "12", received_qty: "10",
    remaining_qty: "4", po_no: "PO-556677", box_id: "CTN-9", date_code: "3626", lot_code: "L01",
    coo: "cn", cow: "tw", suggested_shelf: "A-01-01",
  },
};

const IDENTITY_DETAIL_FIELDS = new Set(["wcl_item_no", "part_no"]);

const state = ref<FlowConfigState | null>(null);
const templateText = ref("");
const templateInput = ref<HTMLInputElement | null>(null);
const roTemplateText = ref("");
const roTemplateInput = ref<HTMLInputElement | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const saved = ref(false);

// PDA view editor state: the full draft view config (defaults until the
// config loads), the selected page, and which template input the placeholder
// chips insert into (title/meta1/meta2 — set by focus).
const pdaView = ref<PdaViewConfig>(defaultPdaViewConfig());
const pdaPage = ref<PdaEditorPage>("receiving");
const pdaTarget = ref<"title" | "meta1" | "meta2">("title");
const pdaTitleInput = ref<HTMLInputElement | null>(null);
const pdaMeta1Input = ref<HTMLInputElement | null>(null);
const pdaMeta2Input = ref<HTMLInputElement | null>(null);

const isListPage = computed(() => (PDA_VIEW_LIST_KEYS as string[]).includes(pdaPage.value));
const listPage = computed(() => pdaPage.value as PdaViewListKey);
const detailPage = computed(() => pdaPage.value as PdaDetailPageKey);

const pdaListDraft = computed(() => pdaView.value.lists[listPage.value]);
const pdaPlaceholders = computed(() => Object.keys(PDA_LIST_FIELDS[listPage.value]));
const pdaChipOptions = computed(() => PDA_LIST_CHIP_FIELDS[listPage.value]);
const pdaDetailFields = computed(() => (isListPage.value ? [] : PDA_DETAIL_FIELDS[detailPage.value]));

// Meta line two-way bindings: meta[0] always exists (validated non-empty);
// meta[1] is optional — clearing it drops the second line.
const meta1 = computed({
  get: () => pdaListDraft.value.meta[0] ?? "",
  set: (v: string) => {
    const second = pdaListDraft.value.meta[1];
    pdaListDraft.value.meta = second !== undefined ? [v, second] : [v];
  },
});
const meta2 = computed({
  get: () => pdaListDraft.value.meta[1] ?? "",
  set: (v: string) => {
    const first = pdaListDraft.value.meta[0] ?? "";
    pdaListDraft.value.meta = v.trim() !== "" ? [first, v] : [first];
  },
});

// Live list preview through the current draft (phone-width frame below).
const pdaPreviewView = computed(() => {
  const view = defaultPdaViewConfig();
  view.lists[listPage.value] = { ...pdaListDraft.value };
  return view;
});
const pdaPreviewFull = computed(() => viewListRow(listPage.value, PDA_SAMPLE_FULL[listPage.value] as PdaListRow, pdaPreviewView.value));
const pdaPreviewPartial = computed(() => viewListRow(listPage.value, PDA_SAMPLE_PARTIAL[listPage.value] as PdaListRow, pdaPreviewView.value));

// Chip preview text: the sample row's raw field value (status-like fields
// render their code; count fields their number).
const pdaPreviewChipText = computed(() => {
  const chip = pdaListDraft.value.chip;
  if (!chip || chip === "none") return "";
  const spec = PDA_LIST_FIELDS[listPage.value][chip];
  const sample = PDA_SAMPLE_FULL[listPage.value] as PdaListRow;
  const value = spec ? sample[spec.field] : undefined;
  return value === undefined || value === null || value === "" ? chip : String(value);
});

// Detail preview: collapsed meta = non-identity row fields, expanded = the
// expanded field rows, both rendered from the sample item.
function detailFieldLabel(field: string): string {
  return t(`admin.pages.displayConfig.detailFieldLabels.${field}`);
}
const detailPreviewMeta = computed(() => {
  if (isListPage.value) return "";
  return pdaView.value[detailPage.value].itemFields
    .filter((f) => !IDENTITY_DETAIL_FIELDS.has(f))
    .map((f) => `${detailFieldLabel(f)}: ${DETAIL_SAMPLE[detailPage.value][f] ?? "—"}`)
    .join(" · ");
});

const previewFull = computed(() => formatDateCodeDisplay(SAMPLE_FULL, templateText.value, SAMPLE_SHORT_CODES) || "—");
const previewPartial = computed(() => formatDateCodeDisplay(SAMPLE_PARTIAL, templateText.value, SAMPLE_SHORT_CODES) || "—");
const roPreviewFull = computed(() => formatReceivingOrderName(RO_SAMPLE_FULL, roTemplateText.value) || "—");
const roPreviewFallback = computed(() => formatReceivingOrderName(RO_SAMPLE_NO_INVOICE, roTemplateText.value) || "—");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    state.value = await flow.getFlowConfig();
    templateText.value = state.value.config.dateCodeDisplayTemplate ?? "[date_code][coo]";
    roTemplateText.value = state.value.config.receivingOrderNameTemplate ?? "[batch_no]";
    // Pre-fill from the stored pdaViewConfig overrides, with the legacy
    // pdaListTemplates migration fallback per list (mirrors the backend).
    pdaView.value = resolvePdaViewConfig(state.value.config.pdaViewConfig, state.value.config.pdaListTemplates);
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
  const el = pdaTarget.value === "title" ? pdaTitleInput.value : pdaTarget.value === "meta1" ? pdaMeta1Input.value : pdaMeta2Input.value;
  const textRef = pdaTarget.value === "title" ? null : pdaTarget.value === "meta1" ? meta1 : meta2;
  if (pdaTarget.value === "title") {
    const cur = pdaListDraft.value;
    if (!el) {
      cur.title += token;
      return;
    }
    const text = cur.title;
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? start;
    cur.title = text.slice(0, start) + token + text.slice(end);
    nextTick(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
    return;
  }
  if (!el || !textRef) {
    if (textRef) textRef.value += token;
    return;
  }
  const text = textRef.value;
  const start = el.selectionStart ?? text.length;
  const end = el.selectionEnd ?? start;
  textRef.value = text.slice(0, start) + token + text.slice(end);
  nextTick(() => {
    el.focus();
    el.setSelectionRange(start + token.length, start + token.length);
  });
}

// Detail field ordering: checked fields render in draft order with up/down
// controls; checking an unchecked catalog field appends it.
function isFieldSelected(page: PdaDetailPageKey, slot: "itemFields" | "expandedFields", field: string): boolean {
  return pdaView.value[page][slot].includes(field);
}
function toggleField(page: PdaDetailPageKey, slot: "itemFields" | "expandedFields", field: string) {
  const list = pdaView.value[page][slot];
  const index = list.indexOf(field);
  if (index >= 0) list.splice(index, 1);
  else list.push(field);
}
function moveField(page: PdaDetailPageKey, slot: "itemFields" | "expandedFields", field: string, dir: -1 | 1) {
  const list = pdaView.value[page][slot];
  const index = list.indexOf(field);
  const target = index + dir;
  if (index < 0 || target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
}

async function save() {
  if (templateText.value.trim() === "" || roTemplateText.value.trim() === "") {
    error.value = t("admin.pages.displayConfig.templateInvalid");
    return;
  }
  // The backend validates the same rules (400) — catch them early.
  for (const key of PDA_VIEW_LIST_KEYS) {
    const l = pdaView.value.lists[key];
    if (l.title.trim() === "" || l.meta.length < 1 || l.meta.length > 2 || l.meta.some((m) => m.trim() === "")) {
      error.value = t("admin.pages.displayConfig.templateInvalid");
      return;
    }
  }
  for (const page of PDA_DETAIL_PAGE_KEYS) {
    if (pdaView.value[page].itemFields.length === 0 || pdaView.value[page].expandedFields.length === 0) {
      error.value = t("admin.pages.displayConfig.templateInvalid");
      return;
    }
  }
  saving.value = true;
  error.value = "";
  saved.value = false;
  try {
    // Store only what differs from the built-in defaults, keeping the
    // warehouse_config row minimal (same convention as before).
    state.value = await flow.saveFlowConfig({
      ...(state.value?.stored ?? {}),
      dateCodeDisplayTemplate: templateText.value,
      receivingOrderNameTemplate: roTemplateText.value,
      pdaViewConfig: pdaViewConfigOverrides(pdaView.value),
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
          <label for="pda-page">{{ $t("admin.pages.displayConfig.pdaPage") }}</label>
          <select id="pda-page" v-model="pdaPage" class="pda-list-select">
            <optgroup :label="$t('admin.pages.displayConfig.pdaListPages')">
              <option v-for="key in PDA_VIEW_LIST_KEYS" :key="key" :value="key">
                {{ $t(`admin.pages.displayConfig.pdaPages.${PDA_LIST_PAGE_I18N[key]}`) }}
              </option>
            </optgroup>
            <optgroup :label="$t('admin.pages.displayConfig.pdaDetailPages')">
              <option v-for="key in PDA_DETAIL_PAGE_KEYS" :key="key" :value="key">
                {{ $t(`admin.pages.displayConfig.pdaPages.${PDA_DETAIL_PAGE_I18N[key]}`) }}
              </option>
            </optgroup>
          </select>
        </div>

        <template v-if="isListPage">
          <div class="form-row">
            <label for="pda-title">{{ $t("admin.pages.displayConfig.pdaTitle") }}</label>
            <input
              id="pda-title"
              ref="pdaTitleInput"
              v-model="pdaListDraft.title"
              type="text"
              class="template-input"
              @focus="pdaTarget = 'title'"
            />
          </div>
          <div class="form-row">
            <label for="pda-meta1">{{ $t("admin.pages.displayConfig.pdaMeta1") }}</label>
            <input
              id="pda-meta1"
              ref="pdaMeta1Input"
              v-model="meta1"
              type="text"
              class="template-input"
              @focus="pdaTarget = 'meta1'"
            />
          </div>
          <div class="form-row">
            <label for="pda-meta2">{{ $t("admin.pages.displayConfig.pdaMeta2") }}</label>
            <input
              id="pda-meta2"
              ref="pdaMeta2Input"
              v-model="meta2"
              type="text"
              class="template-input"
              @focus="pdaTarget = 'meta2'"
            />
          </div>
          <div class="form-row">
            <label for="pda-chip">{{ $t("admin.pages.displayConfig.pdaChip") }}</label>
            <select id="pda-chip" v-model="pdaListDraft.chip" class="pda-list-select">
              <option v-for="c in pdaChipOptions" :key="c" :value="c">
                {{ $t(`admin.pages.displayConfig.pdaChipLabels.${c}`) }}
              </option>
            </select>
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
        </template>

        <template v-else>
          <div v-if="detailPage === 'receivingDetail'" class="form-row">
            <label for="pda-grouping">{{ $t("admin.pages.displayConfig.pdaGrouping") }}</label>
            <select id="pda-grouping" v-model="pdaView.receivingDetail.defaultGrouping" class="pda-list-select">
              <option v-for="g in PDA_DETAIL_GROUPINGS" :key="g" :value="g">
                {{ $t(`admin.pages.displayConfig.pdaGroupingOptions.${g}`) }}
              </option>
            </select>
          </div>

          <div class="field-editor">
            <div class="field-editor__col">
              <h3>{{ $t("admin.pages.displayConfig.pdaRowFields") }}</h3>
              <div
                v-for="field in pdaView[detailPage].itemFields"
                :key="field"
                class="field-item"
              >
                <label>
                  <input type="checkbox" checked @change="toggleField(detailPage, 'itemFields', field)" />
                  {{ detailFieldLabel(field) }}
                </label>
                <span class="field-item__order">
                  <button type="button" class="btn order-btn" :aria-label="$t('admin.pages.displayConfig.moveUp')" @click="moveField(detailPage, 'itemFields', field, -1)">↑</button>
                  <button type="button" class="btn order-btn" :aria-label="$t('admin.pages.displayConfig.moveDown')" @click="moveField(detailPage, 'itemFields', field, 1)">↓</button>
                </span>
              </div>
              <div
                v-for="field in pdaDetailFields.filter((f) => !isFieldSelected(detailPage, 'itemFields', f))"
                :key="field"
                class="field-item field-item--off"
              >
                <label>
                  <input type="checkbox" @change="toggleField(detailPage, 'itemFields', field)" />
                  {{ detailFieldLabel(field) }}
                </label>
              </div>
            </div>

            <div class="field-editor__col">
              <h3>{{ $t("admin.pages.displayConfig.pdaExpandedFields") }}</h3>
              <div
                v-for="field in pdaView[detailPage].expandedFields"
                :key="field"
                class="field-item"
              >
                <label>
                  <input type="checkbox" checked @change="toggleField(detailPage, 'expandedFields', field)" />
                  {{ detailFieldLabel(field) }}
                </label>
                <span class="field-item__order">
                  <button type="button" class="btn order-btn" :aria-label="$t('admin.pages.displayConfig.moveUp')" @click="moveField(detailPage, 'expandedFields', field, -1)">↑</button>
                  <button type="button" class="btn order-btn" :aria-label="$t('admin.pages.displayConfig.moveDown')" @click="moveField(detailPage, 'expandedFields', field, 1)">↓</button>
                </span>
              </div>
              <div
                v-for="field in pdaDetailFields.filter((f) => !isFieldSelected(detailPage, 'expandedFields', f))"
                :key="field"
                class="field-item field-item--off"
              >
                <label>
                  <input type="checkbox" @change="toggleField(detailPage, 'expandedFields', field)" />
                  {{ detailFieldLabel(field) }}
                </label>
              </div>
            </div>
          </div>
          <p class="hint-text">{{ $t("admin.pages.displayConfig.pdaDetailHint") }}</p>
        </template>

        <h2>{{ $t("admin.pages.displayConfig.previewSection") }}</h2>
        <div class="phone-frame">
          <template v-if="isListPage">
            <div class="pv-row">
              <div class="pv-line1">
                <span class="pv-title">{{ pdaPreviewFull.title }}</span>
                <span v-if="pdaPreviewChipText" class="pv-chip">{{ pdaPreviewChipText }}</span>
              </div>
              <div v-for="(line, i) in pdaPreviewFull.meta" :key="i" class="pv-meta">{{ line }}</div>
            </div>
            <div class="pv-row">
              <div class="pv-line1">
                <span class="pv-title">{{ pdaPreviewPartial.title }}</span>
              </div>
              <div v-for="(line, i) in pdaPreviewPartial.meta" :key="i" class="pv-meta">{{ line }}</div>
            </div>
          </template>
          <template v-else>
            <div class="pv-row">
              <div class="pv-line1">
                <span class="pv-title">{{ DETAIL_SAMPLE[detailPage].wcl_item_no }}</span>
              </div>
              <div v-if="detailPreviewMeta" class="pv-meta">{{ detailPreviewMeta }}</div>
            </div>
            <div class="pv-row pv-row--expanded">
              <div
                v-for="field in pdaView[detailPage].expandedFields"
                :key="field"
                class="pv-field"
              >
                <span class="pv-field__label">{{ detailFieldLabel(field) }}</span>
                <span class="pv-field__value">{{ DETAIL_SAMPLE[detailPage][field] ?? "—" }}</span>
              </div>
            </div>
          </template>
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
  margin-bottom: 0.25rem;
}

.form-row label {
  min-width: 10rem;
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

/* Detail field editor: two ordered checkbox columns with up/down ordering. */
.field-editor {
  display: flex;
  gap: 2rem;
  flex-wrap: wrap;
  margin-top: 0.5rem;
}

.field-editor__col {
  min-width: 16rem;
}

.field-editor__col h3 {
  margin: 0 0 0.5rem;
  font-size: 0.875rem;
}

.field-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.125rem 0;
}

.field-item--off {
  color: var(--muted, #666);
}

.field-item label {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.field-item__order {
  display: inline-flex;
  gap: 0.125rem;
}

.order-btn {
  padding: 0 0.375rem;
  line-height: 1.25rem;
}

/* Phone-width live preview of the PDA row. */
.phone-frame {
  max-width: 22rem;
  border: 1px solid var(--border, #d0d7de);
  border-radius: 0.75rem;
  padding: 0.5rem;
  background: #f6f8fa;
}

.pv-row {
  background: #fff;
  border: 1px solid var(--border, #d0d7de);
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.5rem;
}

.pv-row:last-child {
  margin-bottom: 0;
}

.pv-line1 {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.pv-title {
  font-weight: 600;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.pv-chip {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 0.75rem;
  padding: 0.0625rem 0.5rem;
  border-radius: 9999px;
  background: #e7efff;
  color: #2456a6;
}

.pv-meta {
  font-size: 0.8125rem;
  color: var(--muted, #666);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pv-row--expanded {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.pv-field {
  display: flex;
  justify-content: space-between;
  font-size: 0.8125rem;
}

.pv-field__label {
  color: var(--muted, #666);
}
</style>
