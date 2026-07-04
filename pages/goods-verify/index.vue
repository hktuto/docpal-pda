<template>
  <div>
    <input
      v-model="search"
      class="search"
      type="text"
      placeholder="Search shelf code or zone…"
    />

    <p v-if="loading" class="empty">Loading…</p>
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: loadError }) }}</p>
    <p v-else-if="rows.length === 0" class="empty">No shelves found.</p>

    <NuxtLink
      v-for="shelf in rows"
      :key="shelf.code"
      :to="`/goods-verify/shelf/${shelf.code}`"
      class="card list-card"
    >
      <div class="list-card__header">
        <span class="list-card__title">{{ shelf.code }}</span>
        <span class="badge badge--info">{{ shelf.box_count }} {{ shelf.box_count === 1 ? "box" : "boxes" }}</span>
      </div>
      <p class="list-card__meta">
        {{ shelf.zone || "No zone" }}
      </p>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { getShelvesWithBoxes, type ShelfWithBoxCount } from "~/db/goodsVerify";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useErrorMessage } from "~/composables/errorMessage";

definePageMeta({ title: "Goods Verify" });

const errorMessage = useErrorMessage();

const db = await useDb();

const rawRows = ref<ShelfWithBoxCount[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const search = ref("");

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    rawRows.value = await getShelvesWithBoxes(db);
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
