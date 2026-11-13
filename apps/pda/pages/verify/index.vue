<template>
  <AppListPage
    :loading="loading"
    :error="loadError"
    :empty="groups.length === 0"
    empty-text="common.noPendingVerifyTasks"
    :shown="rows.length"
    :total="rows.length"
    :has-more="false"
    hide-footer
    :reload="load"
  >
    <template #header>
      <input
        v-model="search"
        type="search"
        class="search-input"
        :placeholder="$t('verify.searchPlaceholder')"
        @click.stop
      />
      <p class="page-hint">{{ $t('verify.hint') }}</p>
    </template>

    <template v-for="group in groups" :key="group.orderNos">
      <h2 class="order-group__heading">{{ $t('verify.orderGroup', { orderNo: group.orderNos }) }}</h2>
      <AppListRow
        v-for="task in group.tasks"
        :key="task.taskId"
        :to="`/verify/${task.shippingBoxId}`"
        :title="rowView(task).title"
        :meta="rowMeta(task)"
        :chip-text="rowChip(task)?.text"
        :chip-class="rowChip(task)?.cls"
        :mine-text="mineText(task)"
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
import type { VerifyTaskListRow } from "~/services/types";

definePageMeta({ title: "meta.verify" });

const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const { mineText } = useAssignedToMe();
// Row title/meta/chip come from the warehouse's pdaViewConfig flow config
// (spec 2026-10-04-pda-app-rewrite-design.md); on a backend without the key
// the legacy listTemplates + the extra meta line render instead.
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

useHead({ title: t('verify.title') });

const rawRows = ref<VerifyTaskListRow[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    // Pending only — completed verify tasks move on to shipping.
    rawRows.value = await warehouse.getVerifyTasks("pending");
  } catch (e: unknown) {
    loadError.value = errorMessage(e);
    rawRows.value = [];
  } finally {
    loading.value = false;
  }
}

const search = ref("");
const rows = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rawRows.value;
  return rawRows.value.filter((t) => t.orderNos.some((o) => o.toLowerCase().includes(q)));
});

// Group the (filtered) tasks by their picking order numbers — the same
// grouping the measuring list uses, derived client-side here.
const groups = computed(() => {
  const byOrders = new Map<string, VerifyTaskListRow[]>();
  for (const task of rows.value) {
    const key = task.orderNos.join(", ");
    const list = byOrders.get(key);
    if (list) list.push(task);
    else byOrders.set(key, [task]);
  }
  return [...byOrders].map(([orderNos, tasks]) => ({ orderNos, tasks }));
});

// Scanning a printed carton label opens its box (and stamps the box's
// carton_label_verified — spec 2026-10-30); otherwise a box QR (or its id
// typed on the wedge) opens that box directly. Exact id wins; otherwise a
// unique substring match (e.g. the daily seq).
useHardwareScanner({
  enabled: () => rows.value.length > 0,
  onScan: async (rawValue) => {
    const q = rawValue.trim();
    if (!q) return false;
    const hit = await warehouse.lookupVerifyTaskByLabel(q);
    if (hit) {
      router.push(`/verify/${hit.shippingBoxId}`);
      showToast(t("verify.cartonLabelVerified"));
      return;
    }
    const boxes = rows.value;
    const needle = q.toLowerCase();
    const exact = boxes.find((b) => b.shippingBoxId.toLowerCase() === needle);
    const matches = exact ? [exact] : boxes.filter((b) => b.shippingBoxId.toLowerCase().includes(needle));
    if (matches.length === 1) {
      router.push(`/verify/${matches[0].shippingBoxId}`);
    } else {
      showToast(t("verify.boxNotFound", { id: q }));
      return false;
    }
  },
});
</script>

<style scoped>
.search-input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
}

.page-hint {
  margin: -0.25rem 0 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}

.order-group__heading {
  margin: 0 0 0.375rem;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--muted);
  letter-spacing: 0.03em;
}

.order-group__heading:not(:first-child) {
  margin-top: 1rem;
}
</style>
