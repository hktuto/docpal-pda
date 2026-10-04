<template>
  <AppListPage
    :loading="loading"
    :error="loadError"
    :empty="rows.length === 0"
    empty-text="common.noPendingMeasuringTasks"
    :shown="rows.length"
    :total="rows.length"
    :has-more="false"
    hide-footer
    :reload="load"
  >
    <template #header>
      <p class="page-hint">{{ $t('measuring.hint') }}</p>
    </template>

    <AppListRow
      v-for="box in rows"
      :key="box.boxId"
      :to="`/measuring/${box.boxId}`"
      :title="formatRow('measuring', 'title', box)"
      :meta="[formatRow('measuring', 'meta', box), $t('common.packagesVerified', { verified: box.verifiedCount, total: box.packageCount })]"
      :chip-text="statusLabel.box(box.status)"
      :chip-class="badgeClass(box.status)"
    />
  </AppListPage>
</template>

<script setup lang="ts">
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { useToast } from "~/composables/useToast";
import { badgeClass } from "~/composables/useStatusBadge";
import type { MeasuringBoxListRow } from "~/services/types";

definePageMeta({ title: "meta.measuring" });

const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
// Row title/meta come from the warehouse's pdaListTemplates flow config
// (spec 2026-09-21-pda-list-row-templates-design.md).
const { formatRow } = useListTemplates();
const router = useRouter();
const { showToast } = useToast();

useHead({ title: t('measuring.title') });

const rawRows = ref<MeasuringBoxListRow[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    // The list is already the work queue: open boxes with ≥1 package.
    rawRows.value = await warehouse.getMeasuringBoxes();
  } catch (e: unknown) {
    loadError.value = errorMessage(e);
    rawRows.value = [];
  } finally {
    loading.value = false;
  }
}

const rows = computed(() => rawRows.value);

// Scanning a box QR (or typing its id on the wedge) opens that box directly.
// Exact id wins; otherwise a unique substring match (e.g. the daily seq).
useHardwareScanner({
  enabled: () => rows.value.length > 0,
  onScan: (rawValue) => {
    const boxes = rows.value;
    const q = rawValue.trim().toLowerCase();
    if (!q) return false;
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

<style scoped>
.page-hint {
  margin: -0.25rem 0 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}
</style>
