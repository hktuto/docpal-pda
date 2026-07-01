<template>
  <div>
    <div style="display: flex; gap: 0.5rem; margin-bottom: 1rem; align-items: center;">
      <input
        v-model="search"
        class="search"
        type="text"
        placeholder="Search by ref or supplier…"
        style="margin-bottom: 0;"
      />
      <NuxtLink to="/picking-by-receiving" class="btn" style="white-space: nowrap;">
        By receiving
      </NuxtLink>
    </div>

    <p v-if="loading" class="empty">Loading…</p>
    <p v-else-if="rows.length === 0" class="empty">No picking orders need action.</p>

    <NuxtLink
      v-for="po in rows"
      :key="po.id"
      :to="`/picking/${po.id}`"
      class="card"
    >
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;">
        <div>
          <p class="card__title">{{ po.ref_no }}</p>
          <p class="card__meta">
            {{ po.supplier_name || "No supplier" }}
          </p>
          <p class="card__meta">Ship to: {{ po.ship_to || "—" }}</p>
        </div>
        <div style="text-align: right;">
          <span class="badge">{{ po.status }}</span>
          <p class="card__meta" style="margin-top: 0.25rem;">
            {{ po.delivery_date ? new Date(po.delivery_date).toLocaleDateString() : "No date" }}
          </p>
        </div>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { useLiveQuery } from "@electric-sql/pglite-vue";

definePageMeta({ title: "Picking" });

interface PickingOrderRow {
  id: string;
  ref_no: string;
  status: string;
  delivery_date: string | null;
  supplier_name: string | null;
  ship_to: string | null;
}

const search = ref("");

const result = useLiveQuery<PickingOrderRow>(
  `SELECT po.id, po.ref_no, po.status, po.delivery_date, po.ship_to, s.name AS supplier_name
   FROM picking_orders po
   LEFT JOIN suppliers s ON po.supplier_id = s.id
   WHERE po.status != 'finished'
   ORDER BY po.delivery_date;`
);

const rows = computed(() => {
  const raw = result.rows.value ?? [];
  const term = search.value.trim().toLowerCase();
  if (!term) return raw;
  return raw.filter(
    (r) =>
      r.ref_no.toLowerCase().includes(term) ||
      (r.supplier_name?.toLowerCase().includes(term) ?? false)
  );
});
const loading = computed(() => result.rows.value === undefined);
</script>
