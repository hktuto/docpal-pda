<script setup lang="ts">
import type { PartAvailabilityStockRow, PartMasterRow, PickingOrderItemDraft } from "~/utils/flowApi";

// Add/edit line-item dialog for the test-order creator: brand + part search
// over the server-paged parts master, qty/line inputs, and — at the bottom —
// a read-only inventory check for the selected part (location + available qty).
const props = defineProps<{
  open: boolean;
  /** Row being edited, or null when adding. */
  item: PickingOrderItemDraft | null;
  /** Default line number for a new row (items.length + 1). */
  nextLineNumber: number;
}>();

const emit = defineEmits<{
  close: [];
  save: [item: PickingOrderItemDraft];
}>();

const flow = useFlowApi();
const { t } = useI18n();
const dismiss = useOverlayDismiss(() => emit("close"));

const brandQuery = ref("");
const partQuery = ref("");
const results = ref<PartMasterRow[]>([]);
const searching = ref(false);
const searched = ref(false);
const selected = ref<PartMasterRow | null>(null);
const qty = ref<number | null>(null);
const lineNumber = ref(1);
const error = ref("");

const stock = ref<PartAvailabilityStockRow[]>([]);
const stockLoading = ref(false);

let searchTimer: ReturnType<typeof setTimeout> | null = null;
// Guards the availability fetch against out-of-order responses when the
// selected part changes quickly.
let stockRequest = 0;

function scheduleSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
}

async function runSearch() {
  const q = partQuery.value.trim();
  const brand = brandQuery.value.trim();
  if (!q && !brand) {
    results.value = [];
    searched.value = false;
    return;
  }
  searching.value = true;
  searched.value = true;
  error.value = "";
  try {
    const res = await flow.searchParts({ q, brand, pageSize: 20 });
    results.value = res.rows;
  } catch (e: any) {
    error.value = e?.message ?? t("admin.pages.createTestOrder.errors.searchFailed");
    results.value = [];
  } finally {
    searching.value = false;
  }
}

function pick(row: PartMasterRow) {
  selected.value = row;
  results.value = [];
  searched.value = false;
  partQuery.value = "";
  brandQuery.value = "";
  loadStock(row);
}

function changePart() {
  selected.value = null;
  stock.value = [];
  stockLoading.value = false;
}

async function loadStock(row: PartMasterRow) {
  const request = ++stockRequest;
  stockLoading.value = true;
  stock.value = [];
  error.value = "";
  try {
    const res = await flow.getPartAvailability(row.partNo, row.wclItemNo || null);
    if (request !== stockRequest) return;
    stock.value = res.stock;
  } catch (e: any) {
    if (request !== stockRequest) return;
    error.value = e?.message ?? t("admin.pages.createTestOrder.errors.searchFailed");
  } finally {
    if (request === stockRequest) stockLoading.value = false;
  }
}

// (Re)fill the form each time the dialog opens.
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    error.value = "";
    searching.value = false;
    searched.value = false;
    if (searchTimer) clearTimeout(searchTimer);
    partQuery.value = "";
    brandQuery.value = "";
    results.value = [];
    qty.value = props.item?.qty ?? null;
    lineNumber.value = props.item?.lineNumber ?? props.nextLineNumber;
    if (props.item?.partNo) {
      // Edit mode: prefill the selected part from the draft row (brand and
      // description may be missing on imported rows — the search still works).
      const row: PartMasterRow = {
        id: "",
        partNo: props.item.partNo,
        wclItemNo: props.item.wclItemNo ?? "",
        brand: props.item.brand ?? "",
        description: props.item.description ?? null,
      };
      selected.value = row;
      loadStock(row);
    } else {
      selected.value = null;
      stock.value = [];
      stockLoading.value = false;
      stockRequest++;
    }
  }
);

function submit() {
  if (!selected.value) {
    error.value = t("admin.pages.createTestOrder.errors.partRequired");
    return;
  }
  if (qty.value === null || qty.value <= 0) {
    error.value = t("admin.pages.createTestOrder.errors.qtyInvalid");
    return;
  }
  error.value = "";
  emit("save", {
    partNo: selected.value.partNo,
    wclItemNo: selected.value.wclItemNo || null,
    brand: selected.value.brand || null,
    description: selected.value.description ?? null,
    qty: qty.value,
    lineNumber: lineNumber.value,
  });
}
</script>

