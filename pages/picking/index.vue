<template>
  <div>
    <input
      v-model="search"
      class="search"
      type="text"
      placeholder="Search by ref or supplier…"
    />

    <p v-if="loading" class="empty">Loading…</p>
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">Error: {{ loadError }}</p>
    <p v-else-if="reportMessage" class="empty" style="color: #92400e;">{{ reportMessage }}</p>
    <p v-else-if="rows.length === 0" class="empty">No picking orders found.</p>

    <div
      v-for="po in rows"
      :key="po.id"
      class="card list-card"
      :class="{ 'card--disabled': !isSelectable(po.status) }"
    >
      <div class="list-card__header">
        <div style="display: flex; align-items: flex-start; gap: 0.75rem; flex: 1;">
          <input
            v-if="isSelectable(po.status)"
            type="checkbox"
            :checked="selectedIds.has(po.id)"
            @change="toggleSelection(po.id)"
          />
          <NuxtLink :to="`/picking/${po.id}`" class="list-card__title">
            {{ po.ref_no }}
          </NuxtLink>
        </div>
        <span class="badge" :class="badgeClass(po.status)">{{ po.status }}</span>
      </div>
      <p class="list-card__meta">
        {{ po.supplier_name || "No supplier" }}
      </p>
      <div class="list-card__footer">
        <span class="list-card__date">
          {{ po.delivery_date ? new Date(po.delivery_date).toLocaleDateString() : "No date" }}
        </span>
        <span class="list-card__ship">Ship to: {{ po.ship_to || "—" }}</span>
      </div>
    </div>

    <div v-if="hasSelection" class="bulk-actions">
      <span>{{ selectedOrders.length }} selected</span>
      <button class="btn btn--small btn--danger" @click="openModal">
        Report issue
      </button>
    </div>

    <PickingIssueReportModal
      v-model="modalOpen"
      :orders="selectedOrders"
      :saving="reporting"
      @saved="onReportSaved"
    />
  </div>
</template>

<script setup lang="ts">
import { badgeClass } from "~/composables/useStatusBadge";
import { useVisibleReload } from "~/composables/useVisibleReload";

definePageMeta({ title: "Picking" });

interface PickingOrderRow extends Record<string, unknown> {
  id: string;
  ref_no: string;
  status: string;
  delivery_date: string | null;
  supplier_name: string | null;
  ship_to: string | null;
  total_qty: number;
}

const db = await useDb();
const { currentUser } = useAuth();

const search = ref("");
const rawRows = ref<PickingOrderRow[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const reportMessage = ref<string | null>(null);
const selectedIds = ref<Set<string>>(new Set());
const modalOpen = ref(false);
const reporting = ref(false);

async function load() {
  loading.value = true;
  loadError.value = null;
  reportMessage.value = null;
  try {
    const result = await db.execute<PickingOrderRow>(
      `SELECT po.id, po.ref_no, po.status, po.delivery_date, po.ship_to, s.name AS supplier_name,
        (SELECT COALESCE(SUM(pi.qty), 0) FROM picking_items pi WHERE pi.picking_order_id = po.id) AS total_qty
       FROM picking_orders po
       LEFT JOIN suppliers s ON po.supplier_id = s.id
       ORDER BY CASE WHEN po.status = 'finished' THEN 1 ELSE 0 END, po.delivery_date;`
    );
    rawRows.value = result.rows ?? [];
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

const selectedOrders = computed(() =>
  rawRows.value
    .filter((r) => selectedIds.value.has(r.id))
    .map((r) => ({ id: r.id, ref_no: r.ref_no, totalQty: r.total_qty }))
);

const hasSelection = computed(() => selectedOrders.value.length > 0);

function isSelectable(status: string) {
  return status !== "finished" && status !== "issue";
}

function toggleSelection(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selectedIds.value = next;
}

function openModal() {
  if (!hasSelection.value) return;
  modalOpen.value = true;
}

async function onReportSaved(payload: {
  reason: "insufficient_stock" | "cannot_divide" | "merge" | "other";
  qty: number | null;
  packSize: number | null;
  note: string | null;
  remarks: Record<string, string>;
}) {
  reporting.value = true;
  try {
    if (!currentUser.value) throw new Error("No operator user found");
    const { reportPickingOrderIssues } = await import("~/db/picking");
    const entries = selectedOrders.value.map((o) => ({
      orderId: o.id,
      remark: payload.remarks[o.id]?.trim() || null,
    }));
    const result = await reportPickingOrderIssues(
      db,
      entries,
      {
        reason: payload.reason,
        qty: payload.qty,
        packSize: payload.packSize,
        note: payload.note,
      },
      currentUser.value.id
    );
    selectedIds.value = new Set();
    modalOpen.value = false;
    await load();
    if (result.reported > 0) {
      reportMessage.value =
        result.skipped > 0
          ? `${result.reported} issue(s) reported; ${result.skipped} order(s) skipped.`
          : `${result.reported} issue(s) reported.`;
    }
  } catch (e: any) {
    loadError.value = e?.message ?? String(e);
  } finally {
    reporting.value = false;
  }
}

useVisibleReload(load);
</script>

<style scoped>
.list-card__title:hover {
  text-decoration: underline;
}

.list-card__ship {
  margin-left: auto;
  font-size: 0.8125rem;
  color: var(--muted);
}

.bulk-actions {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--surface);
  border-top: 1px solid var(--border);
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.06);
}

.card--disabled {
  opacity: 0.65;
}

.list-card:last-child {
  margin-bottom: 5rem;
}
</style>
