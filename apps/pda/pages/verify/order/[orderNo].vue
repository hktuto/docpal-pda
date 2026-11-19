<template>
  <AppListPage
    :loading="loading"
    :error="loadError"
    :empty="tasks.length === 0"
    empty-text="verify.orderNotFound"
    :shown="tasks.length"
    :total="tasks.length"
    :has-more="false"
    hide-footer
    :reload="load"
  >
    <template #header>
      <div class="page-top">
        <button type="button" class="back-btn" @click="router.back()">{{ $t('verify.back') }}</button>
        <h1 class="page-title">{{ $t('verify.orderBoxes', { orderNo }) }}</h1>
      </div>
      <p class="page-hint">{{ $t('verify.orderBoxesHint') }}</p>
    </template>

    <AppListRow
      v-for="task in tasks"
      :key="task.taskId"
      :to="`/verify/${task.shippingBoxId}`"
      :title="rowView(task).title"
      :meta="rowMeta(task)"
      :chip-text="rowChip(task)?.text"
      :chip-class="rowChip(task)?.cls"
      :mine-text="mineText(task)"
    />
  </AppListPage>
</template>

<script setup lang="ts">
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { useToast } from "~/composables/useToast";
import { badgeClass } from "~/composables/useStatusBadge";
import { viewListChip, viewListRow } from "~/utils/viewConfig";
import type { VerifyTaskListRow } from "~/services/types";

definePageMeta({ title: "meta.verify" });

// Level 2 (spec 2026-11-18): one order's pending verify box tasks. Scanning
// a box/carton label opens the task; scanning an ITEM auto-credits (and for
// verify, completes) the single remaining part's box when no label-mode /
// carton matching applies (quick scan).
const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const { mineText } = useAssignedToMe();
const { viewConfig, viewConfigLoaded, renderChip } = useViewConfig();
const rowView = (task: VerifyTaskListRow) => viewListRow("verify", task, viewConfig.value);
function rowMeta(task: VerifyTaskListRow): string[] {
  const meta = rowView(task).meta;
  return viewConfigLoaded.value
    ? meta
    : [...meta, t("common.packagesVerified", { verified: task.verifyVerifiedCount, total: task.packageCount })];
}
function rowChip(task: VerifyTaskListRow) {
  if (!viewConfigLoaded.value) return { text: statusLabel.box(task.boxStatus), cls: badgeClass(task.boxStatus) };
  return renderChip(viewListChip("verify", task, viewConfig.value));
}
const router = useRouter();
const { showToast } = useToast();

const route = useRoute();
const orderNo = decodeURIComponent(route.params.orderNo as string);

useHead({ title: t('verify.title') });

const rawRows = ref<VerifyTaskListRow[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    rawRows.value = await warehouse.getVerifyTasks("pending");
  } catch (e: unknown) {
    loadError.value = errorMessage(e);
    rawRows.value = [];
  } finally {
    loading.value = false;
  }
}

const tasks = computed(() => rawRows.value.filter((t) => t.orderNos.includes(orderNo)));

async function tryQuickItemScan(rawValue: string): Promise<boolean> {
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
  const result = await warehouse.scanItemCompleteBox({ mode: "verify", orderKey: orderNo, partNo, wclItemNo, raw });
  showToast(
    result.taskCompleted
      ? t("verify.itemScanVerified", { boxId: result.boxId })
      : t("verify.itemScanComplete", { boxId: result.boxId, count: result.creditedPackages })
  );
  await load();
  return true;
}

function isNoMatch(e: unknown): boolean {
  return e instanceof Error && e.message.includes("scan_item_no_match");
}

useHardwareScanner({
  enabled: () => tasks.value.length > 0,
  onScan: async (rawValue) => {
    const raw = rawValue.trim();
    if (!raw) return false;
    // Carton label first (stamps carton_label_verified), then box QR.
    const carton = await warehouse.lookupVerifyTaskByLabel(raw);
    if (carton) {
      router.push(`/verify/${carton.shippingBoxId}`);
      showToast(t("verify.cartonLabelVerified"));
      return true;
    }
    const q = raw.toLowerCase();
    const boxMatches = (b: string) => b.toLowerCase() === q || b.toLowerCase().includes(q);
    const matches = tasks.value.filter((t) => boxMatches(t.shippingBoxId));
    if (matches.length === 1) {
      router.push(`/verify/${matches[0].shippingBoxId}`);
      return true;
    }
    // Otherwise treat the scan as an item label — quick-complete its box.
    try {
      return await tryQuickItemScan(rawValue);
    } catch (e: unknown) {
      showToast(isNoMatch(e) ? t("verify.itemScanNoMatch") : errorMessage(e));
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