<template>
  <div v-if="open" class="overlay" @mousedown="dismiss.onMousedown" @click="dismiss.onClick">
    <div class="dialog item-dialog">
      <h2>
        {{ item ? $t("admin.pages.createTestOrder.editItemTitle") : $t("admin.pages.createTestOrder.addItemTitle") }}
      </h2>
      <div v-if="error" class="error-banner">{{ error }}</div>

      <form @submit.prevent="submit">
        <!-- Part search (hidden while a part is selected) -->
        <template v-if="!selected">
          <div class="search-grid">
            <div class="form-field">
              <label for="ifm-brand">{{ $t("admin.pages.createTestOrder.brand") }}</label>
              <input
                id="ifm-brand"
                v-model="brandQuery"
                type="text"
                :placeholder="$t('admin.pages.createTestOrder.searchBrand')"
                @input="scheduleSearch"
              />
            </div>
            <div class="form-field">
              <label for="ifm-part">{{ $t("admin.pages.createTestOrder.partNo") }}</label>
              <input
                id="ifm-part"
                v-model="partQuery"
                type="text"
                :placeholder="$t('admin.pages.createTestOrder.searchPart')"
                @input="scheduleSearch"
              />
            </div>
          </div>
          <div class="results">
            <div v-if="searching" class="muted">{{ $t("admin.common.loading") }}</div>
            <div v-else-if="results.length > 0" class="result-list">
              <button
                v-for="row in results"
                :key="row.id || row.partNo"
                type="button"
                class="result-row"
                @click="pick(row)"
              >
                <span class="r-part">{{ row.partNo }}</span>
                <span class="r-wcl">{{ row.wclItemNo }}</span>
                <span class="r-brand">{{ row.brand }}</span>
                <span class="r-desc">{{ row.description ?? "" }}</span>
              </button>
            </div>
            <div v-else-if="searched" class="muted">{{ $t("admin.common.noRecords") }}</div>
            <div v-else class="muted">{{ $t("admin.pages.createTestOrder.searchHint") }}</div>
          </div>
        </template>

        <!-- Selected part summary -->
        <div v-else class="selected-part">
          <div class="selected-info">
            <strong>{{ selected.partNo }}</strong>
            <span v-if="selected.wclItemNo"> · {{ selected.wclItemNo }}</span>
            <span v-if="selected.brand"> · {{ selected.brand }}</span>
            <div v-if="selected.description" class="muted">{{ selected.description }}</div>
          </div>
          <button type="button" class="btn btn-small" @click="changePart">
            {{ $t("admin.pages.createTestOrder.changePart") }}
          </button>
        </div>

        <div class="form-row">
          <label for="ifm-qty">{{ $t("admin.pages.createTestOrder.qty") }} *</label>
          <input id="ifm-qty" v-model.number="qty" type="number" min="1" />
        </div>
        <div class="form-row">
          <label for="ifm-line">{{ $t("admin.pages.createTestOrder.line") }}</label>
          <input id="ifm-line" v-model.number="lineNumber" type="number" min="1" />
        </div>

        <!-- Inventory availability for the selected part -->
        <div class="avail-block">
          <h3 class="avail-section">{{ $t("admin.pages.createTestOrder.availability") }}</h3>
          <div v-if="!selected" class="muted">{{ $t("admin.pages.createTestOrder.selectPartHint") }}</div>
          <div v-else-if="stockLoading" class="loading">{{ $t("admin.common.loading") }}</div>
          <table v-else-if="stock.length > 0" class="avail-table">
            <thead>
              <tr>
                <th>{{ $t("admin.pages.shelfBoxes.orgId") }}</th>
                <th>{{ $t("admin.pages.shelfBoxes.subInventory") }}</th>
                <th>{{ $t("stockSearch.shelf") }}</th>
                <th class="num">{{ $t("stockSearch.availableQty") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in stock" :key="s.lotId">
                <td>{{ s.orgId ?? "—" }}</td>
                <td>{{ s.subInventoryCode ?? "—" }}</td>
                <td>{{ s.shelfDisplayName ?? s.shelfCode ?? "—" }}</td>
                <td class="num">{{ s.availableQty }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="muted">{{ $t("admin.pages.pickingOrders.availabilityNoneStock") }}</div>
        </div>

        <div class="dialog-actions">
          <button type="button" class="btn" @click="emit('close')">{{ $t("admin.common.cancel") }}</button>
          <button type="submit" class="btn btn-primary">{{ $t("admin.common.save") }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.item-dialog {
  width: 40rem;
}
.search-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
.form-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.form-field label {
  font-size: 0.75rem;
  font-weight: 500;
  color: #52606d;
}
.form-field input {
  padding: 0.4375rem 0.5625rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  font-size: 0.875rem;
}
.results {
  min-height: 4rem;
  max-height: 12rem;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 0.25rem;
  padding: 0.375rem;
  margin-bottom: 0.75rem;
}
.result-list {
  display: flex;
  flex-direction: column;
}
.result-row {
  display: grid;
  grid-template-columns: minmax(6rem, 1fr) minmax(6rem, 1fr) minmax(4rem, 0.6fr) 2fr;
  gap: 0.5rem;
  align-items: baseline;
  padding: 0.3125rem 0.5rem;
  border: none;
  background: none;
  text-align: left;
  font-size: 0.8125rem;
  cursor: pointer;
  border-radius: 0.1875rem;
}
.result-row:hover {
  background: #eef4f6;
}
.r-part {
  font-weight: 600;
}
.r-wcl,
.r-brand {
  color: #52606d;
}
.r-desc {
  color: #7b8794;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.selected-part {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--border);
  border-radius: 0.25rem;
  margin-bottom: 0.75rem;
  font-size: 0.875rem;
}
.avail-block {
  margin-top: 0.75rem;
}
.avail-section {
  font-size: 0.8125rem;
  font-weight: 600;
  margin: 0 0 0.375rem;
}
</style>
