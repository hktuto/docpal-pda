<template>
  <div>
    <input
      v-model="search"
      class="search"
      type="text"
      placeholder="Search shelf code or zone…"
    />

    <p v-if="loading" class="empty">Loading…</p>
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">Error: {{ loadError }}</p>
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

definePageMeta({ title: "Goods Verify" });

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
  } catch (e: any) {
    loadError.value = e?.message ?? String(e);
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

onMounted(() => {
  load();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("focus", onVisible);
});

function onVisible() {
  if (document.visibilityState === "visible") {
    load();
  }
}
</script>

<style scoped>
.list-card {
  display: block;
  text-decoration: none;
}

.list-card:hover {
  text-decoration: none;
}

.list-card__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
  margin-bottom: 0.35rem;
}

.list-card__title {
  font-size: 1.0625rem;
  font-weight: 700;
  color: var(--text);
}

.list-card__meta {
  font-size: 0.875rem;
  color: var(--muted);
  margin: 0;
}
</style>
