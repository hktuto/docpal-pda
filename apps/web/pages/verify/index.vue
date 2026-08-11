<template>
  <div>
    <p class="page-hint">
      {{ $t('verify.hint') }}
    </p>

    <p v-if="loading" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: loadError }) }}</p>
    <p v-else-if="rows.length === 0" class="empty">{{ $t('common.noPendingVerifyTasks') }}</p>

    <NuxtLink
      v-for="task in rows"
      :key="task.taskId"
      :to="`/verify/${task.shippingBoxId}`"
      class="card list-card"
    >
      <div class="list-card__header">
        <span class="list-card__title">{{ task.shippingBoxId }}</span>
        <span class="badge" :class="badgeClass(task.boxStatus)">{{ statusLabel.box(task.boxStatus) }}</span>
      </div>
      <p class="list-card__meta">
        {{ task.orderNos.join(', ') || $t('common.noData') }}
        <template v-if="task.destinationCountry"> · {{ task.destinationCountry }}</template>
      </p>
      <div class="list-card__footer">
        <span class="list-card__date">
          {{ $t('common.packagesVerified', { verified: task.verifyVerifiedCount, total: task.packageCount }) }}
        </span>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { useToast } from "~/composables/useToast";
import { badgeClass } from "~/composables/useStatusBadge";
import type { VerifyTaskListRow } from "~/services/types";

definePageMeta({ title: "meta.verify" });

const { t } = useI18n();
const statusLabel = useStatusLabel();
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

const rows = computed(() => rawRows.value);

useVisibleReload(load);

// Scanning a box QR (or typing its id on the wedge) opens that box directly.
// Exact id wins; otherwise a unique substring match (e.g. the daily seq).
useHardwareScanner({
  enabled: () => rows.value.length > 0,
  onScan: (rawValue) => {
    const boxes = rows.value;
    const q = rawValue.trim().toLowerCase();
    if (!q) return false;
    const exact = boxes.find((b) => b.shippingBoxId.toLowerCase() === q);
    const matches = exact ? [exact] : boxes.filter((b) => b.shippingBoxId.toLowerCase().includes(q));
    if (matches.length === 1) {
      router.push(`/verify/${matches[0].shippingBoxId}`);
    } else {
      showToast(t("verify.boxNotFound", { id: rawValue.trim() }));
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
