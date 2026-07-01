<template>
  <div>
    <p class="card__meta" style="margin-bottom: 1rem;">
      Picking orders ready for measuring and packing.
    </p>

    <p v-if="loading" class="empty">Loading…</p>
    <p v-else-if="rows.length === 0" class="empty">No pending measuring tasks.</p>

    <NuxtLink
      v-for="task in rows"
      :key="task.id"
      :to="`/measuring/${task.id}`"
      class="card"
    >
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;">
        <div>
          <p class="card__title">{{ task.picking_order_ref }}</p>
          <p class="card__meta">
            {{ task.supplier_name || "No supplier" }}
          </p>
        </div>
        <div style="text-align: right;">
          <span class="badge">{{ task.status }}</span>
          <p class="card__meta" style="margin-top: 0.25rem;">
            {{ task.packed_items }} / {{ task.total_items }} packed
          </p>
        </div>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { useLiveQuery } from "@electric-sql/pglite-vue";

definePageMeta({ title: "Measuring" });

interface MeasuringRow {
  id: string;
  status: string;
  picking_order_ref: string | null;
  supplier_name: string | null;
  total_items: number;
  packed_items: number;
}

const result = useLiveQuery<MeasuringRow>(
  `SELECT mt.id,
          mt.status,
          po.ref_no AS picking_order_ref,
          s.name AS supplier_name,
          COALESCE(SUM(pi.qty), 0) AS total_items,
          COALESCE(SUM(sbi.qty), 0) AS packed_items
   FROM measuring_tasks mt
   INNER JOIN picking_orders po ON po.id = mt.picking_order_id
   LEFT JOIN suppliers s ON s.id = po.supplier_id
   LEFT JOIN picking_items pi ON pi.picking_order_id = po.id
   LEFT JOIN shipping_boxes sb ON sb.measuring_task_id = mt.id
   LEFT JOIN shipping_box_items sbi ON sbi.shipping_box_id = sb.id
   WHERE mt.status = 'pending'
   GROUP BY mt.id, mt.status, po.ref_no, s.name
   ORDER BY po.ref_no;`
);

const rows = computed(() => result.rows.value ?? []);
const loading = computed(() => result.rows.value === undefined);
</script>
