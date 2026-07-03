<template>
  <div>
    <div style="margin-bottom: 1rem;">
      <NuxtLink to="/goods-verify" class="btn btn--small">← All shelves</NuxtLink>
    </div>

    <p class="card__meta" style="margin-bottom: 1rem;">
      Boxes on shelf {{ shelfCode }}.
    </p>

    <input
      v-model="search"
      class="search"
      type="text"
      placeholder="Search box ID or status…"
      style="margin-bottom: 1rem;"
    />

    <p v-if="loading" class="empty">Loading…</p>
    <p v-else-if="boxes.length === 0" class="empty">No boxes on this shelf.</p>

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
            {{ box.verifiedCount }} / {{ box.itemCount }} verified
          </p>
          <p class="card__meta">
            Last check:
            <span :style="{ color: box.checkedToday ? '#16a34a' : 'inherit' }">
              {{ box.lastCheckAt ? new Date(box.lastCheckAt).toLocaleString() : "—" }}
            </span>
          </p>
        </div>
        <div style="text-align: right;">
          <span class="badge" :class="badgeClass(box.status)">{{ box.status }}</span>
          <p v-if="box.checkedToday" class="badge" style="margin-top: 0.25rem; background: #dcfce7; color: #166534;">
            Today
          </p>
        </div>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { getShelfBoxesByShelf, type ShelfBoxSummary } from "~/db/goodsVerify";

const { badgeClass } = useStatusBadge();

definePageMeta({ title: "Shelf Boxes" });

const route = useRoute();
const shelfCode = route.params.code as string;

const db = await useDb();

const boxes = ref<ShelfBoxSummary[]>([]);
const loading = ref(true);
const search = ref("");

async function load() {
  loading.value = true;
  try {
    boxes.value = await getShelfBoxesByShelf(db, shelfCode);
  } catch (e: any) {
    console.error(e);
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
</style>
