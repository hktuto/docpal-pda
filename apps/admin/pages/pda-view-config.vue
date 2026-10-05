<script setup lang="ts">
import type { WritableComputedRef } from "vue";
import type { FlowConfigState } from "~/utils/flowApi";
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

// PDA view editor (spec docs/superpowers/specs/2026-10-04-pda-app-rewrite-design.md):
// the pdaViewConfig flow-config key — per-page PDA view config: list rows
// (title / meta[1-2] / chip) for the six flow lists + stock-search, and the
// row/expanded field allow-lists + default grouping for the
// receiving/picking/put-away detail pages. Supersedes the deprecated
// pdaListTemplates (the backend migrates legacy per-list customizations when a
// list has no pdaViewConfig entry). Every view renders as its own section on
// this page with one shared draft and one save; the backend PUT stores the raw
// body as the whole row, so we merge our key over the stored JSON.

const flow = useFlowApi();
const { t } = useI18n();

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
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const saved = ref(false);

// The full draft view config (defaults until the config loads).
const pdaView = ref<PdaViewConfig>(defaultPdaViewConfig());

// Per-section placeholder target (title/meta1/meta2 — set by focus) and per-
// section input element refs, keyed "<listKey>:<slot>".
type PdaTarget = "title" | "meta1" | "meta2";
const pdaTargets = reactive<Record<PdaViewListKey, PdaTarget>>(
  Object.fromEntries(PDA_VIEW_LIST_KEYS.map((key) => [key, "title"])) as Record<PdaViewListKey, PdaTarget>
);
const pdaInputs = reactive<Record<string, HTMLInputElement | null>>({});
function setPdaInput(listKey: PdaViewListKey, slot: PdaTarget, el: Element | null) {
  pdaInputs[`${listKey}:${slot}`] = (el as HTMLInputElement | null) ?? null;
}

// Meta line two-way bindings per list: meta[0] always exists (validated
// non-empty); meta[1] is optional — clearing it drops the second line.
const metaDrafts = Object.fromEntries(
  PDA_VIEW_LIST_KEYS.map((key) => [
    key,
    [
      computed({
        get: () => pdaView.value.lists[key].meta[0] ?? "",
        set: (v: string) => {
          const second = pdaView.value.lists[key].meta[1];
          pdaView.value.lists[key].meta = second !== undefined ? [v, second] : [v];
        },
      }),
      computed({
        get: () => pdaView.value.lists[key].meta[1] ?? "",
        set: (v: string) => {
          const first = pdaView.value.lists[key].meta[0] ?? "";
          pdaView.value.lists[key].meta = v.trim() !== "" ? [first, v] : [first];
        },
      }),
    ],
  ])
) as Record<PdaViewListKey, [WritableComputedRef<string>, WritableComputedRef<string>]>;

function pdaPlaceholders(listKey: PdaViewListKey): string[] {
  return Object.keys(PDA_LIST_FIELDS[listKey]);
}

// Live list previews per section through the current draft (phone-width
// frames below): a full row and one with only the primary id (shows the
// empty-placeholder behavior).
function listPreview(listKey: PdaViewListKey) {
  const view = defaultPdaViewConfig();
  view.lists[listKey] = { ...pdaView.value.lists[listKey] };
  return {
    full: viewListRow(listKey, PDA_SAMPLE_FULL[listKey] as PdaListRow, view),
    partial: viewListRow(listKey, PDA_SAMPLE_PARTIAL[listKey] as PdaListRow, view),
  };
}

// Chip preview text per list: the sample row's raw field value (status-like
// fields render their code; count fields their number).
function listChipText(listKey: PdaViewListKey): string {
  const chip = pdaView.value.lists[listKey].chip;
  if (!chip || chip === "none") return "";
  const spec = PDA_LIST_FIELDS[listKey][chip];
  const sample = PDA_SAMPLE_FULL[listKey] as PdaListRow;
  const value = spec ? sample[spec.field] : undefined;
  return value === undefined || value === null || value === "" ? chip : String(value);
}

