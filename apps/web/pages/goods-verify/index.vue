<template>
  <div>
    <input
      v-model="search"
      class="search"
      type="text"
      :placeholder="$t('goodsVerify.searchPlaceholder')"
    />

    <p v-if="loading" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: loadError }) }}</p>
    <p v-else-if="rows.length === 0" class="empty">{{ $t('goodsVerify.empty') }}</p>

    <NuxtLink
      v-for="shelf in rows"
      :key="shelf.code"
      :to="`/goods-verify/shelf/${shelf.code}`"
      class="card list-card"
    >
      <div class="list-card__header">
        <span class="list-card__title">{{ shelf.code }}</span>
        <span class="badge badge--info">{{ shelf.boxCount }} {{ $t(shelf.boxCount === 1 ? 'common.box' : 'common.boxes') }}</span>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { useWarehouse } from "~/composables/useWarehouse";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useErrorMessage } from "~/composables/errorMessage";
import type { ShelfWithBoxCount } from "~/services/types";

definePageMeta({ title: "meta.goodsVerify" });

const { t } = useI18n();
useHead({ title: t('goodsVerify.title') });

const errorMessage = useErrorMessage();
const warehouse = useWarehouse();

const rawRows = ref<ShelfWithBoxCount[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const search = ref("");

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    rawRows.value = await warehouse.getShelvesWithBoxes();
  } catch (e: unknown) {
    loadError.value = errorMessage(e);
    rawRows.value = [];
  } finally {
    loading.value = false;
  }
}

const rows = computed(() => {
  const term = search.value.trim().toLowerCase();
  if (!term) return rawRows.value;
  return rawRows.value.filter(
    (r) =>
      r.code.toLowerCase().includes(term) ||
      (r.zone?.toLowerCase().includes(term) ?? false)
  );
});

useVisibleReload(load);
</script>

<style scoped>
.list-card__meta {
  margin: 0;
}
</style>
