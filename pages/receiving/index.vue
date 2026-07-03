<template>
  <div>
    <div class="filters">
      <button
        v-for="opt in filters"
        :key="opt.value"
        class="filter-chip"
        :class="{ 'filter-chip--active': filter === opt.value }"
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
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">Error: {{ loadError }}</p>
    <p v-else-if="rows.length === 0" class="empty">No receiving orders found.</p>

    <NuxtLink
      v-for="ro in rows"
      :key="ro.id"
      :to="`/receiving/${ro.id}`"
      class="card list-card"
    >
      <div class="list-card__header">
        <span class="list-card__title">{{ ro.ref_no }}</span>
        <span class="badge" :class="badgeClass(ro.status)">{{ ro.status }}</span>
      </div>
      <p class="list-card__meta">
        {{ ro.supplier_name || "No supplier" }}
      </p>
      <div class="list-card__footer">
        <span class="list-card__date">
          {{ ro.delivery_date ? new Date(ro.delivery_date).toLocaleDateString() : "No date" }}
        </span>
        <span v-if="ro.remaining_items > 0" class="badge badge--info">
          {{ ro.remaining_items }} remaining
        </span>
        <span
          v-if="ro.pending_picking_orders > 0"
          class="badge badge--info"
        >
          {{ ro.pending_picking_orders }} picking
        </span>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
const { badgeClass } = useStatusBadge();

definePageMeta({ title: "Receiving" });

type Filter = "all" | "pending" | "in_hand" | "clear";

interface ReceivingOrderRow {
  id: string;
  ref_no: string;
  status: string;
  delivery_date: string | null;
  supplier_name: string | null;
  remaining_items: number;
  pending_picking_orders: number;
}

const filters: { label: string; value: Filter }[] = [
  { label: "All", value: "all" },
  { label: "Pending", value: "pending" },
  { label: "In hand", value: "in_hand" },
  { label: "Clear", value: "clear" },
];

const filter = ref<Filter>("in_hand");
const search = ref("");

const query = computed(() => {
  let where = "1=1";
  if (filter.value === "pending") where = "ro.status = 'pending'";
  if (filter.value === "in_hand") where = "ro.status = 'in_hand'";
  if (filter.value === "clear") where = "ro.status = 'clear'";

  return `SELECT
    ro.id,
    ro.ref_no,
    ro.status,
    ro.delivery_date,
    s.name AS supplier_name,
    COALESCE(COUNT(DISTINCT CASE
      WHEN ro.status = 'in_hand'
        AND (rii.received_qty - rii.picked_qty - rii.put_away_qty -
             COALESCE(alloc.allocated_qty, 0)) > 0
      THEN rii.id
    END), 0) AS remaining_items,
    COALESCE((
      SELECT COUNT(DISTINCT po_id)
      FROM (
        SELECT po.id AS po_id
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        JOIN picking_orders po ON po.id = pi.picking_order_id
        WHERE a.receiving_invoice_item_id IN (
          SELECT rii2.id
          FROM receiving_invoices ri2
          JOIN receiving_invoice_items rii2 ON rii2.receiving_invoice_id = ri2.id
          WHERE ri2.receiving_order_id = ro.id
        )
        AND a.qty > 0
        AND po.status IN ('pending', 'picking')

        UNION ALL

        SELECT po.id AS po_id
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        JOIN picking_orders po ON po.id = pi.picking_order_id
        JOIN inventory_lots il ON il.id = a.inventory_lot_id
        JOIN inventory_lot_sources ils ON ils.inventory_lot_id = il.id
        WHERE ils.receiving_invoice_item_id IN (
          SELECT rii2.id
          FROM receiving_invoices ri2
          JOIN receiving_invoice_items rii2 ON rii2.receiving_invoice_id = ri2.id
          WHERE ri2.receiving_order_id = ro.id
        )
        AND a.qty > 0
        AND po.status IN ('pending', 'picking')
      ) pending_po_ids
    ), 0) AS pending_picking_orders
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

const db = await useDb();

const rawRows = ref<ReceivingOrderRow[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    const result = await db.execute(query.value);
    rawRows.value = result.rows as ReceivingOrderRow[];
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
      r.ref_no.toLowerCase().includes(term) ||
      (r.supplier_name?.toLowerCase().includes(term) ?? false)
  );
});

watch(filter, load);

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
.filters {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  overflow-x: auto;
  padding-bottom: 0.25rem;
}

.filter-chip {
  flex-shrink: 0;
  padding: 0.45rem 1rem;
  font-size: 0.8125rem;
  font-weight: 600;
  border: 1px solid var(--border);
  border-radius: 9999px;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.filter-chip--active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
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
  margin-right: auto;
}
</style>
