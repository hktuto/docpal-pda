<template>
  <div>
    <p class="card__meta" style="margin-bottom: 1rem;">
      Boxes on this shelf waiting to be verified.
    </p>

    <p v-if="loading" class="empty">Loading…</p>
    <p v-else-if="boxes.length === 0" class="empty">No boxes on this shelf.</p>

    <NuxtLink
      v-for="box in boxes"
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
        </div>
        <span class="badge">{{ box.status }}</span>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { getShelfBoxesByShelf, type ShelfBoxSummary } from "~/db/goodsVerify";

definePageMeta({ title: "Shelf Boxes" });

const route = useRoute();
const shelfCode = route.params.code as string;

const db = useDb();

const boxes = ref<ShelfBoxSummary[]>([]);
const loading = ref(true);

async function load() {
  boxes.value = await getShelfBoxesByShelf(db, shelfCode);
  loading.value = false;
}

onMounted(load);
</script>

<style scoped>
.card--done {
  border-left: 4px solid #22c55e;
}
</style>