// Detail preview: collapsed meta = non-identity row fields, rendered from the
// sample item.
function detailFieldLabel(field: string): string {
  return t(`admin.pages.pdaViewConfig.detailFieldLabels.${field}`);
}
function detailPreviewMeta(page: PdaDetailPageKey): string {
  return pdaView.value[page].itemFields
    .filter((f) => !IDENTITY_DETAIL_FIELDS.has(f))
    .map((f) => `${detailFieldLabel(f)}: ${DETAIL_SAMPLE[page][f] ?? "—"}`)
    .join(" · ");
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    state.value = await flow.getFlowConfig();
    // Pre-fill from the stored pdaViewConfig overrides, with the legacy
    // pdaListTemplates migration fallback per list (mirrors the backend).
    pdaView.value = resolvePdaViewConfig(state.value.config.pdaViewConfig, state.value.config.pdaListTemplates);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

// Placeholder chips insert into the focused input of THAT section.
function insertPdaPlaceholder(listKey: PdaViewListKey, name: string) {
  const token = `[${name}]`;
  const target = pdaTargets[listKey];
  const el = pdaInputs[`${listKey}:${target}`] ?? null;
  const draft = pdaView.value.lists[listKey];
  const binding = target === "meta1" ? metaDrafts[listKey][0] : target === "meta2" ? metaDrafts[listKey][1] : null;
  const text = target === "title" ? draft.title : binding!.value;
  const start = el?.selectionStart ?? text.length;
  const end = el?.selectionEnd ?? start;
  const next = text.slice(0, start) + token + text.slice(end);
  if (target === "title") draft.title = next;
  else binding!.value = next;
  if (el) {
    nextTick(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }
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
  // The backend validates the same rules (400) — catch them early.
  for (const key of PDA_VIEW_LIST_KEYS) {
    const l = pdaView.value.lists[key];
    if (l.title.trim() === "" || l.meta.length < 1 || l.meta.length > 2 || l.meta.some((m) => m.trim() === "")) {
      error.value = t("admin.pages.pdaViewConfig.templateInvalid");
      return;
    }
  }
  for (const page of PDA_DETAIL_PAGE_KEYS) {
    if (pdaView.value[page].itemFields.length === 0 || pdaView.value[page].expandedFields.length === 0) {
      error.value = t("admin.pages.pdaViewConfig.templateInvalid");
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
      <h1>{{ $t("admin.pages.pdaViewConfig.title") }}</h1>
    </div>

    <p v-if="loading">{{ $t("admin.common.loading") }}</p>
    <template v-else-if="state">
      <div v-if="state.envOverride" class="warn-banner">
        {{ $t("admin.pages.pdaViewConfig.envOverrideWarning") }}
      </div>

      <h2 class="group-head">{{ $t("admin.pages.pdaViewConfig.listPages") }}</h2>

      <div v-for="listKey in PDA_VIEW_LIST_KEYS" :key="listKey" class="card form-card">
        <h2>{{ $t(`admin.pages.pdaViewConfig.pages.${PDA_LIST_PAGE_I18N[listKey]}`) }}</h2>
        <div class="form-row">
          <label :for="`pda-title-${listKey}`">{{ $t("admin.pages.pdaViewConfig.pdaTitle") }}</label>
          <input
            :id="`pda-title-${listKey}`"
            :ref="(el) => setPdaInput(listKey, 'title', el as Element | null)"
            v-model="pdaView.lists[listKey].title"
            type="text"
            class="template-input"
            @focus="pdaTargets[listKey] = 'title'"
          />
        </div>
        <div class="form-row">
          <label :for="`pda-meta1-${listKey}`">{{ $t("admin.pages.pdaViewConfig.pdaMeta1") }}</label>
          <input
            :id="`pda-meta1-${listKey}`"
            :ref="(el) => setPdaInput(listKey, 'meta1', el as Element | null)"
            v-model="metaDrafts[listKey][0].value"
            type="text"
            class="template-input"
            @focus="pdaTargets[listKey] = 'meta1'"
          />
        </div>
        <div class="form-row">
          <label :for="`pda-meta2-${listKey}`">{{ $t("admin.pages.pdaViewConfig.pdaMeta2") }}</label>
          <input
            :id="`pda-meta2-${listKey}`"
            :ref="(el) => setPdaInput(listKey, 'meta2', el as Element | null)"
            v-model="metaDrafts[listKey][1].value"
            type="text"
            class="template-input"
            @focus="pdaTargets[listKey] = 'meta2'"
          />
        </div>
        <div class="form-row">
          <label :for="`pda-chip-${listKey}`">{{ $t("admin.pages.pdaViewConfig.pdaChip") }}</label>
          <select :id="`pda-chip-${listKey}`" v-model="pdaView.lists[listKey].chip" class="pda-list-select">
            <option v-for="c in PDA_LIST_CHIP_FIELDS[listKey]" :key="c" :value="c">
              {{ $t(`admin.pages.pdaViewConfig.pdaChipLabels.${c}`) }}
            </option>
          </select>
        </div>
        <div class="chip-row">
          <button
            v-for="p in pdaPlaceholders(listKey)"
            :key="p"
            type="button"
            class="btn chip"
            :title="$t(`admin.pages.pdaViewConfig.pdaFieldLabels.${p}`)"
            @click="insertPdaPlaceholder(listKey, p)"
          >
            [{{ p }}]
          </button>
        </div>
        <p class="hint-text">{{ $t("admin.pages.pdaViewConfig.pdaHint") }}</p>

        <h3 class="preview-head">{{ $t("admin.pages.pdaViewConfig.previewSection") }}</h3>
        <div class="phone-frame">
          <div class="pv-row">
            <div class="pv-line1">
              <span class="pv-title">{{ listPreview(listKey).full.title }}</span>
              <span v-if="listChipText(listKey)" class="pv-chip">{{ listChipText(listKey) }}</span>
            </div>
            <div v-for="(line, i) in listPreview(listKey).full.meta" :key="i" class="pv-meta">{{ line }}</div>
          </div>
          <div class="pv-row">
            <div class="pv-line1">
              <span class="pv-title">{{ listPreview(listKey).partial.title }}</span>
            </div>
            <div v-for="(line, i) in listPreview(listKey).partial.meta" :key="i" class="pv-meta">{{ line }}</div>
          </div>
        </div>
      </div>

      <h2 class="group-head">{{ $t("admin.pages.pdaViewConfig.detailPages") }}</h2>

      <div v-for="detailPage in PDA_DETAIL_PAGE_KEYS" :key="detailPage" class="card form-card">
        <h2>{{ $t(`admin.pages.pdaViewConfig.pages.${PDA_DETAIL_PAGE_I18N[detailPage]}`) }}</h2>
        <div v-if="detailPage === 'receivingDetail'" class="form-row">
          <label for="pda-grouping">{{ $t("admin.pages.pdaViewConfig.pdaGrouping") }}</label>
          <select id="pda-grouping" v-model="pdaView.receivingDetail.defaultGrouping" class="pda-list-select">
            <option v-for="g in PDA_DETAIL_GROUPINGS" :key="g" :value="g">
              {{ $t(`admin.pages.pdaViewConfig.pdaGroupingOptions.${g}`) }}
            </option>
          </select>
        </div>

        <div class="field-editor">
          <div class="field-editor__col">
            <h3>{{ $t("admin.pages.pdaViewConfig.pdaRowFields") }}</h3>
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
                <button type="button" class="btn order-btn" :aria-label="$t('admin.pages.pdaViewConfig.moveUp')" @click="moveField(detailPage, 'itemFields', field, -1)">↑</button>
                <button type="button" class="btn order-btn" :aria-label="$t('admin.pages.pdaViewConfig.moveDown')" @click="moveField(detailPage, 'itemFields', field, 1)">↓</button>
              </span>
            </div>
            <div
              v-for="field in PDA_DETAIL_FIELDS[detailPage].filter((f) => !isFieldSelected(detailPage, 'itemFields', f))"
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
            <h3>{{ $t("admin.pages.pdaViewConfig.pdaExpandedFields") }}</h3>
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
                <button type="button" class="btn order-btn" :aria-label="$t('admin.pages.pdaViewConfig.moveUp')" @click="moveField(detailPage, 'expandedFields', field, -1)">↑</button>
                <button type="button" class="btn order-btn" :aria-label="$t('admin.pages.pdaViewConfig.moveDown')" @click="moveField(detailPage, 'expandedFields', field, 1)">↓</button>
              </span>
            </div>
            <div
              v-for="field in PDA_DETAIL_FIELDS[detailPage].filter((f) => !isFieldSelected(detailPage, 'expandedFields', f))"
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
        <p class="hint-text">{{ $t("admin.pages.pdaViewConfig.pdaDetailHint") }}</p>

        <h3 class="preview-head">{{ $t("admin.pages.pdaViewConfig.previewSection") }}</h3>
        <div class="phone-frame">
          <div class="pv-row">
            <div class="pv-line1">
              <span class="pv-title">{{ DETAIL_SAMPLE[detailPage].wcl_item_no }}</span>
            </div>
            <div v-if="detailPreviewMeta(detailPage)" class="pv-meta">{{ detailPreviewMeta(detailPage) }}</div>
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
        </div>
      </div>

      <div class="actions-row">
        <button class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? $t("admin.common.saving") : $t("admin.common.save") }}
        </button>
        <span v-if="saved" class="ok-text">{{ $t("admin.pages.pdaViewConfig.saved") }}</span>
        <span v-if="error" class="error-text">{{ error }}</span>
      </div>
    </template>
    <p v-else class="error-text">{{ error }}</p>
  </div>
</template>

<style scoped>
.group-head {
  margin: 1.25rem 0 0.75rem;
  font-size: 1.05rem;
}

.form-card {
  margin-bottom: 1rem;
}

.form-card h2 {
  margin: 0 0 0.75rem;
  font-size: 1rem;
}

.form-row + .chip-row {
  margin-top: 0.5rem;
}

.preview-head {
  margin: 1.25rem 0 0.5rem;
  font-size: 0.875rem;
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
