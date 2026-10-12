<template>
  <div>
    <EmptyState v-if="loading">{{ $t("common.loading") }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t("common.errorPrefix", { message: error }) }}</EmptyState>

    <template v-else>
      <!-- Source shelf banner -->
      <section class="section">
        <template v-if="sourceShelf">
          <div class="shelf-exchange__banner">
            <div>
              <p class="section__label">{{ $t("shelfExchange.sourceShelf") }}</p>
              <p class="shelf-exchange__banner-code">{{ sourceShelf }}</p>
            </div>
            <button
              type="button"
              class="btn"
              :disabled="previewing || committing"
              @click="clearSource"
            >
              {{ $t("shelfExchange.clear") }}
            </button>
          </div>
        </template>
        <template v-else>
          <p class="section__label">{{ $t("shelfExchange.stepSource") }}</p>
        </template>
      </section>

      <!-- Matched lot (step complete) -->
      <section v-if="preview" class="section">
        <p class="section__label">{{ $t("shelfExchange.matchedItem") }}</p>
        <div class="shelf-exchange__card">
          <div class="shelf-exchange__row">
            <span>{{ $t("shelfExchange.fields.partNo") }}</span>
            <strong>{{ preview.partNo }}</strong>
          </div>
          <div v-if="preview.wclItemNo" class="shelf-exchange__row">
            <span>{{ $t("shelfExchange.fields.wclItemNo") }}</span>
            <strong>{{ preview.wclItemNo }}</strong>
          </div>
          <div v-if="preview.dateCode" class="shelf-exchange__row">
            <span>{{ $t("shelfExchange.fields.dateCode") }}</span>
            <strong>{{ preview.dateCode }}</strong>
          </div>
          <div v-if="preview.lotCode" class="shelf-exchange__row">
            <span>{{ $t("shelfExchange.fields.lotCode") }}</span>
            <strong>{{ preview.lotCode }}</strong>
          </div>
          <div v-if="preview.coo" class="shelf-exchange__row">
            <span>{{ $t("shelfExchange.fields.coo") }}</span>
            <strong>{{ preview.coo }}</strong>
          </div>
          <div v-if="preview.cow" class="shelf-exchange__row">
            <span>{{ $t("shelfExchange.fields.cow") }}</span>
            <strong>{{ preview.cow }}</strong>
          </div>
          <div class="shelf-exchange__row">
            <span>{{ $t("shelfExchange.fields.qty") }}</span>
            <strong>{{ preview.qty }}</strong>
          </div>
          <div class="shelf-exchange__row">
            <span>{{ $t("shelfExchange.fields.available") }}</span>
            <strong>{{ preview.availableQty }}</strong>
          </div>
        </div>
      </section>

      <!-- Target shelf -->
      <section class="section">
        <template v-if="preview && !targetShelf">
          <p class="section__label">{{ $t("shelfExchange.stepTarget") }}</p>
        </template>
        <template v-else-if="targetShelf">
          <div class="shelf-exchange__banner">
            <div>
              <p class="section__label">{{ $t("shelfExchange.targetShelf") }}</p>
              <p class="shelf-exchange__banner-code">{{ targetShelf }}</p>
            </div>
            <button type="button" class="btn" :disabled="committing" @click="targetShelf = ''">
              {{ $t("shelfExchange.clear") }}
            </button>
          </div>
        </template>
        <template v-else>
          <p class="section__label">{{ $t("shelfExchange.stepItem") }}</p>
        </template>
      </section>
    </template>

    <ScanFab :loading="previewing || committing" @click="openScan" />

    <ShelfExchangeConfirmModal
      :preview="confirmPreview"
      :committing="committing"
      @confirm="confirm"
      @cancel="cancelConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useWarehouse } from "~/composables/useWarehouse";
