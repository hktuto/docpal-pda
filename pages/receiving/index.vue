<template>
  <div>
    <div style="display: flex; gap: 0.5rem; margin-bottom: 1rem;">
      <button
        v-for="opt in filters"
        :key="opt.value"
        class="btn btn--small"
        :style="filter === opt.value ? 'background: var(--primary-hover);' : 'background: var(--bg); color: var(--text); border-color: var(--border);'"
        @click="filter = opt.value"
      >
        {{ opt.label }}
      </button>
    </div>

    <input
      v-model="search"
      class="search"
      type="text"
      placeholder="Search by ref or supplier…"
    />

    <p v-if="loading" class="empty">Loading…</p>
    <p v-else-if="rows.length === 0" class="empty">No receiving orders found.</p>

    <NuxtLink
      v-for="ro in rows"
      :key="ro.id"
      :to="`/receiving/${ro.id}`"
      class="card"
    >
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;">
        <div>
          <p class="card__title">{{ ro.ref_no }}</p>
          <p class="card__meta">
            {{ ro.supplier_name || "No supplier" }}
          </p>
        </div>
        <div style="text-align: right;">
          <span class="badge">{{ ro.status }}</span>
          <p class="card__meta" style="margin-top: 0.25rem;">
            {{ ro.delivery_date ? new Date(ro.delivery_date).toLocaleDateString() : "No date" }}
          </p>
          <span v-if="ro.remaining_qty > 0" class="badge" style="margin-top: 0.25rem; background: #dcfce7; color: #166534;">
            {{ ro.remaining_qty }} remaining
          </span>
        </div>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { useLiveQuery } from "@electric-sql/pglite-vue";

definePageMeta({ title: "Receiving" });

type Filter = "all" | "pending" | "in_hand";

interface ReceivingOrderRow {
  id: string;
  ref_no: string;
  status: string;
  delivery_date: string | null;
  supplier_name: string | null;
  remaining_qty: number;
}

const filters: { label: string; value: Filter }[] = [
  { label: "All", value: "all" },
  { label: "Pending", value: "pending" },
  { label: "In hand", value: "in_hand" },
];

const filter = ref<Filter>("in_hand");
const search = ref("");

const query = computed(() => {
  let where = "1=1";
  if (filter.value === "pending") where = "ro.status = 'pending'";
  if (filter.value === "in_hand") where = "ro.status = 'in_hand'";

  return `SELECT
    ro.id,
    ro.ref_no,
    ro.status,
    ro.delivery_date,
    s.name AS supplier_name,
    COALESCE(SUM(
      CASE
        WHEN ro.status = 'in_hand'
        THEN rii.received_qty - rii.picked_qty - rii.put_away_qty -
             COALESCE(alloc.allocated_qty, 0)
        ELSE 0
      END
    ), 0) AS remaining_qty
  FROM receiving_orders ro
  LEFT JOIN suppliers s ON s.id = ro.supplier_id
  LEFT JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
  LEFT JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
  LEFT JOIN (
    SELECT receiving_invoice_item_id, SUM(qty) AS allocated_qty
    FROM allocations
    WHERE receiving_invoice_item_id IS NOT NULL
    GROUP BY receiving_invoice_item_id
  ) alloc ON alloc.receiving_invoice_item_id = rii.id
  WHERE ${where}
  GROUP BY ro.id, ro.ref_no, ro.status, ro.delivery_date, s.name
  ORDER BY ro.delivery_date;`;
});

const result = useLiveQuery<ReceivingOrderRow>(query);

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
