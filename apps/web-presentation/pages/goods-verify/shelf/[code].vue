<template>
  <div>
    <p class="card__meta" style="margin-bottom: 1rem;">
      {{ $t('goodsVerify.shelf.intro', { shelfCode }) }}
    </p>

    <input
      v-model="search"
      class="search"
      type="text"
      :placeholder="$t('goodsVerify.shelf.searchPlaceholder')"
      style="margin-bottom: 1rem;"
    />

    <p v-if="loading" class="empty">{{ $t('common.loading') }}</p>
    <div v-else-if="error" class="error">{{ $t('common.errorPrefix', { message: error }) }}</div>
    <p v-else-if="boxes.length === 0" class="empty">{{ $t('goodsVerify.shelf.empty') }}</p>

    <NuxtLink
      v-for="box in filteredBoxes"
      :key="box.id"
      :to="`/goods-verify/box/${box.id}`"
      class="card"
      :class="{ 'card--done': box.status === 'verified' }"
    >
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;">
        <div>
          <p class="card__title">{{ box.id }}</p>
          <p class="card__meta">
            {{ box.verifiedCount }} / {{ box.itemCount }} {{ $t('goodsVerify.shelf.verified') }}
          </p>
          <p class="card__meta">
            <span :style="{ color: box.checkedToday ? '#16a34a' : 'inherit' }">
              {{ $t('goodsVerify.shelf.lastCheck', { datetime: box.lastCheckAt ? new Date(box.lastCheckAt).toLocaleString() : $t('common.noData') }) }}
            </span>
          </p>
        </div>
        <div style="text-align: right;">
          <span class="badge" :class="badgeClass(box.status)">{{ statusLabel.box(box.status) }}</span>
          <p v-if="box.checkedToday" class="badge" style="margin-top: 0.25rem; background: #dcfce7; color: #166534;">
            {{ $t('common.today') }}
          </p>
        </div>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { useWarehouse } from "~/composables/useWarehouse";
import { badgeClass } from "~/composables/useStatusBadge";
import { useStatusLabel } from "~/composables/useStatusLabel";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useErrorMessage } from "~/composables/errorMessage";
import type { GoodsVerifyShelfBoxSummary } from "~/services/types";

definePageMeta({ title: "meta.goodsVerifyShelf" });

const { t } = useI18n();
useHead({ title: t('goodsVerify.shelf.title') });

const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const route = useRoute();
const shelfCode = route.params.code as string;

const boxes = ref<GoodsVerifyShelfBoxSummary[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const search = ref("");

async function load() {
  loading.value = true;
  error.value = null;
  try {
    boxes.value = await warehouse.getShelfBoxes(shelfCode);
  } catch (e: unknown) {
    error.value = errorMessage(e);
    boxes.value = [];
  } finally {
    loading.value = false;
  }
}

const filteredBoxes = computed(() => {
  const term = search.value.trim().toLowerCase();
  if (!term) return boxes.value;
  return boxes.value.filter(
    (b) =>
      b.id.toLowerCase().includes(term) ||
      b.status.toLowerCase().includes(term)
  );
});

useVisibleReload(load);
</script>

<style scoped>
</style>
