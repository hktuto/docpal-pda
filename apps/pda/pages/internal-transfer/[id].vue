<template>
  <div>
    <p v-if="pending" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: error }) }}</p>

    <template v-else-if="detail">
      <div class="card" style="margin-bottom: 1rem;">
        <DetailRow :label="$t('internalTransfer.colFrom')" :value="fmtLoc(order.fromOrgId, order.fromSubInventoryCode)" />
        <DetailRow :label="$t('internalTransfer.colTo')" :value="fmtLoc(order.toOrgId, order.toSubInventoryCode)" />
        <DetailRow :label="$t('internalTransfer.colStatus')" :value="$t(`internalTransfer.status.${order.status}`)" />
        <DetailRow v-if="isPickMode" :label="$t('internalTransfer.colAllocation')" :value="$t(`status.allocation.${order.allocationStatus}`)" />
        <DetailRow v-if="order.pickingOrderId" :label="$t('internalTransfer.assignTitle')">
          <NuxtLink :to="`/picking/${order.pickingOrderId}`">{{ $t('internalTransfer.pda.openDelegated') }}</NuxtLink>
        </DetailRow>
      </div>

      <p v-if="heldByOther" class="banner banner--warn">{{ $t('internalTransfer.pda.lockHeld', { name: heldByOther }) }}</p>
      <p v-if="pickShelf && isPickMode" class="banner banner--ok">{{ $t('internalTransfer.pda.shelfBanner', { shelf: pickShelf }) }}</p>
      <p v-if="order.issueReason" class="banner banner--warn">
        {{ $t('internalTransfer.pda.issueBanner', { reason: $t(`internalTransfer.pda.issueReason.${order.issueReason}`), qty: order.issueQty ?? '—', note: order.issueNote ?? '' }) }}
      </p>

      <!-- Pick mode: items with allocation guidance + packages + finish -->
      <template v-if="isPickMode">
        <h2 class="section-title">{{ $t('internalTransfer.items') }}</h2>
        <p v-if="detail.items.length === 0" class="empty">{{ $t('internalTransfer.noneItems') }}</p>
        <div v-for="item in detail.items" :key="item.id" class="card item-card">
          <DetailRow :label="$t('internalTransfer.colPartNo')">
            <span>{{ item.wclItemNo ?? item.partNo }}</span>
          </DetailRow>
          <DetailRow :label="$t('internalTransfer.colQty')" :value="`${item.pickedQty} / ${item.qty}`" />
          <p v-if="item.allocations.length > 0" class="guide-title">{{ $t('internalTransfer.pda.pickFrom') }}</p>
          <div v-for="a in item.allocations" :key="a.id" class="guide-row">
            <span class="guide-source">{{ allocSource(a) }} × {{ a.qty }}</span>
            <button
              class="btn btn-small"
              :disabled="busy || heldByOther !== null"
              @click="pick(item, a)"
            >
              {{ $t('internalTransfer.pda.pick') }}
            </button>
          </div>
        </div>

        <h2 class="section-title">{{ $t('internalTransfer.pda.packages') }}</h2>
        <p v-if="detail.packages.length === 0" class="empty">{{ $t('internalTransfer.pda.noPackages') }}</p>
        <div v-for="p in detail.packages" :key="p.id" class="card item-card package-card">
          <DetailRow :label="$t('internalTransfer.colPartNo')">
            <span>{{ p.partNo }}</span>
          </DetailRow>
          <DetailRow :label="$t('internalTransfer.colQty')" :value="String(p.qty)" />
          <DetailRow v-if="p.dateCode || p.lotCode" :label="$t('internalTransfer.pda.batch')"
                     :value="[p.dateCode, p.lotCode, p.coo, p.cow].filter(Boolean).join(' · ')" />
          <button class="btn btn-small btn-danger" :disabled="busy" @click="removePackage(p)">
            {{ $t('internalTransfer.pda.removePackage') }}
          </button>
        </div>

        <div v-if="!issueOpen" class="card actions-card">
          <button class="btn btn-primary" :disabled="busy || finishing" @click="issueOpen = true">
            {{ $t('internalTransfer.pda.reportIssue') }}
          </button>
          <button class="btn btn-primary" :disabled="busy || finishing || heldByOther !== null" @click="finish">
            {{ finishing ? $t('internalTransfer.pda.finishing') : $t('internalTransfer.pda.finish') }}
          </button>
        </div>
        <div v-else class="card actions-card">
          <select v-model="issueReason" class="issue-select">
            <option value="insufficient_stock">{{ $t('internalTransfer.pda.issueReason.insufficient_stock') }}</option>
            <option value="cannot_divide">{{ $t('internalTransfer.pda.issueReason.cannot_divide') }}</option>
            <option value="other">{{ $t('internalTransfer.pda.issueReason.other') }}</option>
          </select>
          <input
            v-if="issueReason === 'insufficient_stock'"
            v-model="issueQty"
            class="issue-input"
            type="number"
            min="0"
            :placeholder="$t('internalTransfer.pda.issueQty')"
          />
          <input v-model="issueNote" class="issue-input" type="text" :placeholder="$t('internalTransfer.pda.issueNote')" />
          <div class="actions-card">
            <button class="btn" :disabled="busy" @click="issueOpen = false">{{ $t('common.cancel') }}</button>
            <button class="btn btn-primary" :disabled="busy" @click="submitIssue">
              {{ $t('internalTransfer.pda.reportIssue') }}
            </button>
          </div>
        </div>
      </template>

      <!-- Put-away mode (finished + unlinked + unshelved packages) -->
      <template v-else-if="isPutAwayMode">
        <h2 class="section-title">{{ $t('internalTransfer.pda.toShelveTitle') }}</h2>
        <div class="card" style="margin-bottom: 1rem;">
          <DetailRow :label="$t('internalTransfer.pda.targetShelf')">
            <span :class="targetShelf ? 'shelf-set' : 'shelf-missing'">
              {{ targetShelf || $t('internalTransfer.pda.scanShelfHint') }}
            </span>
          </DetailRow>
        </div>
        <div v-for="g in unshelvedGroups" :key="g.key" class="card item-card">
          <DetailRow :label="$t('internalTransfer.colPartNo')">
            <span>{{ g.partNo }}</span>
          </DetailRow>
          <DetailRow :label="$t('internalTransfer.colQty')" :value="String(g.qty)" />
          <DetailRow v-if="g.dateCode" :label="$t('internalTransfer.pda.batch')" :value="g.dateCode" />
          <button
            class="btn btn-primary btn-small"
            :disabled="busy || shelving || !targetShelf"
            @click="shelve(g)"
          >
            {{ $t('internalTransfer.pda.shelve') }}
          </button>
        </div>
        <p v-if="taskCompleted" class="banner banner--ok">{{ $t('internalTransfer.pda.taskCompleted') }}</p>
      </template>

      <!-- Done: finished with nothing left to do here -->
      <p v-else class="empty">{{ $t('internalTransfer.pda.finishedNothing') }}</p>

      <ScanFab v-if="isPickMode || isPutAwayMode" :loading="cameraScanning" @click="scanByCamera" />
    </template>

    <p v-else class="empty">{{ $t('internalTransfer.pda.notFound') }}</p>
  </div>
