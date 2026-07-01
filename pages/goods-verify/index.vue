<template>
  <div>
    <p class="card__meta" style="margin-bottom: 1rem;">
      Shelves that have shelf boxes waiting to be verified.
    </p>

    <p v-if="loading" class="empty">Loading…</p>
    <p v-else-if="rows.length === 0" class="empty">No shelves with boxes.</p>

    <NuxtLink
      v-for="shelf in rows"
      :key="shelf.code"
      :to="`/goods-verify/shelf/${shelf.code}`"
      class="card"
    >
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;">
        <div>
          <p class="card__title">{{ shelf.code }}</p>
          <p class="card__meta">
            {{ shelf.zone || "No zone" }}
          </p>
        </div>
        <span class="badge">{{ shelf.box_count }} {{ shelf.box_count === 1 ? "box" : "boxes" }}</span>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { useLiveQuery } from "@electric-sql/pglite-vue";

definePageMeta({ title: "Goods Verify" });

interface GoodsVerifyShelfRow {
  code: string;
  zone: string | null;
  box_count: number;
}

const result = useLiveQuery<GoodsVerifyShelfRow>(
  `SELECT sh.code, sh.zone, COUNT(sb.id) AS box_count
   FROM shelves sh
   INNER JOIN shelf_boxes sb ON sb.shelf_code = sh.code
   GROUP BY sh.code, sh.zone
   ORDER BY sh.code;`
);

const rows = computed(() => result.rows.value ?? []);
const loading = computed(() => result.rows.value === undefined);
</script>