import { useToast } from "~/composables/useToast";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { useBrandSymbologyScope } from "~/composables/useScannerConfig";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { I18nError } from "~/composables/i18nError";
import { parseQrCapture, parseAndIdentify } from "~/utils/parseOcrScan";
import { captureLabel, getCachedSupplierQrTemplates } from "~/composables/useLabelScan";
import { playScanError, playScanSuccess } from "~/utils/scanBeep";
import ScanFab from "~/components/ScanFab.vue";
import ShelfExchangeConfirmModal from "~/components/ShelfExchangeConfirmModal.vue";
import type { Shelf, ShelfExchangePreview } from "~/services/types";

// Shelf exchange (spec 2026-10-12-shelf-exchange-design.md): scan-driven
// shelf→shelf stock move. Step state machine — source shelf (banner) →
// item label (preview resolves the source lot server-side) → target shelf
// (confirm dialog opens) → commit.
definePageMeta({ title: "meta.shelfExchange" });

const { t } = useI18n();
const warehouse = useWarehouse();
const { showToast } = useToast();

const loading = ref(true);
const error = ref<string | null>(null);
const shelves = ref<Shelf[]>([]);
const sourceShelf = ref("");
const preview = ref<ShelfExchangePreview | null>(null);
const targetShelf = ref("");
const previewing = ref(false);
const committing = ref(false);
const confirmPreview = ref<
  (ShelfExchangePreview & { sourceShelfCode: string; targetShelfCode: string }) | null
>(null);

// Scanner setup — useHardwareScanner manages its own lifecycle and beeps:
// the handler returns false on a rejected scan (error buzz), true otherwise
// (success beep). Scanning is disabled while the confirm dialog is open.
useHardwareScanner({
  enabled: () => !confirmPreview.value && !committing.value,
  onScan: handleHardwareScan,
});

// No supplier/brand context exists on this page → no symbology whitelist
// applied; shelf QRs must stay decodable (withShelfCodes).
useBrandSymbologyScope(computed(() => []), { withShelfCodes: true });

async function load() {
  try {
    loading.value = true;
    error.value = null;
    shelves.value = await warehouse.getShelves();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "unknown error";
  } finally {
    loading.value = false;
  }
}

useVisibleReload(load);
load();

function findShelf(code: string): Shelf | undefined {
  return shelves.value.find((s) => s.code.toUpperCase() === code.toUpperCase());
}

function clearSource() {
  sourceShelf.value = "";
  preview.value = null;
  targetShelf.value = "";
  confirmPreview.value = null;
}

// Hardware scan handler — routed by the step state machine. Returns false on
// a rejected scan so useHardwareScanner plays the error buzz (and true for
// the success beep); the camera path beeps explicitly instead.
async function handleHardwareScan(code: string) {
  const shelf = findShelf(code);
  if (shelf) {
    if (preview.value) {
      // Item matched — this scan is the target shelf.
      if (shelf.code === sourceShelf.value) {
        showToast(t("shelfExchange.errors.same_shelf"));
        return false;
      }
      targetShelf.value = shelf.code;
      openConfirm();
      return true;
    }
    // Awaiting the item — (re)set the source shelf.
    sourceShelf.value = shelf.code;
    showToast(t("shelfExchange.sourceSelected", { shelf: shelf.code }));
    return true;
  }

  // Not a shelf → item label scan. Requires a source shelf first.
  if (!sourceShelf.value) {
    showToast(t("shelfExchange.errors.scanSourceFirst"));
    return false;
  }

  const templates = await getCachedSupplierQrTemplates(warehouse);
  const result = parseQrCapture(code, { supplierTemplates: templates });
  if (!result.matched) {
    showToast(t("shelfExchange.errors.scanParse"));
    return false;
  }
  return previewItem({
    partNo: result.parsed.itemId ?? "",
    wclItemNo: result.parsed.wclItemNo ?? null,
    qty: result.parsed.qty ?? 1,
    dateCode: result.parsed.dateCode ?? null,
    lotCode: result.parsed.lotCode ?? null,
    coo: result.parsed.coo ?? null,
    cow: result.parsed.cow ?? null,
  });
}

