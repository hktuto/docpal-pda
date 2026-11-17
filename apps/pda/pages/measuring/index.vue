<template>
  <AppListPage
    v-model:search="search"
    search-placeholder="measuring.searchPlaceholder"
    :apply-on-search="false"
    :loading="loading"
    :error="loadError"
    :empty="orders.length === 0"
    empty-text="common.noPendingMeasuringTasks"
    :shown="orders.length"
    :total="orders.length"
    :has-more="false"
    hide-footer
    :reload="load"
  >

    <AppListRow
      v-for="order in orders"
      :key="order.orderId"
      :to="`/measuring/order/${order.orderId}`"
      :title="order.orderNo"
      :meta="[t('measuring.boxCount', { count: order.boxCount })]"
    />
  </AppListPage>
</template>

<script setup lang="ts">
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { useToast } from "~/composables/useToast";

definePageMeta({ title: "meta.measuring" });

// 2-level navigation (spec 2026-11-18): level 1 lists the picking orders,
// level 2 (/measuring/order/[orderId]) lists the order's boxes.
const { t } = useI18n();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const router = useRouter();
const { showToast } = useToast();

useHead({ title: t('measuring.title') });

const rawGroups = ref<{ orderId: string; orderNo: string; boxCount: number }[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    const groups = await warehouse.getMeasuringBoxes();
    rawGroups.value = groups.map((g) => ({ orderId: g.orderId, orderNo: g.orderNo, boxCount: g.boxes.length }));
  } catch (e: unknown) {
    loadError.value = errorMessage(e);
    rawGroups.value = [];
  } finally {
    loading.value = false;
  }
}

const search = ref("");
const orders = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rawGroups.value;
  return rawGroups.value.filter((g) => g.orderNo.toLowerCase().includes(q));
});

// Scanning a box QR (or typing its id on the wedge) still opens that box
// directly from level 1. Exact id wins; otherwise a unique substring match.
useHardwareScanner({
  enabled: () => rawGroups.value.length > 0,
  onScan: async (rawValue) => {
    const q = rawValue.trim().toLowerCase();
    if (!q) return false;
    const groups = await warehouse.getMeasuringBoxes();
    const boxes = groups.flatMap((g) => g.boxes);
    const exact = boxes.find((b) => b.boxId.toLowerCase() === q);
    const matches = exact ? [exact] : boxes.filter((b) => b.boxId.toLowerCase().includes(q));
    if (matches.length === 1) {
      router.push(`/measuring/${matches[0].boxId}`);
    } else {
      showToast(t("measuring.boxNotFound", { id: rawValue.trim() }));
      return false;
    }
  },
});
</script>

