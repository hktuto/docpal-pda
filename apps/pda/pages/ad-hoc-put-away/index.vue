<template>
  <div>
    <EmptyState v-if="loading">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else>
      <!-- Supplier selection -->
      <section class="section">
        <label class="section__label" for="supplier-select">{{ $t('adHocPutAway.supplier') }}</label>
        <select
          id="supplier-select"
          v-model="selectedSupplier"
          class="section__select"
          :disabled="committing"
        >
          <option value="">{{ $t('adHocPutAway.supplierPlaceholder') }}</option>
          <option v-for="s in suppliers" :key="s.code" :value="s.code">
            {{ s.name || s.code }}
          </option>
        </select>
      </section>

      <!-- Location selector -->
      <section class="section">
        <label class="section__label" for="location-select">{{ $t('adHocPutAway.location') }}</label>
        <select
          id="location-select"
          v-model="selectedLocation"
          class="section__select"
          :disabled="committing"
        >
          <option value="">{{ $t('adHocPutAway.locationPlaceholder') }}</option>
          <option
            v-for="loc in locations"
            :key="`${loc.orgId}:${loc.subInventoryCode}`"
            :value="`${loc.orgId}:${loc.subInventoryCode}`"
          >
            {{ loc.orgId }} / {{ loc.subInventoryCode }}
          </option>
        </select>
      </section>

      <!-- Shelf selection -->
      <section class="section">
        <label class="section__label" for="shelf-select">{{ $t('adHocPutAway.shelf') }}</label>
        <select
          id="shelf-select"
          v-model="selectedShelf"
          class="section__select"
          :disabled="committing"
        >
          <option value="">{{ $t('adHocPutAway.shelfPlaceholder') }}</option>
          <option v-for="s in shelves" :key="s.code" :value="s.code">
            {{ s.code }}
          </option>
        </select>
      </section>

      <!-- Scan section -->
      <section v-if="selectedSupplier" class="section">
        <div class="scan-row">
          <button
            type="button"
            class="btn btn--primary"
            :disabled="!selectedSupplier || committing"
            @click="openScan"
          >
            {{ $t('adHocPutAway.scan') }}
          </button>
          <span v-if="items.length" class="scan-count">
            {{ $t('adHocPutAway.itemCount', { count: items.length, qty: totalQty }) }}
          </span>
        </div>
      </section>

      <!-- Item list -->
      <section v-if="items.length" class="section">
        <div class="section__header">
          <h3 class="section__title">{{ $t('adHocPutAway.items') }}</h3>
          <div class="batch-actions">
            <input
              v-model="batchDateCode"
              type="text"
              class="batch-input"
              :placeholder="$t('adHocPutAway.dateCode')"
              :disabled="committing"
            />
            <input
              v-model="batchLotCode"
              type="text"
              class="batch-input"
              :placeholder="$t('adHocPutAway.lotCode')"
              :disabled="committing"
            />
            <button
              type="button"
              class="btn btn--secondary"
              :disabled="committing"
              @click="applyBatch"
            >
              {{ $t('adHocPutAway.applyBatch') }}
            </button>
          </div>
        </div>

        <div class="item-list">
          <div v-for="(item, idx) in items" :key="idx" class="item-card">
            <div class="item-card__main">
              <span class="item-card__part">{{ item.partNo }}</span>
              <span class="item-card__qty">{{ item.qty }} pcs</span>
            </div>
            <div class="item-card__meta">
              <span v-if="item.dateCode">{{ $t('adHocPutAway.dateCode') }}: {{ item.dateCode }}</span>
              <span v-if="item.lotCode">{{ $t('adHocPutAway.lotCode') }}: {{ item.lotCode }}</span>
              <span v-if="item.coo">COO: {{ item.coo }}</span>
            </div>
            <div class="item-card__actions">
              <input
                v-model="item.dateCode"
                type="text"
                class="item-input"
                :placeholder="$t('adHocPutAway.dateCode')"
                :disabled="committing"
              />
              <input
                v-model="item.lotCode"
                type="text"
                class="item-input"
                :placeholder="$t('adHocPutAway.lotCode')"
                :disabled="committing"
              />
              <button
                type="button"
                class="btn btn--danger btn--small"
                :disabled="committing"
                @click="removeItem(idx)"
              >
                ×
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- Confirm -->
      <section v-if="items.length && selectedShelf" class="section">
        <button
          type="button"
          class="btn btn--primary btn--large"
          :disabled="committing"
          @click="confirmCommit"
        >
          {{ $t('adHocPutAway.confirm', { count: items.length, qty: totalQty, shelf: selectedShelf }) }}
        </button>
      </section>

      </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useWarehouse } from "~/composables/useWarehouse";
