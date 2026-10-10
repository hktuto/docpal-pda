<template>
  <div>
    <EmptyState v-if="loading">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else>
      <!-- Brand selection -->
      <section class="section">
        <label class="section__label" for="brand-select">{{ $t('adHocPutAway.brand') }}</label>
        <SearchableSelect
          id="brand-select"
          v-model="selectedBrand"
          :options="brands.map((b) => ({ value: b, label: b }))"
          :all-label="$t('adHocPutAway.brandPlaceholder')"
          :aria-label="$t('adHocPutAway.brand')"
          :disabled="committing"
        />
      </section>

      <!-- Location selector -->
      <section class="section">
        <label class="section__label" for="location-select">{{ $t('adHocPutAway.location') }}</label>
        <SearchableSelect
          id="location-select"
          v-model="selectedLocation"
          :options="locations.map((loc) => ({
            value: `${loc.orgId}:${loc.subInventoryCode}`,
            label: loc.label ?? `${loc.orgId} / ${loc.subInventoryCode}`,
          }))"
          :all-label="$t('adHocPutAway.locationPlaceholder')"
          :aria-label="$t('adHocPutAway.location')"
          :disabled="committing"
        />
      </section>

      <!-- Shelf banner (scan-only selection) -->
      <section v-if="selectedShelf" class="section">
        <div class="shelf-banner">
          <span class="shelf-banner__label">{{ $t('adHocPutAway.shelf') }}</span>
          <span class="shelf-banner__code">{{ selectedShelf }}</span>
          <button
            type="button"
            class="shelf-banner__clear"
            :disabled="committing"
            :aria-label="$t('adHocPutAway.shelfClear')"
            @click="selectedShelf = ''"
          >
            ✕
          </button>
        </div>
      </section>

      <!-- Scan FAB -->
      <ScanFab
        v-if="selectedBrand"
        :disabled="!selectedBrand || committing"
        @click="openScan"
      />

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
import { useBrandSymbologyScope } from "~/composables/useScannerConfig";
import { I18nError } from "~/composables/i18nError";
import { parseQrCapture, parseAndIdentify } from "~/utils/parseOcrScan";
import { captureLabel, getCachedSupplierQrTemplates } from "~/composables/useLabelScan";
import { playScanError, playScanSuccess } from "~/utils/scanBeep";
import SearchableSelect from "~/components/SearchableSelect.vue";
import ScanFab from "~/components/ScanFab.vue";
import type { AdHocPutAwayItem, Shelf } from "~/services/types";

definePageMeta({ title: "meta.adHocPutAway" });

const { t } = useI18n();
const warehouse = useWarehouse();
const { showToast } = useToast();
const errorMessage = useErrorMessage();

const loading = ref(true);
const error = ref<string | null>(null);
const brands = ref<string[]>([]);
const shelves = ref<Shelf[]>([]);
const locations = ref<{ orgId: number; subInventoryCode: string }[]>([]);
const selectedBrand = ref("");
const selectedLocation = ref("");
const selectedShelf = ref("");
const items = ref<AdHocPutAwayItem[]>([]);
const batchDateCode = ref("");
const batchLotCode = ref("");
const committing = ref(false);
const seenSerialNos = ref<Set<string>>(new Set());

// Scanner setup — useHardwareScanner manages its own lifecycle
useHardwareScanner({
  onScan: handleHardwareScan,
});

// Brand symbology scope — watches selectedBrand internally
const brandList = computed(() => (selectedBrand.value ? [selectedBrand.value] : []));
useBrandSymbologyScope(brandList, { withShelfCodes: true });

const totalQty = computed(() => items.value.reduce((sum, i) => sum + i.qty, 0));

// Load initial data
async function load() {
  try {
    loading.value = true;
    error.value = null;
    const [brandsList, shs, locs] = await Promise.all([
      warehouse.getAdHocPutAwayBrands(),
      warehouse.getShelves(),
      warehouse.getAdHocPutAwayLocations(),
    ]);
    brands.value = brandsList;
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
    contextBrands: [selectedBrand.value],
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
  const barcodes = JSON.parse(capture.barcodes || "[]");
  const templates = await getCachedSupplierQrTemplates(warehouse);

  // Use supplier QR template parsing for QR-only captures (same as normal
  // put-away); fall back to generic text parsing for non-QR captures.
  const isQrOnly = barcodes.length === 1 && barcodes[0].format === "4" && !capture.imagePath;
  const result = isQrOnly
    ? parseQrCapture(barcodes[0].value, {
        supplierTemplates: templates,
        contextBrands: [selectedBrand.value],
      })
    : parseAndIdentify(
        { text: capture.text, barcodes },
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
  // Reject duplicate serial numbers within the current batch
  if (item.serialNo && seenSerialNos.value.has(item.serialNo)) {
    playScanError();
    showToast(t("adHocPutAway.duplicateSerial", { serialNo: item.serialNo }));
    return;
  }
  if (item.serialNo) {
    seenSerialNos.value.add(item.serialNo);
  }
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
  const [removed] = items.value.splice(idx, 1);
  if (removed?.serialNo) {
    seenSerialNos.value.delete(removed.serialNo);
  }
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
  if (!selectedBrand.value || !selectedShelf.value || !items.value.length) return;

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
      brand: selectedBrand.value,
      shelfCode: selectedShelf.value,
      items: items.value,
    });
    showToast(t("adHocPutAway.success", { count: items.value.length, shelf: selectedShelf.value }));
    items.value = [];
    seenSerialNos.value.clear();
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

.shelf-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--primary);
  color: white;
  border-radius: var(--radius);
  font-size: 0.9375rem;
}

.shelf-banner__label {
  font-weight: 600;
  opacity: 0.9;
}

.shelf-banner__code {
  font-weight: 700;
  font-size: 1rem;
  flex: 1;
}

.shelf-banner__clear {
  background: rgba(255, 255, 255, 0.2);
  border: none;
  color: white;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 50%;
  font-size: 0.875rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.shelf-banner__clear:hover {
  background: rgba(255, 255, 255, 0.35);
}

.shelf-banner__clear:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
