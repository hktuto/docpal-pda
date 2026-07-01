<template>
  <div>
    <div style="display: flex; justify-content: flex-end; margin-bottom: 0.25rem;">
      <NuxtLink to="/home" class="btn btn--small">Home</NuxtLink>
    </div>
    <p class="card__meta" style="margin-bottom: 1rem;">
      Select an in-hand receiving order to see which picking orders are consuming its stock.
    </p>

    <p v-if="loading" class="empty">Loading…</p>
    <p v-else-if="rows.length === 0" class="empty">No in-hand receiving orders.</p>

    <NuxtLink
      v-for="ro in rows"
      :key="ro.id"
      :to="`/picking-by-receiving/${ro.id}`"
      class="card"
    >
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;">
        <div>
          <p class="card__title">{{ ro.ref_no }}</p>
          <p class="card__meta">{{ ro.supplier_name || "No supplier" }}</p>
        </div>
        <div style="text-align: right;">
          <span class="badge">{{ ro.status }}</span>
          <p class="card__meta" style="margin-top: 0.25rem;">
            {{ ro.delivery_date ? new Date(ro.delivery_date).toLocaleDateString() : "No date" }}
          </p>
        </div>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { useLiveQuery } from "@electric-sql/pglite-vue";

definePageMeta({ title: "Picking by Receiving" });

interface ReceivingOrderRow {
  id: string;
  ref_no: string;
  status: string;
  delivery_date: string | null;
  supplier_name: string | null;
}

const result = useLiveQuery<ReceivingOrderRow>(
  `SELECT ro.id, ro.ref_no, ro.status, ro.delivery_date, s.name AS supplier_name
   FROM receiving_orders ro
   LEFT JOIN suppliers s ON ro.supplier_id = s.id
   WHERE ro.status = 'in_hand'
   ORDER BY ro.delivery_date;`
);

const rows = computed(() => result.rows.value ?? []);
const loading = computed(() => result.rows.value === undefined);
</script>