</template>

<script setup lang="ts">
import { useErrorMessage } from "~/composables/errorMessage";
import { useToast } from "~/composables/useToast";
import { useWarehouse } from "~/composables/useWarehouse";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { captureLabel, captureRawLabelValue, ocrResultToInput, useLabelScan } from "~/composables/useLabelScan";
import { badgeClass } from "~/composables/useStatusBadge";
import type { InternalTransferPackageRow, InternalTransferPickingAllocation, InternalTransferPickingDetail, InternalTransferPickingItem } from "~/services/types";

definePageMeta({ title: "meta.internalTransferDetail" });

const { t } = useI18n();
useHead({ title: t('internalTransfer.pda.detailTitle') });

const route = useRoute();
const orderId = route.params.id as string;

const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const { showToast } = useToast();

const pending = ref(true);
const error = ref<string | null>(null);
const detail = ref<InternalTransferPickingDetail | null>(null);
const busy = ref(false);
const finishing = ref(false);
const shelving = ref(false);
const taskCompleted = ref(false);
const targetShelf = ref<string | null>(null);
const heldByOther = ref<string | null>(null);
const issueOpen = ref(false);
const issueReason = ref("insufficient_stock");
const issueQty = ref("");
const issueNote = ref("");

const order = computed(() => detail.value!.order);
const isPickMode = computed(() => ["allocated", "picking", "issue"].includes(order.value.status));
const isPutAwayMode = computed(
  () => order.value.status === "finished" && !order.value.pickingOrderId && unshelvedPackages.value.length > 0
);
const unshelvedPackages = computed(() => detail.value?.packages.filter((p) => p.shelfCode === null) ?? []);
const unshelvedGroups = computed(() => {
  const map = new Map<string, { key: string; partNo: string; dateCode: string | null; qty: number }>();
  for (const p of unshelvedPackages.value) {
    const dateCode = p.dateCode ?? "";
    const key = `${p.partNo}|${dateCode}`;
    const g = map.get(key) ?? { key, partNo: p.partNo, dateCode: p.dateCode, qty: 0 };
    g.qty += p.qty;
    map.set(key, g);
  }
  return [...map.values()];
});