import { useToast } from "~/composables/useToast";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { useSupplierSymbologyScope } from "~/composables/useScannerConfig";
import { I18nError } from "~/composables/i18nError";
import { parseQrCapture, parseAndIdentify } from "~/utils/parseOcrScan";
import { captureLabel, getCachedSupplierQrTemplates } from "~/composables/useLabelScan";
import { playScanError, playScanSuccess } from "~/utils/scanBeep";
import type { AdHocPutAwayItem, Shelf, SupplierListRow } from "~/services/types";

definePageMeta({ title: "meta.adHocPutAway" });

const { t } = useI18n();
const warehouse = useWarehouse();
const { showToast } = useToast();
const errorMessage = useErrorMessage();

const loading = ref(true);
const error = ref<string | null>(null);
const suppliers = ref<SupplierListRow[]>([]);
const shelves = ref<Shelf[]>([]);
const locations = ref<{ orgId: number; subInventoryCode: string }[]>([]);
const selectedSupplier = ref("");
const selectedLocation = ref("");
const selectedShelf = ref("");
const items = ref<AdHocPutAwayItem[]>([]);
const batchDateCode = ref("");
const batchLotCode = ref("");
const committing = ref(false);

// Scanner setup — useHardwareScanner manages its own lifecycle
useHardwareScanner({
  onScan: handleHardwareScan,
});

// Supplier symbology scope — watches selectedSupplier internally
useSupplierSymbologyScope(selectedSupplier, { withShelfCodes: true });

const totalQty = computed(() => items.value.reduce((sum, i) => sum + i.qty, 0));

// Load initial data
async function load() {
  try {
    loading.value = true;
    error.value = null;
    const [sups, shs, locs] = await Promise.all([
      warehouse.getSuppliers(),
      warehouse.getShelves(),
      warehouse.getAdHocPutAwayLocations(),
    ]);
    suppliers.value = sups;
    shelves.value = shs;
    locations.value = locs;
  } catch (err) {
    error.value = err instanceof Error ? err.message : "unknown error";
  } finally {
    loading.value = false;
  }
}

load();

// Hardware scan handler
async function handleHardwareScan(code: string) {
  // Check if it's a shelf code
  const shelf = shelves.value.find((s) => s.code === code);
  if (shelf) {
    selectedShelf.value = code;
    showToast(t("adHocPutAway.shelfSelected", { shelf: code }));
    return;
  }

  // Parse as item label via supplier QR template
  const templates = await getCachedSupplierQrTemplates(warehouse);
  const result = parseQrCapture(code, {
    supplierTemplates: templates,
    contextSupplierCode: selectedSupplier.value,
  });
  if (result.matched) {
    addItem({
      partNo: result.parsed.itemId ?? "",
      wclItemNo: result.parsed.wclItemNo ?? null,
      qty: result.parsed.qty ?? 1,
      dateCode: result.parsed.dateCode ?? null,
      lotCode: result.parsed.lotCode ?? null,
      coo: result.parsed.coo ?? null,
      cow: result.parsed.cow ?? null,
      serialNo: result.parsed.serialNo ?? null,
      orgId: 0,
      subInventoryCode: "",
    });
    playScanSuccess();
  } else {
    playScanError();
    showToast(t("adHocPutAway.scanError"));
  }
}

// OCR capture handler
async function openScan() {
  const capture = await captureLabel();
  if (!capture) return;
  const result = parseAndIdentify(
    { text: capture.text, barcodes: JSON.parse(capture.barcodes || "[]") },
    []
  );
  if (result.matched) {
    addItem({
      partNo: result.parsed.itemId ?? "",
      wclItemNo: result.parsed.wclItemNo ?? null,
      qty: result.parsed.qty ?? 1,
      dateCode: result.parsed.dateCode ?? null,
      lotCode: result.parsed.lotCode ?? null,
      coo: result.parsed.coo ?? null,
      cow: result.parsed.cow ?? null,
      serialNo: result.parsed.serialNo ?? null,
      orgId: 0,
      subInventoryCode: "",
    });
    playScanSuccess();
  } else {
    playScanError();
    showToast(t("adHocPutAway.scanError"));
  }
}

