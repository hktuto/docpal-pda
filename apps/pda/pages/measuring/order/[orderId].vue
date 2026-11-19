<template>
  <AppListPage
    :loading="loading"
    :error="loadError"
    :empty="group === null"
    empty-text="measuring.orderNotFound"
    :shown="group?.boxes.length ?? 0"
    :total="group?.boxes.length ?? 0"
    :has-more="false"
    hide-footer
    :reload="load"
  >
    <template #header>
      <div class="page-top">
        <button type="button" class="back-btn" @click="router.back()">{{ $t('measuring.back') }}</button>
        <h1 class="page-title">{{ $t('measuring.orderBoxes', { orderNo: group?.orderNo ?? '' }) }}</h1>
      </div>
      <p class="page-hint">{{ $t('measuring.orderBoxesHint') }}</p>
    </template>

    <template v-if="group">
      <AppListRow
        v-for="box in group.boxes"
        :key="box.boxId"
        :to="`/measuring/${box.boxId}`"
        :title="rowView(box).title"
        :meta="rowMeta(box)"
        :chip-text="rowChip(box)?.text"
        :chip-class="rowChip(box)?.cls"
        :mine-text="mineText(box)"
      />
    </template>
  </AppListPage>
</template>

<script setup lang="ts">
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { useToast } from "~/composables/useToast";
import { badgeClass } from "~/composables/useStatusBadge";
import { viewListChip, viewListRow } from "~/utils/viewConfig";
import type { MeasuringBoxListRow, MeasuringOrderGroup } from "~/services/types";

definePageMeta({ title: "meta.measuring" });

// Level 2 (spec 2026-11-18): one picking order's boxes. Scanning a box QR
// opens the box; scanning an ITEM auto-credits the single remaining part's
// box when no label-mode/carton matching applies (quick scan).
const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const { mineText } = useAssignedToMe();
const { viewConfig, viewConfigLoaded, renderChip } = useViewConfig();
const rowView = (box: MeasuringBoxListRow) => viewListRow("measuring", box, viewConfig.value);
function rowMeta(box: MeasuringBoxListRow): string[] {
  const meta = rowView(box).meta;
  return viewConfigLoaded.value
    ? meta
    : [...meta, t("common.packagesVerified", { verified: box.verifiedCount, total: box.packageCount })];
}
function rowChip(box: MeasuringBoxListRow) {
  if (!viewConfigLoaded.value) return { text: statusLabel.box(box.status), cls: badgeClass(box.status) };
  return renderChip(viewListChip("measuring", box, viewConfig.value));
}
const router = useRouter();
const { showToast } = useToast();

const route = useRoute();
const orderId = route.params.orderId as string;

useHead({ title: t('measuring.title') });

const group = ref<MeasuringOrderGroup | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    const groups = await warehouse.getMeasuringBoxes();
    group.value = groups.find((g) => g.orderId === orderId) ?? null;
  } catch (e: unknown) {
    loadError.value = errorMessage(e);
    group.value = null;
  } finally {
    loading.value = false;
  }
}

async function tryQuickItemScan(rawValue: string): Promise<boolean> {
  // Decode the label server-side, then ask the backend to credit the box
  // whose remaining work is exactly this single part. No decode match →
  // fall back to the raw string as the part needle.
  const raw = rawValue.trim();
  if (!raw) return false;
  let partNo = raw;
  let wclItemNo: string | undefined;
  try {
    const decoded = await warehouse.decodeScan({ raw });
    if (decoded.matched && decoded.parsed.itemId) {
      partNo = decoded.parsed.itemId;
      wclItemNo = decoded.parsed.wclItemNo;
    }
  } catch {
    // decode is best-effort — the raw string is still a usable needle
  }
  const result = await warehouse.scanItemCompleteBox({ mode: "measuring", orderKey: orderId, partNo, wclItemNo, raw });
  showToast(
    result.taskCompleted
      ? t("measuring.itemScanVerified", { boxId: result.boxId })
      : t("measuring.itemScanComplete", { boxId: result.boxId, count: result.creditedPackages })
  );
  await load();
  return true;
}

function isNoMatch(e: unknown): boolean {
  return e instanceof Error && e.message.includes("scan_item_no_match");
}

useHardwareScanner({
  enabled: () => group.value !== null,
  onScan: async (rawValue) => {
    const boxes = group.value?.boxes ?? [];
    const q = rawValue.trim().toLowerCase();
    if (!q) return false;
    // Box QR first (exact id, then unique substring).
    const exact = boxes.find((b) => b.boxId.toLowerCase() === q);
    const matches = exact ? [exact] : boxes.filter((b) => b.boxId.toLowerCase().includes(q));
    if (matches.length === 1) {
      router.push(`/measuring/${matches[0].boxId}`);
      return true;
    }
    // Otherwise treat the scan as an item label — quick-complete its box.
    try {
      return await tryQuickItemScan(rawValue);
    } catch (e: unknown) {
      showToast(isNoMatch(e) ? t("measuring.itemScanNoMatch") : errorMessage(e));
      return false;
    }
  },
});
</script>

<style scoped>
.page-top {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.back-btn {
  flex-shrink: 0;
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 0.875rem;
}

.page-title {
  margin: 0;
  font-size: 1rem;
}

.page-hint {
  margin: 0.25rem 0 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}
</style>
