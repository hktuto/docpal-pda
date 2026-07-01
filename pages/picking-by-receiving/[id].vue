<template>
  <div>
    <p v-if="pending" class="empty">Loading…</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">Error: {{ error }}</p>

    <template v-else>
      <div style="margin-bottom: 1rem;">
        <NuxtLink to="/picking-by-receiving" class="btn btn--small">← All receiving orders</NuxtLink>
      </div>

      <template v-if="receivingOrder">
        <div class="card" style="margin-bottom: 1.5rem;">
          <div class="detail-row">
            <span class="detail-label">Receiving order</span>
            <span class="card__title">{{ receivingOrder.ref_no }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Supplier</span>
            <span>{{ receivingOrder.supplier?.name || "—" }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Status</span>
            <span class="badge">{{ receivingOrder.status }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Delivery date</span>
            <span>{{ receivingOrder.deliveryDate ? new Date(receivingOrder.deliveryDate).toLocaleDateString() : "—" }}</span>
          </div>
        </div>

        <h2>Picking orders using this stock</h2>
        <p v-if="groupedOrders.length === 0" class="empty">No picking orders are linked to this receiving order yet.</p>

        <div v-for="po in groupedOrders" :key="po.id" class="card">
          <div class="detail-row">
            <span class="detail-label">Picking order</span>
            <span class="card__title">{{ po.ref_no }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Status</span>
            <span class="badge">{{ po.status }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Ship to</span>
            <span>{{ po.shipTo || "—" }}</span>
          </div>

          <div style="margin-top: 0.75rem;">
            <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">Items to pick</h3>
            <div v-for="item in po.items" :key="item.id" class="lot">
              <div class="detail-row">
                <span class="detail-label">Part</span>
                <span>{{ item.partNo }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Required / picked</span>
                <span>{{ item.requiredQty }} / {{ item.pickedQty }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Pick locations</span>
              </div>
              <ul style="margin: 0; padding-left: 1.25rem; font-size: 0.875rem; color: var(--muted);">
                <li v-for="loc in item.locations" :key="loc.allocationId">
                  {{ loc.shelfCode || loc.boxId || "Receiving area" }}
                  · {{ loc.dateCode || "—" }} / {{ loc.lotCode || "—" }} / {{ loc.originCountry || "—" }}
                  · qty {{ loc.allocatedQty }}
                </li>
              </ul>
            </div>
          </div>
        </div>
      </template>
      <p v-else class="empty">Receiving order not found.</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { getReceivingOrderDetail } from "~/db/receiving";
import {
  getPickingOrdersByReceivingOrder,
  type PickingByReceivingRow,
} from "~/db/picking";

definePageMeta({ title: "Picking by Receiving Detail" });

const route = useRoute();
const receivingOrderId = route.params.id as string;

const db = await useDb();

const pending = ref(true);
const error = ref<string | null>(null);
const receivingOrder = ref<Awaited<ReturnType<typeof getReceivingOrderDetail>> | null>(null);
const rows = ref<PickingByReceivingRow[]>([]);

let mounted = false;

interface GroupedItem {
  id: string;
  partId: string;
  partNo: string;
  requiredQty: number;
  pickedQty: number;
  locations: Array<{
    allocationId: string;
    shelfCode: string | null;
    boxId: string | null;
    dateCode: string | null;
    lotCode: string | null;
    originCountry: string | null;
    allocatedQty: number;
  }>;
}

interface GroupedOrder {
  id: string;
  ref_no: string;
  status: string;
  shipTo: string | null;
  items: GroupedItem[];
}

const groupedOrders = computed<GroupedOrder[]>(() => {
  const map = new Map<string, GroupedOrder>();
  for (const row of rows.value) {
    if (!map.has(row.picking_order_id)) {
      map.set(row.picking_order_id, {
        id: row.picking_order_id,
        ref_no: row.picking_order_ref,
        status: row.picking_order_status,
        shipTo: row.picking_order_ship_to,
        items: [],
      });
    }
    const order = map.get(row.picking_order_id)!;
    let item = order.items.find((i) => i.id === row.picking_item_id);
    if (!item) {
      item = {
        id: row.picking_item_id,
        partId: row.part_id,
        partNo: row.part_no,
        requiredQty: row.required_qty,
        pickedQty: row.picked_qty,
        locations: [],
      };
      order.items.push(item);
    }
    item.locations.push({
      allocationId: row.allocation_id,
      shelfCode: row.shelf_code,
      boxId: row.box_id,
      dateCode: row.date_code,
      lotCode: row.lot_code,
      originCountry: row.origin_country,
      allocatedQty: row.allocated_qty,
    });
  }
  return Array.from(map.values());
});

async function load() {
  try {
    const [orderData, linkedRows] = await Promise.all([
      getReceivingOrderDetail(db, receivingOrderId),
      getPickingOrdersByReceivingOrder(db, receivingOrderId),
    ]);
    if (!mounted) return;
    receivingOrder.value = orderData;
    rows.value = linkedRows;
  } catch (e: any) {
    if (!mounted) return;
    error.value = e?.message ?? String(e);
  } finally {
    if (mounted) {
      pending.value = false;
    }
  }
}

onMounted(() => {
  mounted = true;
  load();
});

onUnmounted(() => {
  mounted = false;
});
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
  margin-bottom: 0.5rem;
}
</style>