function addItem(item: AdHocPutAwayItem) {
  // Apply current location if set
  if (selectedLocation.value) {
    const [orgId, subInventoryCode] = selectedLocation.value.split(":");
    item.orgId = Number(orgId);
    item.subInventoryCode = subInventoryCode;
  }
  // Default date code to today's WWYY if not set
  if (!item.dateCode) {
    item.dateCode = getTodayDateCode();
  }
  items.value.push(item);
}

function getTodayDateCode(): string {
  const now = new Date();
  const year = now.getFullYear() % 100;
  const week = getWeekNumber(now);
  return `${String(year).padStart(2, "0")}${String(week).padStart(2, "0")}`;
}

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function removeItem(idx: number) {
  items.value.splice(idx, 1);
}

function applyBatch() {
  if (!batchDateCode.value && !batchLotCode.value) return;
  for (const item of items.value) {
    if (batchDateCode.value) item.dateCode = batchDateCode.value;
    if (batchLotCode.value) item.lotCode = batchLotCode.value;
  }
  batchDateCode.value = "";
  batchLotCode.value = "";
  showToast(t("adHocPutAway.batchApplied"));
}

async function confirmCommit() {
  if (!selectedSupplier.value || !selectedShelf.value || !items.value.length) return;

  // Apply location to items that don't have one
  const loc = selectedLocation.value;
  if (loc) {
    const [orgId, subInventoryCode] = loc.split(":");
    for (const item of items.value) {
      if (!item.orgId) {
        item.orgId = Number(orgId);
        item.subInventoryCode = subInventoryCode;
      }
    }
  }

  // Validate all items have location
  const missingLoc = items.value.find((i) => !i.orgId || !i.subInventoryCode);
  if (missingLoc) {
    showToast(t("adHocPutAway.locationRequired"));
    return;
  }

  try {
    committing.value = true;
    await warehouse.commitAdHocPutAway({
      supplierCode: selectedSupplier.value,
      shelfCode: selectedShelf.value,
      items: items.value,
    });
    showToast(t("adHocPutAway.success", { count: items.value.length, shelf: selectedShelf.value }));
    items.value = [];
    selectedShelf.value = "";
  } catch (err) {
    const msg = err instanceof I18nError ? err.message : (err instanceof Error ? err.message : "unknown error");
    showToast(t("adHocPutAway.commitError", { message: msg }));
  } finally {
    committing.value = false;
  }
}
</script>

<style scoped>
.section {
  margin-bottom: 1rem;
}

.section__label {
  display: block;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 0.25rem;
}

.section__select {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 1rem;
  background: var(--surface);
  color: var(--text);
}

.section__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.section__title {
  font-size: 1rem;
  font-weight: 700;
  margin: 0;
}

.batch-actions {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}

.batch-input {
  width: 5rem;
  padding: 0.25rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.875rem;
}

.scan-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.scan-count {
  font-size: 0.875rem;
  color: var(--muted);
}

.item-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.item-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem;
}

.item-card__main {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.25rem;
}

.item-card__part {
  font-weight: 600;
  font-size: 1rem;
}

.item-card__qty {
  color: var(--muted);
  font-size: 0.875rem;
}

.item-card__meta {
  display: flex;
  gap: 0.75rem;
  font-size: 0.8125rem;
  color: var(--muted);
  margin-bottom: 0.5rem;
}

.item-card__actions {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}

.item-input {
  width: 5rem;
  padding: 0.25rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.875rem;
}

.btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: var(--radius);
  font-size: 0.9375rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s ease;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn--primary {
  background: var(--primary);
  color: white;
}

.btn--secondary {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
}

.btn--danger {
  background: #ef4444;
  color: white;
}

.btn--small {
  padding: 0.25rem 0.5rem;
  font-size: 0.875rem;
}

.btn--large {
  width: 100%;
  padding: 0.75rem;
  font-size: 1rem;
}
</style>
