<template>
  <div>
    <p v-if="pending" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: error }) }}</p>

    <template v-else-if="task">
      <DetailHeader
        v-model="headerExpanded"
        :title="task.pickingOrder?.refNo || $t('common.noData')"
        :status="task.status"
        :label="statusLabel.measuring(task.status)"
        :flush-top="route.meta.props?.noPadding"
        style="margin-bottom: 1.5rem;"
      >
        <template #actions>
          <NuxtLink
            v-if="task.pickingOrder?.status === 'finished'"
            :to="`/picking/${task.pickingOrderId}`"
            class="btn btn--small"
          >
            {{ $t('actions.viewPickingOrder') }}
          </NuxtLink>
        </template>

        <div class="detail-row">
          <span class="detail-label">{{ $t('measuring.detail.supplier') }}</span>
          <span>{{ task.pickingOrder?.supplier?.name || $t('common.noData') }}</span>
        </div>
      </DetailHeader>

      <h2 class="section-title">{{ $t('measuring.detail.boxes') }}</h2>
      <p v-if="!task.shippingBoxes.length" class="empty">{{ $t('measuring.detail.noBoxes') }}</p>

      <div
        v-for="box in task.shippingBoxes"
        :key="box.id"
        class="card"
        style="margin-bottom: 1.5rem;"
      >
        <div class="detail-row">
          <span class="detail-label">{{ $t('measuring.detail.box') }}</span>
          <span class="card__title">{{ box.id }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">{{ $t('measuring.detail.status') }}</span>
          <span class="badge" :class="badgeClass(box.status)">{{ statusLabel.box(box.status) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">{{ $t('measuring.detail.packages') }}</span>
          <span>{{ $t('common.packagesVerified', { verified: verifiedCount(box), total: box.packages.length }) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">{{ $t('measuring.detail.measurements') }}</span>
          <span style="text-align: right; font-size: 0.8125rem;">
            {{ box.boxSize || $t('common.noData') }}
            · {{ box.grossWeight ?? $t('common.noData') }} / {{ box.netWeight ?? $t('common.noData') }} {{ $t('common.kg') }}
            · {{ box.destinationCountry || $t('common.noData') }}
          </span>
        </div>

        <div style="margin-top: 0.75rem;">
          <NuxtLink
            :to="`/measuring/${task.id}/box/${box.id}`"
            class="btn"
            :class="{ 'btn--small': box.status === 'closed' }"
          >
            {{ box.status === 'closed' ? $t('measuring.detail.viewBox') : $t('measuring.detail.openBox') }}
          </NuxtLink>
        </div>
      </div>

      <div v-if="canComplete" style="margin-top: 1.5rem;">
        <button class="btn" @click="complete" :disabled="completing">
          {{ completing ? $t('measuring.detail.completing') : $t('measuring.detail.completeMeasuring') }}
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { badgeClass } from "~/composables/useStatusBadge";
import { useVisibleReload } from "~/composables/useVisibleReload";
import type { MeasuringTaskDetail } from "~/services/types";

definePageMeta({ title: "meta.measuringDetail", props: { noPadding: true } });

const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();

useHead({ title: t('measuring.detail.title') });

const route = useRoute();
const taskId = route.params.id as string;

const pending = ref(true);
const error = ref<string | null>(null);
const task = ref<MeasuringTaskDetail | null>(null);
const headerExpanded = ref(false);
const completing = ref(false);

async function load() {
  try {
    const data = await warehouse.getMeasuringTask(taskId);
    task.value = data ?? null;
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

function verifiedCount(box: MeasuringTaskDetail["shippingBoxes"][number]) {
  return box.packages.filter((p) => p.verified).length;
}

const canComplete = computed(() => {
  if (!task.value || task.value.status !== "pending") return false;
  return task.value.shippingBoxes.length > 0 && task.value.shippingBoxes.every((box) => box.status === "closed");
});

async function complete() {
  completing.value = true;
  try {
    await warehouse.completeMeasuringTask(taskId);
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    completing.value = false;
  }
}

useVisibleReload(load);
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

</style>
