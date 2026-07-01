<template>
  <div>
    <p v-if="pending" class="empty">Loading…</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">Error: {{ error }}</p>

    <template v-else-if="order">
      <div class="card" style="margin-bottom: 1.5rem;">
        <div class="detail-row">
          <span class="detail-label">RO No.</span>
          <span class="card__title">{{ order.refNo }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Status</span>
          <span class="badge">{{ order.status }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Supplier</span>
          <span>{{ order.supplier?.name || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Delivery date</span>
          <span>{{ order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : "—" }}</span>
        </div>
        <div v-if="order.status === 'in_hand' && remainingQty > 0" class="detail-row">
          <span class="detail-label">Remaining in receiving area</span>
          <span>{{ remainingQty }} pcs</span>
        </div>

        <div v-if="order.status === 'pending'" style="margin-top: 1rem;">
          <button class="btn" @click="confirmArrival" :disabled="confirming">
            {{ confirming ? "Confirming…" : "Confirm arrived" }}
          </button>
        </div>

        <div v-if="order.status === 'in_hand' && remainingQty > 0" style="margin-top: 0.75rem;">
          <NuxtLink :to="`/put-away/${order.id}`" class="btn btn--small">
            Shelve remaining stock
          </NuxtLink>
        </div>
      </div>

      <div style="display: flex; gap: 0.5rem; margin-bottom: 1rem;">
        <button
          v-for="opt in views"
          :key="opt.value"
          class="btn btn--small"
          :style="view === opt.value ? 'background: var(--primary-hover);' : 'background: var(--bg); color: var(--text); border-color: var(--border);'"
          @click="view = opt.value"
        >
          {{ opt.label }}
          <span v-if="opt.value === 'picking'" class="tab-badge">({{ groupedPickingOrders.length }})</span>
        </button>
      </div>

      <template v-if="view === 'receiving'">
        <h2>Invoices & Items</h2>
        <div v-for="invoice in order.invoices" :key="invoice.id" style="margin-bottom: 1.5rem;">
          <h3 style="margin-bottom: 0.5rem; color: var(--muted);">
            Invoice {{ invoice.invoiceNo }}
          </h3>

          <div
            v-for="item in invoice.items"
            :key="item.id"
            class="card"
            :class="{ 'card--mismatch': item.reportedMismatch }"
          >
            <div class="detail-row">
              <span class="detail-label">Part</span>
              <span class="card__title">{{ item.part?.partNo }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">PO / Line</span>
              <span>{{ item.poNo }} / {{ item.poLine }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Expected</span>
              <span>{{ item.qty }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Received</span>
              <input
                v-if="order.status === 'pending'"
                v-model.number="form[item.id].actualQty"
                type="number"
                style="width: 6rem;"
              />
              <span v-else>{{ item.receivedQty }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Allocated</span>
              <span>{{ allocatedByItem[item.id] || 0 }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Picked</span>
              <span>{{ item.pickedQty }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Put away</span>
              <span>{{ item.putAwayQty }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Available</span>
              <span>{{ item.receivedQty - item.pickedQty - item.putAwayQty - (allocatedByItem[item.id] || 0) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Date / Lot / Origin</span>
              <span>{{ item.dateCode }} / {{ item.lotCode }} / {{ item.originCountry }}</span>
            </div>

            <div v-if="order.status === 'pending'" style="margin-top: 0.75rem; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
              <input
                v-model="form[item.id].note"
                type="text"
                placeholder="Mismatch note"
                style="flex: 1; min-width: 8rem;"
              />
              <button class="btn btn--small" @click="saveMismatch(item.id)" :disabled="saving[item.id]">
                Save mismatch
              </button>
            </div>

            <div v-else-if="item.reportedMismatch" class="mismatch-badge">
              Mismatch reported
            </div>
          </div>
        </div>
      </template>

      <template v-else>
        <h2>Picking view</h2>
        <p v-if="groupedPickingOrders.length === 0" class="empty">
          No picking orders are linked to this receiving order yet.
        </p>

        <div v-for="po in groupedPickingOrders" :key="po.id" class="card" style="margin-bottom: 1.5rem;">
          <div class="detail-row">
            <span class="detail-label">Picking order</span>
            <span class="card__title">{{ po.ref_no }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Status</span>
            <span class="badge">{{ po.status }}</span>
          </div>

          <div v-for="pi in po.items" :key="pi.id" class="lot" style="margin-top: 0.75rem;">
            <div class="detail-row">
              <span class="detail-label">Part</span>
              <span>{{ pi.part_no }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Required / picked</span>
              <span>{{ pi.required_qty }} / {{ pi.picked_qty }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Allocated lots</span>
            </div>
            <ul style="margin: 0; padding-left: 1.25rem; font-size: 0.875rem; color: var(--muted);">
              <li v-for="(loc, idx) in pi.locations" :key="idx">
                {{ loc.shelf_code || loc.box_id || "Receiving area" }}
                · {{ loc.date_code || "—" }} / {{ loc.lot_code || "—" }} / {{ loc.origin_country || "—" }}
                · qty {{ loc.allocated_qty }}
              </li>
            </ul>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { sql } from "drizzle-orm";
import {
  getReceivingOrderDetail,
  updateReceivingItemMismatch,
  confirmReceivingOrderArrived,
} from "~/db/receiving";
import {
  getPickingOrdersByReceivingOrder,
  type PickingByReceivingRow,
} from "~/db/picking";

definePageMeta({ title: "Receiving Detail" });

const route = useRoute();
const orderId = route.params.id as string;

const db = await useDb();
const currentUser = await useCurrentUser();

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<any>(null);
const pickingRows = ref<PickingByReceivingRow[]>([]);
const form = ref<Record<string, { actualQty: number; note: string }>>({});
const saving = ref<Record<string, boolean>>({});
const confirming = ref(false);
const view = ref<"receiving" | "picking">("receiving");

const views = [
  { label: "Receiving", value: "receiving" as const },
  { label: "Picking", value: "picking" as const },
];

interface GroupedItem {
  id: string;
  part_id: string;
  part_no: string;
  required_qty: number;
  picked_qty: number;
  locations: Array<{
    shelf_code: string | null;
    box_id: string | null;
    date_code: string | null;
    lot_code: string | null;
    origin_country: string | null;
    allocated_qty: number;
  }>;
}

interface GroupedOrder {
  id: string;
  ref_no: string;
  status: string;
  items: GroupedItem[];
}

const groupedPickingOrders = computed<GroupedOrder[]>(() => {
  const map = new Map<string, GroupedOrder>();
  for (const row of pickingRows.value) {
    if (!map.has(row.picking_order_id)) {
      map.set(row.picking_order_id, {
        id: row.picking_order_id,
        ref_no: row.picking_order_ref,
        status: row.picking_order_status,
        items: [],
      });
    }
    const po = map.get(row.picking_order_id)!;
    let item = po.items.find((i) => i.id === row.picking_item_id);
    if (!item) {
      item = {
        id: row.picking_item_id,
        part_id: row.part_id,
        part_no: row.part_no,
        required_qty: row.required_qty,
        picked_qty: row.picked_qty,
        locations: [],
      };
      po.items.push(item);
    }
    item.locations.push({
      shelf_code: row.shelf_code,
      box_id: row.box_id,
      date_code: row.date_code,
      lot_code: row.lot_code,
      origin_country: row.origin_country,
      allocated_qty: row.allocated_qty,
    });
  }
  return Array.from(map.values());
});

const remainingQty = ref(0);
const allocatedByItem = ref<Record<string, number>>({});

async function load() {
  try {
    const [orderData, linkedRows, remainingResult, allocatedResult] = await Promise.all([
      getReceivingOrderDetail(db, orderId),
      getPickingOrdersByReceivingOrder(db, orderId),
      db.execute(
        sql`SELECT COALESCE(SUM(
                CASE
                  WHEN ro.status = 'in_hand'
                  THEN rii.received_qty - rii.picked_qty - rii.put_away_qty -
                       COALESCE(alloc.allocated_qty, 0)
                  ELSE 0
                END
              ), 0) AS qty
            FROM receiving_orders ro
            JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
            JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
            LEFT JOIN (
              SELECT receiving_invoice_item_id, SUM(qty) AS allocated_qty
              FROM allocations
              WHERE receiving_invoice_item_id IS NOT NULL
              GROUP BY receiving_invoice_item_id
            ) alloc ON alloc.receiving_invoice_item_id = rii.id
            WHERE ro.id = ${orderId}`
      ),
      db.execute(
        sql`SELECT rii.id AS receiving_invoice_item_id, COALESCE(SUM(a.qty), 0) AS allocated_qty
            FROM receiving_invoice_items rii
            JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
            JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
            LEFT JOIN allocations a ON a.receiving_invoice_item_id = rii.id
            WHERE ro.id = ${orderId}
            GROUP BY rii.id`
      ),
    ]);
    order.value = orderData;
    pickingRows.value = linkedRows;
    remainingQty.value = Number((remainingResult.rows[0] as any)?.qty ?? 0);
    const nextAllocated: Record<string, number> = {};
    for (const row of (allocatedResult.rows ?? []) as any[]) {
      nextAllocated[row.receiving_invoice_item_id] = Number(row.allocated_qty);
    }
    allocatedByItem.value = nextAllocated;
    if (orderData) {
      const nextForm: Record<string, { actualQty: number; note: string }> = {};
      for (const invoice of orderData.invoices) {
        for (const item of invoice.items) {
          nextForm[item.id] = {
            actualQty: form.value[item.id]?.actualQty ?? (item.reportedMismatch ? item.receivedQty : item.qty),
            note: form.value[item.id]?.note ?? (item.mismatchNote || ""),
          };
        }
      }
      form.value = nextForm;
    }
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    pending.value = false;
  }
}

async function saveMismatch(itemId: string) {
  saving.value[itemId] = true;
  try {
    const { actualQty, note } = form.value[itemId];
    await updateReceivingItemMismatch(db, itemId, actualQty, note);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    saving.value[itemId] = false;
  }
}

async function confirmArrival() {
  confirming.value = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await confirmReceivingOrderArrived(db, orderId, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    confirming.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--border);
}

.detail-row:last-child {
  border-bottom: none;
}

.detail-label {
  font-size: 0.8125rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.lot {
  background: var(--bg);
  border-radius: var(--radius);
  padding: 0.75rem;
}

.card--mismatch {
  border-left: 4px solid var(--danger);
}

.mismatch-badge {
  display: inline-block;
  margin-top: 0.75rem;
  padding: 0.25rem 0.625rem;
  font-size: 0.75rem;
  font-weight: 600;
  border-radius: 9999px;
  background: #fee2e2;
  color: #991b1b;
}
</style>