// Camera capture — same parse path as the hardware scan (QR-only captures go
// through the supplier templates; other captures fall back to generic parsing).
async function openScan() {
  if (!sourceShelf.value) {
    playScanError();
    showToast(t("shelfExchange.errors.scanSourceFirst"));
    return;
  }
  const capture = await captureLabel();
  if (!capture) return;
  const barcodes = JSON.parse(capture.barcodes || "[]");
  const templates = await getCachedSupplierQrTemplates(warehouse);

  const isQrOnly = barcodes.length === 1 && barcodes[0].format === "4" && !capture.imagePath;
  const result = isQrOnly
    ? parseQrCapture(barcodes[0].value, { supplierTemplates: templates })
    : parseAndIdentify({ text: capture.text, barcodes }, []);

  if (!result.matched) {
    playScanError();
    showToast(t("shelfExchange.errors.scanParse"));
    return;
  }
  const ok = await previewItem({
    partNo: result.parsed.itemId ?? "",
    wclItemNo: result.parsed.wclItemNo ?? null,
    qty: result.parsed.qty ?? 1,
    dateCode: result.parsed.dateCode ?? null,
    lotCode: result.parsed.lotCode ?? null,
    coo: result.parsed.coo ?? null,
    cow: result.parsed.cow ?? null,
  });
  if (ok) playScanSuccess();
  else playScanError();
}

// Resolve + validate the source lot server-side (step 3 feedback: 409s surface
// here, before the target shelf is scanned). Returns success — the caller
// owns the beep (hardware path: the scanner composable; camera path: below).
async function previewItem(label: {
  partNo: string;
  wclItemNo: string | null;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
}): Promise<boolean> {
  previewing.value = true;
  try {
    preview.value = await warehouse.previewShelfExchange({
      sourceShelfCode: sourceShelf.value,
      ...label,
    });
    showToast(t("shelfExchange.itemMatched", { partNo: preview.value.partNo }));
    return true;
  } catch (err) {
    preview.value = null;
    targetShelf.value = "";
    showToast(toastMessage(err));
    return false;
  } finally {
    previewing.value = false;
  }
}

function openConfirm() {
  if (!preview.value || !targetShelf.value) return;
  confirmPreview.value = {
    ...preview.value,
    sourceShelfCode: sourceShelf.value,
    targetShelfCode: targetShelf.value,
  };
}

// Cancel closes the dialog; the matched item stays so a mis-scanned target
// can be retried without rescanning the label.
function cancelConfirm() {
  confirmPreview.value = null;
  targetShelf.value = "";
}

async function confirm() {
  if (!preview.value || !targetShelf.value) return;
  committing.value = true;
  try {
    await warehouse.commitShelfExchange({
      sourceShelfCode: sourceShelf.value,
      targetShelfCode: targetShelf.value,
      lotId: preview.value.lotId,
      qty: preview.value.qty,
    });
    playScanSuccess();
    showToast(
      t("shelfExchange.moveDone", {
        qty: preview.value.qty,
        partNo: preview.value.partNo,
        shelf: targetShelf.value,
      })
    );
    // Source shelf stays selected for the next item; clear item + target.
    confirmPreview.value = null;
    preview.value = null;
    targetShelf.value = "";
  } catch (err) {
    playScanError();
    showToast(toastMessage(err));
  } finally {
    committing.value = false;
  }
}

// Snake-case backend errors are i18n keys; fall back to the raw message.
function toastMessage(err: unknown): string {
  if (err instanceof I18nError) return t(`shelfExchange.errors.${err.code}`);
  if (err instanceof Error) return err.message;
  return "unknown error";
}
</script>

<style scoped>
.shelf-exchange__banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 1rem;
  background: var(--primary-soft, rgba(37, 99, 235, 0.08));
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.shelf-exchange__banner-code {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 700;
}

.shelf-exchange__card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem 1rem;
  display: grid;
  gap: 0.35rem;
}

.shelf-exchange__row {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}

.shelf-exchange__row span {
  color: var(--text-muted);
}
</style>
