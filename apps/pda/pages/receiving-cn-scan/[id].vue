<script setup lang="ts">
import { captureLabel, captureRawLabelValue } from "~/composables/useLabelScan";
import { playScanError, playScanSuccess } from "~/utils/scanBeep";
import { findCnScanMatches } from "~/utils/cnReceivingScan";
import { formatCompactQtyUpper } from "~/utils/formatNumber";
import type { ParsedFields } from "~/utils/parseOcrScan";
import type {
  CnFlagItemInput,
  CnScanReason,
  CnScanTaskDetail,
  CnScanTaskItem,
} from "~/services/types";

// CN receiving scan (收貨掃描, spec 2026-11-01-cn-receiving-scan): the order
// sits in status `scanning` after the admin OCR confirm. The operator scans
// each physical label; it is matched CLIENT-SIDE against the order's
// unresolved items and committed one call per scan (scanCnItem). Problem
// items are flagged (missing/damaged/wrong_part/other); 完成 receives the
// `ok` items and creates the CN put-away task.

definePageMeta({ title: "meta.receivingScan" });

const { t } = useI18n();
useHead({ title: t("receivingScan.title") });

const route = useRoute();
const taskId = route.params.id as string;

const { showToast } = useToast();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const { parseRawValue } = useLabelScan();

const detail = ref<CnScanTaskDetail | null>(null);
const pending = ref(true);
const error = ref<string | null>(null);

