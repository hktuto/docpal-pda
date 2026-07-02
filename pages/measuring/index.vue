<template>
  <div>
    <p class="page-hint">
      Picking orders ready for measuring and packing.
    </p>

    <p v-if="loading" class="empty">Loading…</p>
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">Error: {{ loadError }}</p>
    <p v-else-if="rows.length === 0" class="empty">No pending measuring tasks.</p>

    <NuxtLink
      v-for="task in rows"
      :key="task.id"
      :to="`/measuring/${task.id}`"
      class="card list-card"
    >
      <div class="list-card__header">
        <span class="list-card__title">{{ task.picking_order_ref }}</span>
        <span class="badge badge--pending">{{ task.status }}</span>
      </div>
      <p class="list-card__meta">
        {{ task.supplier_name || "No supplier" }}
      </p>
      <div class="list-card__footer">
        <span class="list-card__date">
          {{ task.packed_items }} / {{ task.total_items }} packed
        </span>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ title: "Measuring" });

interface MeasuringRow {
  id: string;
  status: string;
  picking_order_ref: string | null;
  supplier_name: string | null;
  total_items: number;
  packed_items: number;
}

const db = await useDb();

const rawRows = ref<MeasuringRow[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    const result = await db.execute<MeasuringRow>(
      `SELECT mt.id,
              mt.status,
              po.ref_no AS picking_order_ref,
              s.name AS supplier_name,
              COALESCE(SUM(pi.qty), 0) AS total_items,
              COALESCE(SUM(pkg.qty), 0) AS packed_items
       FROM measuring_tasks mt
       INNER JOIN picking_orders po ON po.id = mt.picking_order_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN picking_items pi ON pi.picking_order_id = po.id
       LEFT JOIN shipping_boxes sb ON sb.measuring_task_id = mt.id
       LEFT JOIN picking_packages pkg ON pkg.shipping_box_id = sb.id
       WHERE mt.status = 'pending'
       GROUP BY mt.id, mt.status, po.ref_no, s.name
       ORDER BY po.ref_no;`
    );
    rawRows.value = result.rows ?? [];
  } catch (e: any) {
    loadError.value = e?.message ?? String(e);
    rawRows.value = [];
  } finally {
    loading.value = false;
  }
}

const rows = computed(() => rawRows.value);

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
.page-hint {
  margin: -0.25rem 0 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}

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
  margin: 0 0 0.75rem;
}

.list-card__footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.list-card__date {
  font-size: 0.8125rem;
  color: var(--muted);
}
</style>
