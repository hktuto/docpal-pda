<template>
  <div>
    <p v-if="pending" class="empty">Loading…</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">Error: {{ error }}</p>

    <template v-else-if="order">
      <DetailHeader
        v-model="headerExpanded"
        :title="order.refNo"
        :status="order.status"
        :badge-class="badgeClass(order.status)"
        :flush-top="route.meta.props?.noPadding"
        style="margin-bottom: 1.5rem;"
      >
        <template #actions>
          <button
            v-if="order.status === 'pending'"
            class="btn btn--small"
            :disabled="confirming"
            @click="confirmArrival"
          >
            {{ confirming ? "Confirming…" : "Confirm arrived" }}
          </button>
          <NuxtLink
            v-if="order.status === 'in_hand' && remainingItems > 0"
            :to="`/put-away/${order.id}`"
            class="btn btn--small"
          >
            Put away remaining stock
          </NuxtLink>
        </template>

        <div class="detail-row">
          <span class="detail-label">Supplier</span>
          <span>{{ order.supplier?.name || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Delivery date</span>
          <span>{{ order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : "—" }}</span>
        </div>
        <div v-if="order.status === 'in_hand' && remainingItems > 0" class="detail-row">
          <span class="detail-label">Remaining items</span>
          <span>{{ remainingItems }} item{{ remainingItems === 1 ? '' : 's' }}</span>
        </div>
      </DetailHeader>

      <div v-if="order.status === 'in_hand' && remainingItems > 0 && view === 'picking'" style="position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 60;">
        <button
          class="btn"
          style="border-radius: 9999px; width: 3.5rem; height: 3.5rem; padding: 0; display: flex; align-items: center; justify-content: center; box-shadow: var(--shadow);"
          aria-label="Scan label"
          :disabled="scanning"
          @click="openScan()"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
            <circle cx="12" cy="13" r="4"/>
          </svg>
        </button>
      </div>

      <div class="view-tabs">
        <button
          v-for="opt in views"
          :key="opt.value"
          class="filter-chip"
          :class="{ 'filter-chip--active': view === opt.value }"
          @click="view = opt.value"
        >
          {{ opt.label }}
          <span v-if="opt.value === 'picking'" class="tab-badge">({{ groupedPickingOrders.length }})</span>
        </button>
      </div>

      <template v-if="view === 'receiving'">
        <h2 class="section-title">Invoices & Items</h2>
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
              <span class="detail-label">Reserved</span>
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
              <span class="detail-label">Date / Lot / COO / COW</span>
              <span>{{ item.dateCode }} / {{ item.lotCode }} / {{ item.coo }} / {{ item.cow }}</span>
            </div>

            <div v-if="order.status === 'pending'" style="margin-top: 0.75rem; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
              <input
                v-model.number="form[item.id].actualQty"
                type="number"
                placeholder="Actual qty"
                style="width: 6rem;"
              />
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
        <h2 class="section-title">Picking view</h2>
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search picking orders or parts…"
          style="width: 100%; margin-bottom: 1rem;"
        />
        <p v-if="filteredGroupedPickingOrders.length === 0" class="empty">
          No picking orders are linked to this receiving order yet.
        </p>

        <div v-for="po in filteredGroupedPickingOrders" :key="po.id" class="card" style="margin-bottom: 1.5rem;">
          <div class="detail-row">
            <span class="detail-label">Picking order</span>
            <NuxtLink :to="`/picking/${po.id}`" class="card__title">{{ po.ref_no }}</NuxtLink>
          </div>
          <div class="detail-row">
            <span class="detail-label">Status</span>
            <span class="badge">{{ po.status }}</span>
          </div>

          <div v-if="po.status !== 'finished'" style="margin-top: 0.75rem;">
            <button
              class="btn btn--small"
              :disabled="creatingBox[po.id]"
              @click="createBox(po.id)"
            >
              {{ creatingBox[po.id] ? "Creating…" : "Create box" }}
            </button>
          </div>

          <div v-if="(boxesByOrder[po.id] || []).length" style="margin-top: 0.75rem;">
            <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">Boxes</h3>
            <div
              v-for="box in boxesByOrder[po.id]"
              :key="box.id"
              class="lot"
              style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap;"
            >
              <span style="font-size: 0.875rem; font-weight: 600;">{{ box.id }}</span>
              <span class="badge">{{ box.status }}</span>
            </div>
          </div>

          <div v-for="pi in po.items" :key="pi.id" class="lot" style="margin-top: 0.75rem;">
            <div class="detail-row">
              <span class="detail-label">Part</span>
              <span>{{ pi.part_no }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Required / scanned / boxed</span>
              <span>{{ pi.required_qty }} / {{ pi.scanned_qty }} / {{ pi.boxed_qty }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Status</span>
              <span class="badge" :class="{ 'badge--finished': pi.boxed_qty >= pi.required_qty }">
                {{ pi.boxed_qty >= pi.required_qty ? "Finished" : "Picking" }}
              </span>
            </div>
            <div v-if="pi.locations.filter(l => l.allocated_qty > 0).length" class="detail-row">
              <span class="detail-label">Allocated lots</span>
            </div>
            <ul v-if="pi.locations.filter(l => l.allocated_qty > 0).length" style="margin: 0; padding-left: 1.25rem; font-size: 0.875rem; color: var(--muted);">
              <li v-for="(loc, idx) in pi.locations.filter(l => l.allocated_qty > 0)" :key="idx">
                {{ loc.shelf_code || loc.box_id || "Receiving area" }}
                · {{ loc.date_code || "—" }} / {{ loc.lot_code || "—" }} / {{ loc.coo || "—" }} / {{ loc.cow || "—" }}
                · qty {{ loc.allocated_qty }}
              </li>
            </ul>

            <div v-if="packagesByItem[pi.id]?.length" style="margin-top: 0.75rem;">
              <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">Packages</h3>
              <div
                v-for="pkg in packagesByItem[pi.id]"
                :key="pkg.id"
                class="lot"
                style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; justify-content: space-between;"
              >
                <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                  <span style="font-size: 0.875rem;">
                    {{ pkg.qty }} pcs · {{ pkg.dateCode || "—" }} / {{ pkg.lotCode || "—" }} / {{ pkg.coo || "—" }} / {{ pkg.cow || "—" }}
                  </span>
                  <span style="font-size: 0.75rem; color: var(--muted);">
                    <template v-if="pkg.shippingBoxId">
                      In box {{ pkg.shippingBoxId }}
                    </template>
                    <template v-else>Unboxed</template>
                  </span>
                </div>
                <div v-if="!pkg.shippingBoxId" style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
                  <select v-model="boxSelections[pkg.id]" :disabled="addingPackage[pkg.id]" style="min-width: 8rem;">
                    <option value="">Select box</option>
                    <option v-for="box in openBoxesForOrder(po.id)" :key="box.id" :value="box.id">{{ box.id }}</option>
                  </select>
                  <button
                    class="btn btn--small"
                    :disabled="addingPackage[pkg.id] || !boxSelections[pkg.id]"
                    @click="addToBox(pkg.id)"
                  >
                    {{ addingPackage[pkg.id] ? "Adding…" : "Add to box" }}
                  </button>
                </div>
                <button
                  v-else-if="boxById(pkg.shippingBoxId)?.status === 'open'"
                  class="btn btn--small"
                  :disabled="removingPackage[pkg.id]"
                  @click="removeFromBox(pkg.id)"
                >
                  {{ removingPackage[pkg.id] ? "Removing…" : "Remove from box" }}
                </button>
              </div>
            </div>

            <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem; flex-wrap: wrap;">
              <button
                class="btn btn--small"
                :disabled="scanning"
                @click="openScan(pi.id)"
              >
                Scan
              </button>
              <button class="btn btn--small" @click="toggleExpand(pi.id)">
                {{ expandedItems.has(pi.id) ? "Hide picking logs" : "Show picking logs" }}
                ({{ (transitionLogs[pi.id] || []).length }})
              </button>

              <div v-if="expandedItems.has(pi.id)" style="width: 100%; margin-top: 0.5rem;">
                <p v-if="!(transitionLogs[pi.id] || []).length" class="card__meta">No picking logs.</p>
                <ul v-else style="margin: 0; padding-left: 1.25rem; font-size: 0.875rem; color: var(--muted);">
                  <li v-for="log in transitionLogs[pi.id]" :key="log.id" style="margin-bottom: 0.35rem;">
                    {{ new Date(log.createdAt).toLocaleString() }}
                    · {{ log.actorName || "System" }}
                    · {{ log.fromState || "—" }} → {{ log.toState }}
                    <span v-if="log.metadata">
                      · {{ JSON.parse(log.metadata).qty ?? JSON.parse(log.metadata).note }}
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </template>

      <LabelScanReviewModal
        v-if="review?.status === 'review'"
        v-model="reviewOpen"
        :image-path="review.capture.imagePath"
        :text="review.capture.text"
        :parsed="review.parsed"
        :match-result="review.matchResult"
        :context="{ task: 'receiving', receivingOrderId: orderId, pickingItemId: scanPickingItemId }"
        @applied="onApplied"
        @retake="onRetake"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { noopDecoder, sql } from "drizzle-orm";
import { useLabelScan, type LabelScanResult } from "~/composables/useLabelScan";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import {
  getReceivingOrderDetail,
  updateReceivingItemMismatch,
  confirmReceivingOrderArrived,
} from "~/db/receiving";
import {
  getPickingOrdersByReceivingOrder,
  getPickingItemTransitionLogs,
  createShippingBoxForPickingOrder,
  addPackageToBox,
  removePackageFromBox,
  type PickingByReceivingRow,
} from "~/db/picking";
import * as schema from "~/db/schema";

definePageMeta({ title: "Receiving Detail", props: { noPadding: true } });

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
const { scan, scanning } = useLabelScan();
const reviewOpen = ref(false);
const review = ref<LabelScanResult | null>(null);
const scanPickingItemId = ref<string | undefined>(undefined);
const view = ref<"receiving" | "picking">("receiving");
const headerExpanded = ref(false);
const transitionLogs = ref<Record<string, any[]>>({});
const expandedItems = ref<Set<string>>(new Set());
const searchQuery = ref("");
const packagesByItem = ref<Record<string, (typeof schema.pickingPackages.$inferSelect)[]>>({});
const boxesByOrder = ref<Record<string, (typeof schema.shippingBoxes.$inferSelect)[]>>({});
const creatingBox = ref<Record<string, boolean>>({});
const addingPackage = ref<Record<string, boolean>>({});
const removingPackage = ref<Record<string, boolean>>({});
const boxSelections = ref<Record<string, string>>({});

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
  scanned_qty: number;
  boxed_qty: number;
  locations: Array<{
    shelf_code: string | null;
    box_id: string | null;
    date_code: string | null;
    lot_code: string | null;
    coo: string | null;
    cow: string | null;
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
        scanned_qty: row.scanned_qty,
        boxed_qty: row.boxed_qty,
        locations: [],
      };
      po.items.push(item);
    }
    item.locations.push({
      shelf_code: row.shelf_code,
      box_id: row.box_id,
      date_code: row.date_code,
      lot_code: row.lot_code,
      coo: row.coo,
      cow: row.cow,
      allocated_qty: row.allocated_qty,
    });
  }
  return Array.from(map.values());
});

