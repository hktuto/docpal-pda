<script setup lang="ts">
import { captureLabel, captureRawLabelValue } from "~/composables/useLabelScan";
import { I18nError } from "~/composables/i18nError";
import { playScanError, playScanSuccess } from "~/utils/scanBeep";
import { buildCnScanGroups, type CnScanGroup } from "~/utils/cnScanGroups";
import { formatCompactQtyUpper } from "~/utils/formatNumber";
import type {
  CnFlagItemInput,
  CnScanReason,
  CnScanTaskDetail,
  CnScanTaskItem,
} from "~/services/types";

// CN receiving scan (收貨掃描, spec 2026-11-05-cn-receiving-part-only-scan-matching):
// the order sits in status `scanning` after the admin OCR confirm. The page
// renders one row per PART (the PDF's dateCode/lotCode/COO/COW come from OCR
// and are untrustworthy — only part no and total qty are true); the operator
// scans physical labels and each scan is matched + credited server-side
// (scanCnTaskAggregate → POST .../scan-aggregate, FIFO across the part's open
// lines; scanned batch fields overwrite the line) — the response replaces the
// whole detail. Problem groups are flagged (missing/damaged/wrong_part/other);
// 完成 receives the credited items and creates the CN put-away task.

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
const groups = computed(() => buildCnScanGroups(items.value));
const unresolvedCount = computed(() => items.value.filter((i) => i.scanStatus === null).length);
const totalScanQty = computed(() => items.value.reduce((sum, i) => sum + (i.scanQty ?? 0), 0));
const totalLineQty = computed(() => {
  let sum = 0;
  let known = false;
  for (const i of items.value) {
    if (i.lineQty != null) {
      sum += i.lineQty;
      known = true;
    }
  }
  return known ? sum : null;
});

function replaceItem(updated: CnScanTaskItem) {
  if (!detail.value) return;
  const index = detail.value.items.findIndex((i) => i.id === updated.id);
  if (index >= 0) detail.value.items[index] = updated;
}

// ---- scanning ----

const scanning = ref(false);
// Same raw label scanned twice in this session → rejected as a duplicate.
const scannedRaws = new Set<string>();

// Feedback note (audit 2026-11-03 #13): handleRawScan returns a boolean and
// the hardware composable beeps on it; the camera path (onCameraScan) beeps
// explicitly. No beeps inside handleRawScan — a hardware scan would then
// beep twice.
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
    const qty = parsed.qty;
    if (qty == null || qty <= 0) {
      showToast(t("receivingScan.noQty"));
      return false;
    }
    const updated = await warehouse.scanCnTaskAggregate(taskId, {
      ...(parsed.itemId ? { itemId: parsed.itemId } : {}),
      ...(parsed.wclItemNo ? { wclItemNo: parsed.wclItemNo } : {}),
      qty,
      ...(parsed.dateCode ? { dateCode: parsed.dateCode } : {}),
      ...(parsed.lotCode ? { lotCode: parsed.lotCode } : {}),
      ...(parsed.coo ? { coo: parsed.coo } : {}),
      ...(parsed.cow ? { cow: parsed.cow } : {}),
      raw: value,
    });
    scannedRaws.add(value);
    const overQty = updated.lastScan?.overQty;
    detail.value = { order: updated.order, items: updated.items };
    if (overQty && overQty > 0) {
      showToast(t("receivingScan.overReceived", { qty: formatCompactQtyUpper(overQty) }));
    }
    return true;
  } catch (e) {
    if (e instanceof I18nError && e.code === "no_matching_item") {
      showToast(t("receivingScan.noMatch"));
    } else {
      showToast(e instanceof Error ? errorMessage(e) : String(e));
    }
    return false;
  } finally {
    scanning.value = false;
  }
}

useHardwareScanner({
  enabled: () =>
    !!detail.value && !scanning.value && !flagOpen.value && !finalizeOpen.value && !submitting.value,
  onScan: handleRawScan,
});

async function onCameraScan() {
  const capture = await captureLabel();
  if (!capture) return;
  const ok = await handleRawScan(captureRawLabelValue(capture));
  if (ok) playScanSuccess();
  else playScanError();
}

// ---- flag / reset (group-level loops over the per-item endpoints) ----

const flagOpen = ref(false);
const flagGroup = ref<CnScanGroup | null>(null);
const flagReason = ref<CnFlagItemInput["reason"]>("missing");
const flagNote = ref("");
const flagWrongPartNo = ref("");
const submitting = ref(false);

function openFlag(group: CnScanGroup) {
  flagGroup.value = group;
  flagReason.value = "missing";
  flagNote.value = "";
  flagWrongPartNo.value = "";
  flagOpen.value = true;
}

