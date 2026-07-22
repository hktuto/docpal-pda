<template>
  <div>
    <p class="page-hint">
      {{ $t('putAway.hint') }}
    </p>

    <p v-if="pending" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: error }) }}</p>
    <p v-else-if="rows.length === 0" class="empty">{{ $t('common.noReceivingOrdersNeedPutAway') }}</p>

    <NuxtLink
      v-for="ro in rows"
      :key="ro.id"
      :to="`/put-away/${ro.id}`"
      class="card list-card"
    >
      <div class="list-card__header">
        <span class="list-card__title">{{ ro.batchNo }}</span>
        <span class="badge" :class="badgeClass(ro.status)">{{ statusLabel.receiving(ro.status) }}</span>
      </div>
      <p class="list-card__meta">
        {{ ro.supplierName || $t('common.noSupplier') }}
      </p>
      <div class="list-card__footer">
        <span class="list-card__date">{{ $t('putAway.unboxedItems', { count: ro.unboxedItems }) }}</span>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { badgeClass } from "~/composables/useStatusBadge";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useWarehouse } from "~/composables/useWarehouse";
import type { PutAwayCandidate } from "~/services/types";

definePageMeta({ title: "meta.putAway" });

const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();

useHead({ title: t("putAway.title") });

const pending = ref(true);
const error = ref<string | null>(null);
const rows = ref<PutAwayCandidate[]>([]);

async function load() {
  try {
    rows.value = await warehouse.getPutAwayCandidates();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

useVisibleReload(load);
</script>

<style scoped>
.page-hint {
  margin: -0.25rem 0 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}

</style>