async function load() {
  try {
    detail.value = await warehouse.getCnScanTask(taskId);
    error.value = null;
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

useVisibleReload(load, ["/receiving-cn-scan-tasks"]);

const items = computed(() => detail.value?.items ?? []);
const resolvedCount = computed(() => items.value.filter((i) => i.scanStatus !== null).length);
const unresolvedCount = computed(() => items.value.length - resolvedCount.value);

function replaceItem(updated: CnScanTaskItem) {
  if (!detail.value) return;
  const index = detail.value.items.findIndex((i) => i.id === updated.id);
  if (index >= 0) detail.value.items[index] = updated;
}

// ---- scanning ----

const scanning = ref(false);
// Same raw label scanned twice in this session → rejected as a duplicate.
const scannedRaws = new Set<string>();

// Multiple unresolved items match one label → the operator picks one.
const chooserOpen = ref(false);
const chooserCandidates = ref<CnScanTaskItem[]>([]);
let pendingScan: { parsed: ParsedFields; raw: string } | null = null;

async function handleRawScan(raw: string): Promise<boolean> {
  const value = raw.trim();
  if (!value || !detail.value) return false;
  if (scannedRaws.has(value)) {
    showToast(t("receivingScan.duplicateLabel"));
    return false;
  }
  scanning.value = true;
  try {
    const result = await parseRawValue(value);
    const parsed = result.parsed;
    if (!parsed.itemId && !parsed.wclItemNo) {
      showToast(t("receivingScan.noPartNo"));
      return false;
    }
    const matches = findCnScanMatches(items.value, parsed);
    if (matches.length === 0) {
      showToast(t("receivingScan.noMatch"));
      return false;
    }
    if (matches.length > 1) {
      pendingScan = { parsed, raw: value };
      chooserCandidates.value = matches;
      chooserOpen.value = true;
      return true;
    }
    return await applyScan(matches[0], parsed, value);
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    scanning.value = false;
  }
}

// Feedback note (audit 2026-11-03 #13): these two return booleans and the
// hardware composable beeps on them; the camera path (onCameraScan) and the
// manual chooser (chooseItem) beep explicitly. No beeps inside applyScan /
// handleRawScan — a hardware scan would then beep twice.
async function applyScan(item: CnScanTaskItem, parsed: ParsedFields, raw: string): Promise<boolean> {
  scanning.value = true;
  try {
    const qty = parsed.qty ?? item.lineQty;
    if (qty == null || qty <= 0) {
      showToast(t("receivingScan.noQty"));
      return false;
    }
    const updated = await warehouse.scanCnItem(taskId, item.id, {
      qty,
      ...(parsed.dateCode ? { dateCode: parsed.dateCode } : {}),
      ...(parsed.lotCode ? { lotCode: parsed.lotCode } : {}),
      ...(parsed.coo ? { coo: parsed.coo } : {}),
      ...(parsed.cow ? { cow: parsed.cow } : {}),
      raw,
    });
    scannedRaws.add(raw);
    replaceItem(updated);
    return true;
  } catch (e) {
    showToast(errorMessage(e));
    return false;
  } finally {
    scanning.value = false;
  }
}

async function chooseItem(item: CnScanTaskItem) {
  chooserOpen.value = false;
  const scan = pendingScan;
  pendingScan = null;
  if (!scan) return;
  const ok = await applyScan(item, scan.parsed, scan.raw);
  if (ok) playScanSuccess();
  else playScanError();
}

useHardwareScanner({
  enabled: () =>
    !!detail.value && !scanning.value && !chooserOpen.value && !flagOpen.value && !finalizeOpen.value && !submitting.value,
  onScan: handleRawScan,
});

async function onCameraScan() {
  const capture = await captureLabel();
  if (!capture) return;
  const ok = await handleRawScan(captureRawLabelValue(capture));
  if (ok) playScanSuccess();
  else playScanError();
}

// ---- flag / reset ----

const flagOpen = ref(false);
const flagItem = ref<CnScanTaskItem | null>(null);
const flagReason = ref<CnFlagItemInput["reason"]>("missing");
const flagNote = ref("");
const flagWrongPartNo = ref("");
const submitting = ref(false);

function openFlag(item: CnScanTaskItem) {
  flagItem.value = item;
  flagReason.value = "missing";
  flagNote.value = "";
  flagWrongPartNo.value = "";
  flagOpen.value = true;
}

async function submitFlag() {
  const item = flagItem.value;
  if (!item || submitting.value) return;
  if (flagReason.value === "wrong_part" && !flagWrongPartNo.value.trim()) {
    showToast(t("receivingScan.wrongPartNoRequired"));
    return;
  }
  submitting.value = true;
  try {
    const updated = await warehouse.flagCnItem(taskId, item.id, {
      reason: flagReason.value,
      ...(flagNote.value.trim() ? { note: flagNote.value.trim() } : {}),
      ...(flagReason.value === "wrong_part" ? { wrongPartNo: flagWrongPartNo.value.trim() } : {}),
    });
    replaceItem(updated);
    flagOpen.value = false;
  } catch (e) {
    showToast(errorMessage(e));
  } finally {
    submitting.value = false;
  }
}

async function resetItem(item: CnScanTaskItem) {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const updated = await warehouse.resetCnItemScan(taskId, item.id);
    replaceItem(updated);
  } catch (e) {
    showToast(errorMessage(e));
  } finally {
    submitting.value = false;
  }
}

// ---- finalize ----

const finalizeOpen = ref(false);

async function finalize(unresolvedAs?: "missing") {
  if (submitting.value) return;
  submitting.value = true;
  try {
    await warehouse.finalizeCnScanTask(taskId, unresolvedAs ? { unresolvedAs } : {});
    showToast(t("receivingScan.finalized"));
    await navigateTo("/put-away");
  } catch (e) {
    showToast(errorMessage(e));
  } finally {
    submitting.value = false;
    finalizeOpen.value = false;
  }
}

// ---- display helpers ----

/** lineQty is nullable (OCR may leave it out) — never pass null to formatCompactQtyUpper. */
function fmtQty(n: number | null): string {
  return n == null ? "—" : formatCompactQtyUpper(n);
}

/** Delivery date display matches the other pages: locale dd/mm/yyyy. */
function fmtDate(s: string | null): string {
  return s ? new Date(s).toLocaleDateString() : t("common.noData");
}

function reasonLabel(reason: CnScanReason | null): string {
  return reason ? t(`receivingScan.reasons.${reason}`) : "";
}

function itemChip(item: CnScanTaskItem): { text: string; cls: string } {
  if (item.scanStatus === "ok") {
    return { text: t("receivingScan.status.ok", { qty: fmtQty(item.scanQty) }), cls: "badge--finished" };
  }
  if (item.scanStatus === "warning") {
    return {
      text: t("receivingScan.status.warning", {
        scanned: fmtQty(item.scanQty),
        expected: fmtQty(item.lineQty),
      }),
      cls: "badge--pending",
    };
  }
  if (item.scanStatus === "error") {
    return { text: reasonLabel(item.scanReason), cls: "badge--danger" };
  }
  return { text: t("receivingScan.status.unresolved"), cls: "" };
}

const flagReasons: CnFlagItemInput["reason"][] = ["missing", "damaged", "wrong_part", "other"];
</script>

<template>
  <div class="cn-scan">
    <p v-if="pending && !detail" class="empty">{{ $t("common.loading") }}</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">
      {{ $t("common.errorPrefix", { message: error }) }}
    </p>

    <template v-else-if="detail">
      <div class="order-card">
        <h2 class="order-card__batch">{{ detail.order.batchNo }}</h2>
        <DetailRow :label="$t('receivingScan.invoices')" :value="detail.order.invoiceNos || '—'" />
        <DetailRow :label="$t('receivingScan.deliveryDate')" :value="fmtDate(detail.order.deliveryDate)" />
        <DetailRow
          :label="$t('receivingScan.progressLabel')"
          :value="$t('receivingScan.progress', { resolved: resolvedCount, total: items.length })"
        />
      </div>

      <EmptyState v-if="items.length === 0" :msg="$t('receivingScan.noItems')" />

      <ul v-else class="items">
        <li v-for="item in items" :key="item.id" class="item">
          <div class="item__main">
            <span class="item__line1">
              <span class="item-part">{{ item.wclItemNo || item.partNo }}</span>
              <span class="badge" :class="itemChip(item).cls">{{ itemChip(item).text }}</span>
            </span>
            <span class="item-meta">
              {{ item.partNo }} · {{ $t("receivingScan.lineQty", { qty: fmtQty(item.lineQty) }) }}
            </span>
            <span v-if="item.poNo" class="item-meta">
              {{ item.poNo }}<template v-if="item.poLine"> / {{ item.poLine }}</template>
            </span>
            <span v-if="item.scanStatus === 'error' && item.scanNote" class="item-meta item-meta--note">
              {{ item.scanNote }}
            </span>
          </div>
          <span class="item__actions">
            <button v-if="item.scanStatus === null" class="btn btn--ghost btn--small" @click="openFlag(item)">
              {{ $t("receivingScan.flag") }}
            </button>
            <button v-else class="btn btn--ghost btn--small" @click="resetItem(item)">
              {{ $t("receivingScan.reset") }}
            </button>
          </span>
        </li>
      </ul>

      <ScanFab :loading="scanning" @click="onCameraScan" />

      <div class="footer">
        <button class="btn" :disabled="submitting" @click="finalizeOpen = true">
          {{ submitting ? $t("actions.confirming") : $t("receivingScan.finalize") }}
        </button>
      </div>
    </template>

    <!-- Multiple-match chooser -->
    <div v-if="chooserOpen" class="modal-backdrop" @click.self="chooserOpen = false">
      <div class="modal">
        <h3 class="modal__title">{{ $t("receivingScan.chooseItem") }}</h3>
        <button
          v-for="item in chooserCandidates"
          :key="item.id"
          class="btn btn--ghost modal__choice"
          @click="chooseItem(item)"
        >
          {{ item.wclItemNo || item.partNo }} · {{ item.partNo }} ·
          {{ $t("receivingScan.lineQty", { qty: fmtQty(item.lineQty) }) }}
        </button>
        <div class="modal__actions">
          <button class="btn btn--ghost" @click="chooserOpen = false">{{ $t("actions.cancel") }}</button>
        </div>
      </div>
    </div>

    <!-- Flag dialog -->
    <div v-if="flagOpen && flagItem" class="modal-backdrop" @click.self="flagOpen = false">
      <div class="modal">
        <h3 class="modal__title">{{ $t("receivingScan.flagTitle", { part: flagItem.wclItemNo || flagItem.partNo }) }}</h3>
        <label v-for="reason in flagReasons" :key="reason" class="modal__radio">
          <input v-model="flagReason" type="radio" :value="reason" />
          <span>{{ $t(`receivingScan.reasons.${reason}`) }}</span>
        </label>
        <label v-if="flagReason === 'wrong_part'" class="modal__field">
          <span>{{ $t("receivingScan.wrongPartNo") }}</span>
          <input v-model="flagWrongPartNo" class="modal__input" type="text" />
        </label>
        <label class="modal__field">
          <span>{{ $t("receivingScan.flagNote") }}</span>
          <input v-model="flagNote" class="modal__input" type="text" />
        </label>
        <div class="modal__actions">
          <button class="btn btn--ghost" @click="flagOpen = false">{{ $t("actions.cancel") }}</button>
          <button class="btn" :disabled="submitting" @click="submitFlag">
            {{ submitting ? $t("actions.confirming") : $t("receivingScan.flag") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Finalize confirm -->
    <div v-if="finalizeOpen" class="modal-backdrop" @click.self="finalizeOpen = false">
      <div class="modal">
        <p v-if="unresolvedCount > 0">
          {{ $t("receivingScan.confirmFinalizeUnresolved", { count: unresolvedCount }) }}
        </p>
        <p v-else>{{ $t("receivingScan.confirmFinalize") }}</p>
        <div class="modal__actions">
          <button class="btn btn--ghost" @click="finalizeOpen = false">{{ $t("actions.cancel") }}</button>
          <button
            v-if="unresolvedCount > 0"
            class="btn btn--danger"
            :disabled="submitting"
            @click="finalize('missing')"
          >
            {{ submitting ? $t("actions.confirming") : $t("receivingScan.markRemainingMissing") }}
          </button>
          <button v-else class="btn" :disabled="submitting" @click="finalize()">
            {{ submitting ? $t("actions.confirming") : $t("receivingScan.finalize") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cn-scan {
  padding-bottom: 4.5rem;
}
.empty {
  color: var(--muted);
}
.order-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  padding: 0.75rem;
  margin-bottom: 1rem;
}
.order-card__batch {
  margin: 0 0 0.5rem;
  font-size: 1.125rem;
}
.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}
.item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  padding: 0.625rem 0.75rem;
}
.item__main {
  display: grid;
  gap: 0.125rem;
  min-width: 0;
}
.item__line1 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.item-part {
  font-weight: 600;
  word-break: break-all;
}
.item-meta {
  color: var(--muted);
  font-size: 0.85rem;
  word-break: break-all;
}
.item-meta--note {
  color: var(--danger);
}
.item__actions {
  display: flex;
  gap: 0.375rem;
  flex-shrink: 0;
}
.footer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: var(--surface);
  border-top: 1px solid var(--border);
}
/* Lift the camera FAB clear of the fixed finalize footer (footer ≈ 4rem tall). */
:deep(.scan-fab) {
  bottom: 4.75rem;
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
.modal {
  background: var(--surface);
  border-radius: 1rem;
  padding: 1rem;
  width: 100%;
  max-width: 22rem;
  display: grid;
  gap: 0.75rem;
}
.modal__title {
  margin: 0;
  font-size: 1rem;
}
.modal__choice {
  text-align: left;
  white-space: normal;
}
.modal__radio {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.95rem;
}
.modal__field {
  display: grid;
  gap: 0.25rem;
  font-size: 0.85rem;
  color: var(--muted);
}
.modal__input {
  padding: 0.5rem 0.75rem;
  font-size: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  width: 100%;
  box-sizing: border-box;
}
.modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