const filteredGroupedPickingOrders = computed<GroupedOrder[]>(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return groupedPickingOrders.value;
  return groupedPickingOrders.value.filter((po) => {
    const orderMatch = po.ref_no.toLowerCase().includes(query);
    const itemMatch = po.items.some(
      (pi) =>
        pi.part_no.toLowerCase().includes(query) ||
        pi.locations.some(
          (loc) =>
            (loc.date_code ?? "").toLowerCase().includes(query) ||
            (loc.lot_code ?? "").toLowerCase().includes(query)
        )
    );
    return orderMatch || itemMatch;
  });
});

const remainingItems = ref(0);
const allocatedByItem = ref<Record<string, number>>({});

async function load() {
  try {
    const orderData = await getReceivingOrderDetail(db, orderId);
    const linkedRows = await getPickingOrdersByReceivingOrder(db, orderId);
    const remainingResult = await db.execute(
      sql`SELECT COUNT(DISTINCT CASE
                WHEN ro.status = 'in_hand'
                  AND (rii.received_qty - rii.picked_qty - rii.put_away_qty -
                       COALESCE(alloc.allocated_qty, 0)) > 0
                THEN rii.id
              END) AS qty
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
    );
    const allocatedResult = await db.execute(
      sql`SELECT rii.id AS receiving_invoice_item_id, COALESCE(SUM(a.qty), 0) AS allocated_qty
          FROM receiving_invoice_items rii
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
          LEFT JOIN allocations a ON a.receiving_invoice_item_id = rii.id
          WHERE ro.id = ${orderId}
          GROUP BY rii.id`
    );
    order.value = orderData;
    pickingRows.value = linkedRows;
    remainingItems.value = Number((remainingResult.rows[0] as any)?.qty ?? 0);

    const itemIds = Array.from(new Set(linkedRows.map((r) => r.picking_item_id)));
    const orderIds = Array.from(new Set(linkedRows.map((r) => r.picking_order_id)));

    const logs = itemIds.length ? await getPickingItemTransitionLogs(db, itemIds) : [];
    const nextLogs: Record<string, any[]> = {};
    for (const log of logs) {
      const list = nextLogs[log.entityId] ?? [];
      list.push(log);
      nextLogs[log.entityId] = list;
    }
    transitionLogs.value = nextLogs;

    const packageResult = itemIds.length
      ? await db.execute(sql`
          SELECT * FROM picking_packages
          WHERE picking_item_id IN (${sql.raw(itemIds.map((id) => `'${id}'`).join(", "))})
          ORDER BY created_at
        `)
      : { rows: [] };
    const nextPackages: Record<string, any[]> = {};
    const nextBoxSelections: Record<string, string> = {};
    for (const raw of (packageResult.rows ?? []) as any[]) {
      const pkg = {
        id: raw.id,
        pickingItemId: raw.picking_item_id,
        pickingOrderId: raw.picking_order_id,
        sourceType: raw.source_type,
        sourceId: raw.source_id,
        qty: raw.qty,
        shippingBoxId: raw.shipping_box_id,
        dateCode: raw.date_code,
        lotCode: raw.lot_code,
        coo: raw.coo,
        cow: raw.cow,
        createdAt: raw.created_at,
      };
      const list = nextPackages[pkg.pickingItemId] ?? [];
      list.push(pkg);
      nextPackages[pkg.pickingItemId] = list;
      if (!pkg.shippingBoxId) {
        nextBoxSelections[pkg.id] = boxSelections.value[pkg.id] ?? "";
      }
    }
    packagesByItem.value = nextPackages;

    const boxResult = orderIds.length
      ? await db.execute(sql`
          SELECT * FROM shipping_boxes
          WHERE picking_order_id IN (${sql.raw(orderIds.map((id) => `'${id}'`).join(", "))})
          ORDER BY id
        `)
      : { rows: [] };
    const nextBoxes: Record<string, any[]> = {};
    for (const box of (boxResult.rows ?? []) as any[]) {
      const list = nextBoxes[box.picking_order_id] ?? [];
      list.push(box);
      nextBoxes[box.picking_order_id] = list;
    }
    boxesByOrder.value = nextBoxes;
    boxSelections.value = nextBoxSelections;

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

function toggleExpand(itemId: string) {
  const next = new Set(expandedItems.value);
  if (next.has(itemId)) {
    next.delete(itemId);
  } else {
    next.add(itemId);
  }
  expandedItems.value = next;
}

async function openScan(itemId?: string) {
  scanPickingItemId.value = itemId;
  const result = await scan({
    task: 'receiving',
    receivingOrderId: orderId,
    pickingItemId: itemId,
  });
  if (result.status === 'applied') {
    await load();
  } else if (result.status === 'review') {
    review.value = result;
    reviewOpen.value = true;
  } else if (result.status === 'error') {
    error.value = result.message;
  }
}

async function onApplied() {
  reviewOpen.value = false;
  await load();
}

async function onRetake() {
  reviewOpen.value = false;
  await openScan(scanPickingItemId.value);
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

async function createBox(pickingOrderId: string) {
  creatingBox.value[pickingOrderId] = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await createShippingBoxForPickingOrder(db, pickingOrderId, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    creatingBox.value[pickingOrderId] = false;
  }
}

async function addToBox(packageId: string) {
  const boxId = boxSelections.value[packageId];
  if (!boxId) return;
  addingPackage.value[packageId] = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await addPackageToBox(db, packageId, boxId, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    addingPackage.value[packageId] = false;
  }
}

async function removeFromBox(packageId: string) {
  removingPackage.value[packageId] = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await removePackageFromBox(db, packageId, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    removingPackage.value[packageId] = false;
  }
}

function openBoxesForOrder(pickingOrderId: string) {
  return (boxesByOrder.value[pickingOrderId] ?? []).filter((b) => b.status === "open");
}

function boxById(boxId: string | null | undefined) {
  if (!boxId) return undefined;
  for (const boxes of Object.values(boxesByOrder.value)) {
    const box = boxes.find((b) => b.id === boxId);
    if (box) return box;
  }
  return undefined;
}

function badgeClass(status: string) {
  if (status === "pending") return "badge--pending";
  if (status === "in_hand") return "badge--in-hand";
  if (status === "clear") return "badge--finished";
  return "";
}

onMounted(load);
</script>

<style scoped>
.view-tabs {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  overflow-x: auto;
  padding-bottom: 0.25rem;
}

.tab-badge {
  font-size: 0.75rem;
  opacity: 0.8;
  margin-left: 0.25rem;
}

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