usePageHeader({
  title: () => (detail.value ? detail.value.order.orderNo : undefined),
  badgeText: () => (detail.value ? t(`internalTransfer.status.${detail.value.order.status}`) : undefined),
  badgeClass: () => badgeClass(detail.value?.order.status),
});

async function load() {
  try {
    detail.value = await warehouse.getInternalTransferPickingDetail(orderId);
    error.value = null;
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

function fmtLoc(orgId: number | null, code: string | null): string {
  return orgId === null && !code ? "—" : `${orgId ?? "?"} / ${code ?? "?"}`;
}

function allocSource(a: InternalTransferPickingAllocation): string {
  if (a.sourceType === "lot") return [a.shelfCode, a.boxId, a.dateCode].filter(Boolean).join(" · ") || "—";
  return [a.receivingBatchNo, a.ctnNo, a.dateCode].filter(Boolean).join(" · ") || "—";
}

// --- work lock (inline mirror of usePickingWorkLock, transfer endpoints) ---

const LOCK_REFRESH_MS = 3 * 60 * 1000; // backend expires after 10 min
let lockTimer: ReturnType<typeof setInterval> | null = null;

async function acquireLock(): Promise<void> {
  if (!isPickMode.value) return;
  try {
    await warehouse.acquireInternalTransferWorkLock(orderId);
    heldByOther.value = null;
  } catch (e: unknown) {
    const body = (e as { body?: { error?: string; holderName?: string } })?.body;
    if (body?.error === "lock_held") heldByOther.value = body.holderName ?? "—";
    // offline / 5xx: keep the page usable, the next refresh retries
  }
}

onMounted(async () => {
  await load();
  await acquireLock();
  lockTimer = setInterval(acquireLock, LOCK_REFRESH_MS);
});

function releaseLock(): void {
  if (lockTimer) clearInterval(lockTimer);
  warehouse.releaseInternalTransferWorkLock(orderId).catch(() => {});
}

onUnmounted(releaseLock);

// --- picking ---

/** Label fields from a decoded QR scan (backend /scan/decode authority with
 *  the local-OCR fallback) — qty becomes the pick prompt's default, the
 *  batch fields ride into the package snapshot. */
interface LabelFields {
  qty?: number;
  dateCode?: string;
  lotCode?: string;
  coo?: string;
  cow?: string;
}

async function pick(item: InternalTransferPickingItem, a: InternalTransferPickingAllocation, label?: LabelFields): Promise<void> {
  const remaining = item.qty - item.pickedQty;
  const max = Math.min(a.qty, remaining);
  if (max <= 0) return;
  const suggested = label?.qty !== undefined && Number.isInteger(label.qty) && label.qty > 0
    ? Math.min(label.qty, max)
    : max;
  const input = window.prompt(t("internalTransfer.pda.pickQtyPrompt", { max }), String(suggested));
  if (input === null) return;
  const qty = Number(input);
  if (!Number.isInteger(qty) || qty <= 0 || qty > max) {
    showToast(t("internalTransfer.pda.pickQtyInvalid", { max }));
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    await warehouse.scanInternalTransferItem(item.id, {
      allocationId: a.id,
      qty,
      dateCode: label?.dateCode || null,
      lotCode: label?.lotCode || null,
      coo: label?.coo || null,
      cow: label?.cow || null,
      shelfCode: pickShelf.value,
    });
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

/** One raw scan value (hardware wedge/broadcast or camera capture), pick
 *  mode: a shelf scan stashes the pending target (pickingShelfScan
 *  require-match — the backend 409 is the safety net, no client pre-check);
 *  an item QR label (backend decode; bare part numbers pass through) picks
 *  from the matched item's first remaining allocation with the label's qty +
 *  batch fields. */
const pickShelf = ref<string | null>(null);

async function handlePickScan(raw: string): Promise<boolean> {
  if (heldByOther.value !== null) return false;
  // Shelf QR first: it becomes the pending shelf for the next item scans.
  const value = raw.trim().toUpperCase();
  if (shelves.value.length === 0) {
    try {
      shelves.value = await warehouse.getShelves();
    } catch {
      // shelf list unavailable — fall through to the item match
    }
  }
  const shelfHit = shelves.value.find((s) => s.code.toUpperCase() === value);
  if (shelfHit) {
    pickShelf.value = shelfHit.code;
    showToast(t("internalTransfer.pda.shelfSet", { shelf: shelfHit.code }));
    return true;
  }
  let label: LabelFields | undefined;
  let keys = [value];
  try {
    const parsedResult = await labelScan.parseRawValue(raw);
    const parsed = ocrResultToInput(parsedResult.parsed);
    const partKey = (parsed.wclItemNo || parsed.partNo || "").trim().toUpperCase();
    if (partKey) keys = [partKey, ...keys];
    const qty = Number(parsed.qty);
    if (parsed.qty !== "" && Number.isInteger(qty) && qty > 0) {
      label = {
        qty,
        dateCode: parsed.dateCode || undefined,
        lotCode: parsed.lotCode || undefined,
        coo: parsed.coo || undefined,
        cow: parsed.cow || undefined,
      };
    }
  } catch (e: unknown) {
    // decode network failure: the bare-value match below is the last resort
    error.value = errorMessage(e);
  }
  const item = detail.value?.items.find(
    (i) => i.qty > i.pickedQty && keys.includes((i.wclItemNo ?? i.partNo).toUpperCase())
  );
  if (item && item.allocations.length > 0) {
    await pick(item, item.allocations[0], label);
    return true;
  }
  showToast(t("internalTransfer.pda.noMatch"));
  return false;
}

async function removePackage(p: InternalTransferPackageRow): Promise<void> {
  if (!window.confirm(t("internalTransfer.pda.removePackageConfirm", { qty: p.qty }))) return;
  busy.value = true;
  error.value = null;
  try {
    await warehouse.removeInternalTransferPackage(p.id);
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function submitIssue(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await warehouse.reportInternalTransferIssue(orderId, {
      reason: issueReason.value,
      qty: issueReason.value === "insufficient_stock" && issueQty.value.trim() !== "" ? Number(issueQty.value) : undefined,
      note: issueNote.value || null,
    });
    issueOpen.value = false;
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function finish(): Promise<void> {
  if (!window.confirm(t("internalTransfer.pda.finishConfirm"))) return;
  finishing.value = true;
  error.value = null;
  try {
    const res = await warehouse.finishInternalTransferOrder(orderId);
    if (res.allocation) {
      showToast(t("internalTransfer.pda.finishDelegated", { fully: res.allocation.fullyAllocated, demands: res.allocation.demands }));
    } else {
      showToast(t("internalTransfer.pda.finishDone"));
    }
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    finishing.value = false;
  }
}

// --- put-away mode ---

async function shelve(g: { partNo: string; dateCode: string | null }): Promise<void> {
  if (!targetShelf.value) return;
  shelving.value = true;
  error.value = null;
  try {
    const res = await warehouse.shelveInternalTransferPackages(orderId, {
      partNo: g.partNo,
      dateCode: g.dateCode,
      shelfCode: targetShelf.value,
    });
    taskCompleted.value = res.taskCompleted;
    showToast(t("internalTransfer.pda.shelved", { qty: res.shelved }));
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    shelving.value = false;
  }
}

// Hardware scanner: in put-away mode a shelf scan sets the target shelf; in
// pick mode an item QR label (or bare part number) picks from the matched
// item's first remaining allocation.
const shelves = ref<{ code: string }[]>([]);
const labelScan = useLabelScan();
const cameraScanning = ref(false);

useHardwareScanner({
  enabled: () => !!detail.value,
  onScan: async (raw) => {
    if (isPutAwayMode.value) {
      const value = raw.trim().toUpperCase();
      if (shelves.value.length === 0) shelves.value = await warehouse.getShelves();
      const hit = shelves.value.find((s) => s.code.toUpperCase() === value);
      if (hit) {
        targetShelf.value = hit.code;
        return true;
      }
      return false;
    }
    if (!isPickMode.value) return false;
    return handlePickScan(raw);
  },
});

// Camera capture (ScanFab): the same decode+match path as the hardware scan.
async function scanByCamera(): Promise<void> {
  if (cameraScanning.value) return;
  cameraScanning.value = true;
  try {
    const capture = await captureLabel();
    if (!capture) return;
    if (isPutAwayMode.value) {
      await handleShelfScanRaw(captureRawLabelValue(capture));
    } else if (isPickMode.value) {
      await handlePickScan(captureRawLabelValue(capture));
    }
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    cameraScanning.value = false;
  }
}

async function handleShelfScanRaw(raw: string): Promise<boolean> {
  const value = raw.trim().toUpperCase();
  if (shelves.value.length === 0) shelves.value = await warehouse.getShelves();
  const hit = shelves.value.find((s) => s.code.toUpperCase() === value);
  if (hit) {
    targetShelf.value = hit.code;
    return true;
  }
  showToast(t("internalTransfer.pda.noShelfMatch"));
  return false;
}

useVisibleReload(load);
</script>

<style scoped>
.section-title {
  margin: 0 0 1rem;
  font-size: 1rem;
}
.item-card {
  margin-bottom: 0.75rem;
}
.guide-title {
  margin: 0.25rem 0 0.125rem;
  color: var(--muted);
  font-size: 0.8125rem;
}
.guide-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.125rem 0;
}
.guide-source {
  font-size: 0.875rem;
}
.package-card .btn {
  margin-top: 0.375rem;
}
.actions-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 1.5rem;
}
.issue-select,
.issue-input {
  font: inherit;
  padding: 0.4375rem 0.5625rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: 100%;
}
.shelf-set {
  color: var(--success, #16a34a);
  font-weight: 600;
}
.shelf-missing {
  color: var(--muted);
}
.banner {
  margin: 0 0 1rem;
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius);
  font-size: 0.875rem;
}
.banner--warn {
  background: rgba(240, 220, 160, 0.18);
  border: 1px solid rgba(240, 220, 160, 0.45);
  color: #b08d2a;
}
.banner--ok {
  background: rgba(22, 163, 74, 0.12);
  border: 1px solid rgba(22, 163, 74, 0.35);
  color: #16a34a;
}
.btn-primary {
  width: 100%;
  padding: 0.75rem;
  font-size: 1rem;
  font-weight: 600;
}
.btn-danger {
  color: var(--danger, #dc2626);
}
</style>
