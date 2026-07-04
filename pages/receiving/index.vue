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
        {{ $t(opt.labelKey) }}
      </button>
    </div>

    <input
      v-model="search"
      class="search"
      type="text"
      :placeholder="$t('common.searchByRefOrSupplier')"
    />

    <p v-if="loading" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: loadError }) }}</p>
    <p v-else-if="rows.length === 0" class="empty">{{ $t('common.noReceivingOrders') }}</p>

    <NuxtLink
      v-for="ro in rows"
      :key="ro.id"
      :to="`/receiving/${ro.id}`"
      class="card list-card"
    >
      <div class="list-card__header">
        <span class="list-card__title">{{ ro.ref_no }}</span>
        <span class="badge" :class="badgeClass(ro.status)">{{ statusLabel.receiving(ro.status) }}</span>
      </div>
      <p class="list-card__meta">
        {{ ro.supplier_name || $t('common.noSupplier') }}
      </p>
      <div class="list-card__footer">
        <span class="list-card__date">
          {{ ro.delivery_date ? new Date(ro.delivery_date).toLocaleDateString() : $t('common.noDate') }}
        </span>
        <span v-if="ro.remaining_items > 0" class="badge badge--info">
          {{ $t('receiving.remaining', { count: ro.remaining_items }) }}
        </span>
        <span
          v-if="ro.pending_picking_orders > 0"
          class="badge badge--info"
        >
          {{ ro.pending_picking_orders }} {{ $t('status.picking.picking') }}
        </span>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { badgeClass } from "~/composables/useStatusBadge";
import { useVisibleReload } from "~/composables/useVisibleReload";

const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();

useHead({ title: t("receiving.title") });

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

const filters: { labelKey: string; value: Filter }[] = [
  { labelKey: "common.all", value: "all" },
  { labelKey: "status.receiving.pending", value: "pending" },
  { labelKey: "status.receiving.in_hand", value: "in_hand" },
  { labelKey: "status.receiving.clear", value: "clear" },
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
    loadError.value = errorMessage(e);
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
useVisibleReload(load);
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

</style>
