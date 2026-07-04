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
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useErrorMessage } from "~/composables/errorMessage";

definePageMeta({ title: "Measuring" });

const errorMessage = useErrorMessage();

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
  } catch (e: unknown) {
    loadError.value = errorMessage(e);
    rawRows.value = [];
  } finally {
    loading.value = false;
  }
}

const rows = computed(() => rawRows.value);

useVisibleReload(load);
</script>

<style scoped>
.page-hint {
  margin: -0.25rem 0 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}

</style>
