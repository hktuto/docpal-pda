<template>
  <div>
    <p v-if="pending" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: error }) }}</p>

    <template v-else-if="task">
      <DetailHeader
        v-model="headerExpanded"
        :title="task.order.orderNo || $t('common.noData')"
        :status="task.task.status"
        :label="statusLabel.verify(task.task.status)"
        :flush-top="route.meta.props?.noPadding"
        style="margin-bottom: 1.5rem;"
      >
        <template #actions>
          <NuxtLink
            v-if="task.order.status === 'finished'"
            :to="`/picking/${task.task.pickingOrderId}`"
            class="btn btn--small"
          >
            {{ $t('actions.viewPickingOrder') }}
          </NuxtLink>
        </template>

        <div class="detail-row">
          <span class="detail-label">{{ $t('verify.detail.shipTo') }}</span>
          <span>{{ task.order.shipTo || $t('common.noData') }}</span>
        </div>
      </DetailHeader>

      <h2 class="section-title">{{ $t('verify.detail.boxes') }}</h2>
      <p class="scan-hint">{{ $t('verify.detail.scanHint') }}</p>
      <p v-if="!task.boxes.length" class="empty">{{ $t('verify.detail.noBoxes') }}</p>

      <div
        v-for="box in task.boxes"
        :key="box.id"
        class="card"
        style="margin-bottom: 1.5rem;"
      >
        <div class="detail-row">
          <span class="detail-label">{{ $t('verify.detail.box') }}</span>
          <span class="card__title">{{ box.id }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">{{ $t('verify.detail.status') }}</span>
          <span class="badge" :class="badgeClass(box.status)">{{ statusLabel.box(box.status) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">{{ $t('verify.detail.packages') }}</span>
          <span>{{ $t('common.packagesVerified', { verified: verifiedCount(box), total: box.packages.length }) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">{{ $t('verify.detail.measurements') }}</span>
          <span style="text-align: right; font-size: 0.8125rem;">
            {{ box.boxSize || $t('common.noData') }}
            · {{ box.grossWeight ?? $t('common.noData') }} / {{ box.netWeight ?? $t('common.noData') }} {{ $t('common.kg') }}
            · {{ box.destinationCountry || $t('common.noData') }}
          </span>
        </div>

        <div style="margin-top: 0.75rem; display: flex; gap: 0.5rem;">
          <NuxtLink
            :to="`/verify/${task.task.id}/box/${box.id}`"
            class="btn"
            :class="{ 'btn--small': box.status === 'closed' }"
          >
            {{ box.status === 'closed' ? $t('verify.detail.viewBox') : $t('verify.detail.openBox') }}
          </NuxtLink>
          <button
            v-if="box.status === 'closed' && task.task.status === 'pending'"
            class="btn btn--small btn--ghost"
            :disabled="reopeningBoxId === box.id"
            @click="reopen(box.id)"
          >
            {{ reopeningBoxId === box.id ? $t('verify.detail.reopening') : $t('actions.reopenBox') }}
          </button>
        </div>
      </div>

      <div v-if="canComplete" style="margin-top: 1.5rem;">
        <button class="btn" @click="complete" :disabled="completing">
          {{ completing ? $t('verify.detail.completing') : $t('verify.detail.completeVerify') }}
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { useToast } from "~/composables/useToast";
import { badgeClass } from "~/composables/useStatusBadge";
import { useVisibleReload } from "~/composables/useVisibleReload";
import type { VerifyTaskDetail, MeasuringBox } from "~/services/types";

definePageMeta({ title: "meta.verifyDetail", props: { noPadding: true } });

const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const router = useRouter();
const { showToast } = useToast();

useHead({ title: t('verify.detail.title') });

const route = useRoute();
const taskId = route.params.id as string;

const pending = ref(true);
const error = ref<string | null>(null);
const task = ref<VerifyTaskDetail | null>(null);
const headerExpanded = ref(false);
const completing = ref(false);
const reopeningBoxId = ref<string | null>(null);

async function load() {
  try {
    const data = await warehouse.getVerifyTask(taskId);
    task.value = data ?? null;
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

function verifiedCount(box: MeasuringBox) {
  return box.packages.filter((p) => p.verifyVerified).length;
}

// Mirrors the backend guard: every box closed AND every package re-scanned
// (verify_verified) before the verify pass can complete.
const canComplete = computed(() => {
  if (!task.value || task.value.task.status !== "pending") return false;
  if (!task.value.boxes.length) return false;
  return task.value.boxes.every(
    (box) => box.status === "closed" && box.packages.every((p) => p.verifyVerified)
  );
});

async function complete() {
  completing.value = true;
  try {
    await warehouse.completeVerifyTask(taskId);
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    completing.value = false;
  }
}

// Reopen a closed box so the worker can re-measure it during this verify
// task (backend: box → open, packages un-verified).
async function reopen(boxId: string) {
  reopeningBoxId.value = boxId;
  try {
    await warehouse.reopenShippingBox(boxId);
    await load();
  } catch (e: unknown) {
    showToast(errorMessage(e));
  } finally {
    reopeningBoxId.value = null;
  }
}

useVisibleReload(load);

// Scanning a box QR (or typing its id on the wedge) opens that box directly.
// Exact id wins; otherwise a unique substring match (e.g. the daily seq).
useHardwareScanner({
  enabled: () => !!task.value,
  onScan: (rawValue) => {
    const boxes = task.value?.boxes ?? [];
    const q = rawValue.trim().toLowerCase();
    if (!q) return;
    const exact = boxes.find((b) => b.id.toLowerCase() === q);
    const matches = exact ? [exact] : boxes.filter((b) => b.id.toLowerCase().includes(q));
    if (matches.length === 1) {
      router.push(`/verify/${taskId}/box/${matches[0].id}`);
    } else {
      showToast(t("verify.detail.boxNotFound", { id: rawValue.trim() }));
    }
  },
});
</script>

<style scoped>
.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--border);
}

.detail-row:last-child {
  border-bottom: none;
}

.detail-label {
  font-size: 0.8125rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.scan-hint {
  margin: -0.5rem 0 1rem;
  color: var(--muted);
  font-size: 0.8125rem;
}

</style>
