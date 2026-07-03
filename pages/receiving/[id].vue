<template>
  <div>
    <EmptyState v-if="pending">Loading…</EmptyState>
    <EmptyState v-else-if="error" error>Error: {{ error }}</EmptyState>

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

        <DetailRow label="Supplier" :value="order.supplier?.name" />
        <DetailRow label="Delivery date" :value="order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : null" />
        <DetailRow v-if="order.status === 'in_hand' && remainingItems > 0" label="Remaining items" :value="`${remainingItems} item${remainingItems === 1 ? '' : 's'}`" />
      </DetailHeader>

      <ScanFab
        v-if="order.status === 'in_hand' && remainingItems > 0 && view === 'picking'"
        :loading="scanning"
        @click="openScan()"
      />

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

      <ReceivingItemsTab
        v-if="view === 'receiving'"
        :order="order"
        :allocated-by-item="allocatedByItem"
        :saving="saving"
        @report-issue="openReportIssue"
      />

      <ReceivingPickingTab
        v-else
        :filtered-grouped-picking-orders="filteredGroupedPickingOrders"
        :boxes-by-order="boxesByOrder"
        :packages-by-item="packagesByItem"
        :transition-logs="transitionLogs"
        v-model:search-query="searchQuery"
        v-model:expanded-items="expandedItems"
        v-model:box-selections="boxSelections"
        :creating-box="creatingBox"
        :adding-package="addingPackage"
        :removing-package="removingPackage"
        :scanning="scanning"
        @create-box="createBox"
        @add-to-box="addToBox"
        @remove-from-box="removeFromBox"
        @scan="openScan"
      />

      <LabelScanReviewModal
        v-if="review?.status === 'review'"
        v-model="reviewOpen"
        :image-path="review.capture.imagePath"
        :text="review.capture.text"
        :barcodes="review.capture.barcodes"
        :parsed="review.parsed"
        :match-result="review.matchResult"
        :mode="review.capture.imagePath ? 'review' : 'manual'"
        :context="{ task: 'receiving', receivingOrderId: orderId, pickingItemId: scanPickingItemId }"
        @applied="onApplied"
        @retake="onRetake"
      />

      <ReportIssueModal
        :model-value="reportModalOpen"
        :item="reportModalItem"
        :saving="reportModalItem ? saving[reportModalItem.id] ?? false : false"
        @update:model-value="onReportModalModelValueUpdate"
        @confirm="onConfirmIssue"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { sql } from "drizzle-orm";
import ReceivingItemsTab from "~/components/receiving/ReceivingItemsTab.vue";
import ReceivingPickingTab from "~/components/receiving/ReceivingPickingTab.vue";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { badgeClass } from "~/composables/useStatusBadge";
import { useLabelScanReview } from "~/composables/useLabelScanReview";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import ReportIssueModal from "~/components/ReportIssueModal.vue";
import {
  DisplayReceivingItem,
  DisplayReceivingOrder,
  GroupedItem,
  GroupedOrder,
  TransitionLog,
  DisplayPackage,
  DisplayBox,
} from "~/components/receiving/types";
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

definePageMeta({ title: "Receiving Detail", props: { noPadding: true } });

const route = useRoute();
const orderId = route.params.id as string;

const db = await useDb();
const { currentUser } = useAuth();

const pending = ref(true);
const error = ref<string | null>(null);

const order = ref<DisplayReceivingOrder | null>(null);
const pickingRows = ref<PickingByReceivingRow[]>([]);
const saving = ref<Record<string, boolean>>({});
const confirming = ref(false);
const { scan, scanning, review, reviewOpen, onApplied } = useLabelScanReview({
  onApplied: load,
});

async function onRetake() {
  reviewOpen.value = false;
  await openScan(scanPickingItemId.value);
}

const scanPickingItemId = ref<string | undefined>(undefined);
const view = ref<"receiving" | "picking">("receiving");
const headerExpanded = ref(false);
const transitionLogs = ref<Record<string, TransitionLog[]>>({});
const expandedItems = ref<Set<string>>(new Set());
const searchQuery = ref("");
const packagesByItem = ref<Record<string, DisplayPackage[]>>({});
const boxesByOrder = ref<Record<string, DisplayBox[]>>({});
const creatingBox = ref<Record<string, boolean>>({});
const addingPackage = ref<Record<string, boolean>>({});
const removingPackage = ref<Record<string, boolean>>({});
const boxSelections = ref<Record<string, string>>({});
const reportModalOpen = ref(false);
const reportModalItem = ref<DisplayReceivingItem | null>(null);

