<template>
  <AppListPage
    :loading="loading"
    :error="loadError"
    :empty="orders.length === 0"
    empty-text="common.noPendingVerifyTasks"
    :shown="orders.length"
    :total="orders.length"
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

    <AppListRow
      v-for="order in orders"
      :key="order.orderNo"
      :to="`/verify/order/${encodeURIComponent(order.orderNo)}`"
      :title="order.orderNo"
      :meta="[t('verify.taskCount', { count: order.taskCount })]"
    />
  </AppListPage>
</template>

<script setup lang="ts">
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { useToast } from "~/composables/useToast";
import type { VerifyTaskListRow } from "~/services/types";

definePageMeta({ title: "meta.verify" });

// 2-level navigation (spec 2026-11-18): level 1 lists the picking order
// numbers derived from the pending verify tasks (a cross-order task appears
// under each of its orders); level 2 (/verify/order/[orderNo]) lists the
// order's box tasks.
const { t } = useI18n();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
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
const orders = computed(() => {
  const q = search.value.trim().toLowerCase();
  const seen = new Map<string, number>();
  for (const task of rawRows.value) {
    for (const orderNo of task.orderNos) {
      if (q && !orderNo.toLowerCase().includes(q)) continue;
      seen.set(orderNo, (seen.get(orderNo) ?? 0) + 1);
    }
  }
  return [...seen]
    .map(([orderNo, taskCount]) => ({ orderNo, taskCount }))
    .sort((a, b) => a.orderNo.localeCompare(b.orderNo));
});

// Scanning a printed carton label opens its box (and stamps the box's
// carton_label_verified — spec 2026-10-30); otherwise a box QR (or its id
// typed on the wedge) opens that box directly.
useHardwareScanner({
  enabled: () => rawRows.value.length > 0,
  onScan: async (rawValue) => {
    const raw = rawValue.trim();
    if (!raw) return false;
    const carton = await warehouse.lookupVerifyTaskByLabel(raw);
    if (carton) {
      router.push(`/verify/${carton.shippingBoxId}`);
      showToast(t("verify.cartonLabelVerified"));
      return true;
    }
    const tasks = rawRows.value;
    const q = raw.toLowerCase();
    const boxMatches = (b: string) => b.toLowerCase() === q || b.toLowerCase().includes(q);
    const matches = tasks.filter((t) => boxMatches(t.shippingBoxId));
    if (matches.length === 1) {
      router.push(`/verify/${matches[0].shippingBoxId}`);
    } else {
      showToast(t("verify.boxNotFound", { id: raw }));
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
</style>