async function submitFlag() {
  const group = flagGroup.value;
  if (!group || submitting.value) return;
  if (flagReason.value === "wrong_part" && !flagWrongPartNo.value.trim()) {
    showToast(t("receivingScan.wrongPartNoRequired"));
    return;
  }
  const input: CnFlagItemInput = {
    reason: flagReason.value,
    ...(flagNote.value.trim() ? { note: flagNote.value.trim() } : {}),
    ...(flagReason.value === "wrong_part" ? { wrongPartNo: flagWrongPartNo.value.trim() } : {}),
  };
  submitting.value = true;
  try {
    for (const item of group.items.filter((i) => i.scanStatus === null)) {
      replaceItem(await warehouse.flagCnItem(taskId, item.id, input));
    }
    flagOpen.value = false;
  } catch (e) {
    showToast(errorMessage(e));
  } finally {
    submitting.value = false;
  }
}

async function resetGroup(group: CnScanGroup) {
  if (submitting.value) return;
  const touched = group.items.filter((i) => i.scanStatus !== null || (i.scanQty ?? 0) > 0);
  if (touched.length === 0) return;
  submitting.value = true;
  try {
    for (const item of touched) {
      replaceItem(await warehouse.resetCnItemScan(taskId, item.id));
    }
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

function groupChip(group: CnScanGroup): { text: string; cls: string } {
  switch (group.status) {
    case "complete":
      return {
        text: t("receivingScan.status.ok", { qty: fmtQty(group.scanQty) }),
        cls: "badge--finished",
      };
    case "over":
      return {
        text: t("receivingScan.status.warning", {
          scanned: fmtQty(group.scanQty),
          expected: fmtQty(group.lineQty),
        }),
        cls: "badge--pending",
      };
    case "partial":
      return {
        text: t("receivingScan.status.partial", {
          scanned: fmtQty(group.scanQty),
          expected: fmtQty(group.lineQty),
        }),
        cls: "badge--pending",
      };
    case "error": {
      const reason: CnScanReason | null =
        group.items.find((i) => i.scanStatus === "error")?.scanReason ?? null;
      return { text: reason ? t(`receivingScan.reasons.${reason}`) : t("receivingScan.status.error"), cls: "badge--danger" };
    }
    default:
      return { text: t("receivingScan.status.unresolved"), cls: "" };
  }
}

function groupHasOpenLines(group: CnScanGroup): boolean {
  return group.items.some((i) => i.scanStatus === null);
}

function groupHasTouchedLines(group: CnScanGroup): boolean {
  return group.items.some((i) => i.scanStatus !== null || (i.scanQty ?? 0) > 0);
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
          :value="$t('receivingScan.progressQty', { scanned: fmtQty(totalScanQty), expected: fmtQty(totalLineQty) })"
        />
      </div>

      <EmptyState v-if="groups.length === 0" :msg="$t('receivingScan.noItems')" />

      <ul v-else class="items">
        <li v-for="group in groups" :key="group.key" class="item">
          <div class="item__main">
            <span class="item__line1">
              <span class="item-part">{{ group.wclItemNo || group.partNo }}</span>
              <span class="badge" :class="groupChip(group).cls">{{ groupChip(group).text }}</span>
            </span>
            <span class="item-meta">
              {{ group.partNo }} ·
              {{ $t("receivingScan.groupQty", { scanned: fmtQty(group.scanQty), expected: fmtQty(group.lineQty) }) }}
            </span>
            <span class="item-meta item-meta--chips">
              <span v-if="group.dateCode" class="chip">{{ group.dateCode }}</span>
              <span v-if="group.coo" class="chip">COO {{ group.coo }}</span>
              <span v-if="group.cow" class="chip">COW {{ group.cow }}</span>
            </span>
            <span v-if="group.poNos.length > 0" class="item-meta">{{ group.poNos.join(" · ") }}</span>
            <span
              v-for="line in group.items.filter((i) => i.scanStatus === 'error' && i.scanNote)"
              :key="line.id"
              class="item-meta item-meta--note"
            >
              {{ line.scanNote }}
            </span>
          </div>
          <span class="item__actions">
            <button
              v-if="groupHasOpenLines(group)"
              class="btn btn--ghost btn--small"
              @click="openFlag(group)"
            >
              {{ $t("receivingScan.flag") }}
            </button>
            <button
              v-if="groupHasTouchedLines(group)"
              class="btn btn--ghost btn--small"
              @click="resetGroup(group)"
            >
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

    <!-- Flag dialog (applies to the group's open lines) -->
    <div v-if="flagOpen && flagGroup" class="modal-backdrop" @click.self="flagOpen = false">
      <div class="modal">
        <h3 class="modal__title">
          {{ $t("receivingScan.flagTitle", { part: flagGroup.wclItemNo || flagGroup.partNo }) }}
        </h3>
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
.item-meta--chips {
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
}
.chip {
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  padding: 0 0.375rem;
  font-size: 0.8rem;
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