const views = [
  { label: "Receiving", value: "receiving" as const },
  { label: "Picking", value: "picking" as const },
];

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
    // Phase 1: independent primary queries can be started together.
    const [orderData, linkedRows, remainingResult, allocatedResult] = await Promise.all([
      getReceivingOrderDetail(db, orderId),
      getPickingOrdersByReceivingOrder(db, orderId),
      db.execute(
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

    pickingRows.value = linkedRows;
    remainingItems.value = Number((remainingResult.rows[0] as any)?.qty ?? 0);

    const itemIds = Array.from(new Set(linkedRows.map((r) => r.picking_item_id)));
    const orderIds = Array.from(new Set(linkedRows.map((r) => r.picking_order_id)));

    // Phase 2: child lookups depend only on the IDs above.
    const idList = itemIds.map((id) => `'${id}'`).join(", ");
    const orderIdList = orderIds.map((id) => `'${id}'`).join(", ");

    const [logs, packageResult, boxResult] = await Promise.all([
      itemIds.length ? getPickingItemTransitionLogs(db, itemIds) : Promise.resolve([]),
      itemIds.length
        ? db.execute(sql`
            SELECT id,
                   picking_item_id,
                   picking_order_id,
                   qty,
                   shipping_box_id,
                   date_code,
                   lot_code,
                   coo,
                   cow,
                   created_at
            FROM picking_packages
            WHERE picking_item_id IN (${sql.raw(idList)})
            ORDER BY created_at
          `)
        : Promise.resolve({ rows: [] }),
      orderIds.length
        ? db.execute(sql`
            SELECT id, picking_order_id, status
            FROM shipping_boxes
            WHERE picking_order_id IN (${sql.raw(orderIdList)})
            ORDER BY id
          `)
        : Promise.resolve({ rows: [] }),
    ]);

    const nextLogs: Record<string, TransitionLog[]> = {};
    for (const log of logs) {
      const list = nextLogs[log.entityId] ?? [];
      list.push(log);
      nextLogs[log.entityId] = list;
    }
    transitionLogs.value = nextLogs;

    const nextPackages: Record<string, DisplayPackage[]> = {};
    const nextBoxSelections: Record<string, string> = {};
    for (const raw of (packageResult.rows ?? []) as any[]) {
      const pkg: DisplayPackage = {
        id: raw.id,
        pickingItemId: raw.picking_item_id,
        pickingOrderId: raw.picking_order_id,
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

    const nextBoxes: Record<string, DisplayBox[]> = {};
    for (const box of (boxResult.rows ?? []) as any[]) {
      const displayBox: DisplayBox = {
        id: box.id,
        pickingOrderId: box.picking_order_id,
        status: box.status,
      };
      const list = nextBoxes[displayBox.pickingOrderId] ?? [];
      list.push(displayBox);
      nextBoxes[displayBox.pickingOrderId] = list;
    }
    boxesByOrder.value = nextBoxes;
    boxSelections.value = nextBoxSelections;

    const nextAllocated: Record<string, number> = {};
    for (const row of (allocatedResult.rows ?? []) as any[]) {
      nextAllocated[row.receiving_invoice_item_id] = Number(row.allocated_qty);
    }
    allocatedByItem.value = nextAllocated;

    if (orderData) {
      order.value = {
        ...orderData,
        invoices: orderData.invoices.map((invoice) => {
          const { receivingOrderId: _ignored, ...invoiceRest } = invoice;
          return {
            ...invoiceRest,
            items: invoice.items as DisplayReceivingItem[],
          };
        }),
      };
    }
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    pending.value = false;
  }
}

async function openScan(itemId?: string) {
  scanPickingItemId.value = itemId;
  const result = await scan({
    task: "receiving",
    receivingOrderId: orderId,
    pickingItemId: itemId,
  });
  if (result.status === "error") {
    error.value = result.message;
  }
  // applied/review/manual are handled by useLabelScanReview.
}

function openReportIssue(item: DisplayReceivingItem) {
  reportModalItem.value = item;
  reportModalOpen.value = true;
}

function closeReportIssue() {
  reportModalOpen.value = false;
  reportModalItem.value = null;
}

function onReportModalModelValueUpdate(v: boolean) {
  reportModalOpen.value = v;
  if (!v) reportModalItem.value = null;
}

async function onConfirmIssue(payload: {
  reason: schema.MismatchReason | null;
  mismatchQty: number | null;
  wrongPartNo: string | null;
  note: string;
}) {
  if (!currentUser.value || !reportModalItem.value) return;
  const itemId = reportModalItem.value.id;
  saving.value[itemId] = true;
  error.value = null;
  try {
    await updateReceivingItemMismatch(
      db,
      itemId,
      currentUser.value.id,
      payload.reason,
      payload.mismatchQty,
      payload.wrongPartNo,
      payload.note
    );
    closeReportIssue();
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
    if (!currentUser.value) throw new Error("No operator user found");
    await confirmReceivingOrderArrived(db, orderId, currentUser.value.id);
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
    if (!currentUser.value) throw new Error("No operator user found");
    await createShippingBoxForPickingOrder(db, pickingOrderId, currentUser.value.id);
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
    if (!currentUser.value) throw new Error("No operator user found");
    await addPackageToBox(db, packageId, boxId, currentUser.value.id);
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
    if (!currentUser.value) throw new Error("No operator user found");
    await removePackageFromBox(db, packageId, currentUser.value.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    removingPackage.value[packageId] = false;
  }
}

useVisibleReload(load);
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
</style>
