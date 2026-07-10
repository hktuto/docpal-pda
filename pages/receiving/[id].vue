<template>
  <div>
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

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
            <template v-if="confirming">
              <InlineSpinner /> {{ $t('actions.confirming') }}
            </template>
            <template v-else>
              {{ $t('receiving.detail.confirmArrived') }}
            </template>
          </button>
          <NuxtLink
            v-if="order.status === 'in_hand' && remainingItems > 0"
            :to="`/put-away/${order.id}`"
            class="btn btn--small"
          >
            {{ $t('actions.putAwayRemaining') }}
          </NuxtLink>
        </template>

        <DetailRow :label="$t('receiving.detail.supplier')" :value="order.supplier?.name" />
        <DetailRow :label="$t('receiving.detail.deliveryDate')" :value="order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : null" />
        <DetailRow
          v-if="order.status === 'in_hand' && remainingItems > 0"
          :label="$t('receiving.detail.remainingItems')"
          :value="`${remainingItems} ${remainingItems === 1 ? $t('common.item') : $t('common.items')}`"
        />
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
          @click="setView(opt.value)"
        >
          {{ $t(opt.labelKey) }}
          <span v-if="opt.value === 'picking'" class="tab-badge">({{ groupedPickingOrders.length }})</span>
        </button>
      </div>

      <ReceivingItemsTab
        v-if="view === 'receiving'"
        :order="order"
        :allocated-by-item="allocatedByItem"
        :saving="saving"
        @report-issue="openReportIssue"
        @confirm-mismatch="confirmMismatch"
        @cancel-mismatch="cancelMismatch"
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
        :adding-all="addingAll"
        :any-adding-all="anyAddingAll"
        :unboxed-count-by-order-id="unboxedCountByOrderId"
        :scanning="scanning"
        @create-box="createBox"
        @add-all-to-box="addAllToBox"
        @add-to-box="addToBox"
        @remove-from-box="removeFromBox"
        @remove-scanned-package="removeScannedPackageHandler"
        @scan="openScan"
      />

      <LabelScanReviewModal
        v-if="review?.status === 'review'"
        v-model="reviewOpen"
        :image-path="review.capture.imagePath"
        :text="review.capture.text"
        :barcodes="review.capture.barcodes"
        :parsed="review.parsed"
        :options="review.options"
        :match-result="review.matchResult"
        :mode="review.capture.imagePath ? 'review' : 'manual'"
        :context="{ task: 'receiving', receivingOrderId: orderId, pickingItemId: scanPickingItemId }"
        @applied="onApplied"
        @retake="onRetake"
      />

      <ReportIssueModal
        :model-value="reportModalOpen"
        :item="reportModalItem"
        :saving="saving[reportModalItem?.id ?? ''] ?? false"
        @update:model-value="onReportModalModelValueUpdate"
        @confirm="onConfirmIssue"
      />
    </template>

  </div>
</template>

<script setup lang="ts">
import ReceivingItemsTab from "~/components/receiving/ReceivingItemsTab.vue";
import ReceivingPickingTab from "~/components/receiving/ReceivingPickingTab.vue";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { badgeClass } from "~/composables/useStatusBadge";
import { useLabelScanReview } from "~/composables/useLabelScanReview";
import { useLabelScan, buildRawCapture } from "~/composables/useLabelScan";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { useWarehouse } from "~/composables/useWarehouse";
import { useToast } from "~/composables/useToast";
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
import type { MismatchReason } from "~/services/types";

definePageMeta({ title: "meta.receivingDetail", props: { noPadding: true } });

const { t } = useI18n();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const { showToast } = useToast();

useHead({ title: t("receiving.detail.title") });

const route = useRoute();
const router = useRouter();
const orderId = route.params.id as string;

const { currentUser } = useAuth();

const pending = ref(true);
const error = ref<string | null>(null);

const order = ref<DisplayReceivingOrder | null>(null);
const pickingRows = ref<NonNullable<DisplayReceivingOrder["pickingRows"]>>([]);
const saving = ref<Record<string, boolean>>({});
const confirming = ref(false);
const { scan, scanning, review, reviewOpen, onApplied } = useLabelScanReview({
  onApplied: load,
});
const { processCapture } = useLabelScan();

useHardwareScanner({
  enabled: () => !reviewOpen.value,
  onScan: async (rawValue: string) => {
    const result = await processCapture(buildRawCapture(rawValue), {
      task: "receiving",
      receivingOrderId: orderId,
      targets: scanTargets.value,
      confirmSingleMatch: true,
      supplierCode: order.value?.supplier?.code,
    });
    if (result.status === "error") {
      showToast(result.message);
    } else if (result.status === "applied") {
      await onApplied();
      showToast(t("common.scanSuccess"));
    } else if (result.status === "review") {
      review.value = result;
      reviewOpen.value = true;
    }
  },
});

async function onRetake() {
  reviewOpen.value = false;
  await openScan(scanPickingItemId.value);
}

const scanPickingItemId = ref<string | undefined>(undefined);
const view = ref<"receiving" | "picking">(
  route.query.tab === "picking" ? "picking" : "receiving"
);

function setView(next: "receiving" | "picking") {
  view.value = next;
  router.replace({ query: { ...route.query, tab: next } });
}
const headerExpanded = ref(false);
const transitionLogs = ref<Record<string, TransitionLog[]>>({});
const expandedItems = ref<Set<string>>(new Set());
const searchQuery = ref("");
const packagesByItem = ref<Record<string, DisplayPackage[]>>({});
const boxesByOrder = ref<Record<string, DisplayBox[]>>({});
const creatingBox = ref<Record<string, boolean>>({});
const addingPackage = ref<Record<string, boolean>>({});
const removingPackage = ref<Record<string, boolean>>({});
const addingAll = ref<Record<string, boolean>>({});
const boxSelections = ref<Record<string, string>>({});
const reportModalOpen = ref(false);
const reportModalItem = ref<DisplayReceivingItem | null>(null);

const views = [
  { labelKey: "receiving.detail.tabReceiving", value: "receiving" as const },
  { labelKey: "receiving.detail.tabPicking", value: "picking" as const },
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

const unboxedCountByOrderId = computed(() => {
  const counts: Record<string, number> = {};
  for (const po of filteredGroupedPickingOrders.value) {
    let count = 0;
    for (const item of po.items) {
      const packages = packagesByItem.value[item.id] ?? [];
      count += packages.filter((p) => !p.shippingBoxId).length;
    }
    counts[po.id] = count;
  }
  return counts;
});

const anyAddingAll = computed(() => Object.values(addingAll.value).some(Boolean));

const scanTargets = computed(() => {
  if (!order.value) return [];
  return order.value.invoices
    .flatMap((invoice) => invoice.items)
    .map((item) => item.part?.partNo)
    .filter((partNo): partNo is string => !!partNo);
});

const remainingItems = ref(0);
const allocatedByItem = ref<Record<string, number>>({});

async function load() {
  try {
    const detail = await warehouse.getReceivingOrder(orderId);

    order.value = detail as DisplayReceivingOrder;
    pickingRows.value = detail.pickingRows;
    remainingItems.value = detail.remainingItems;
    allocatedByItem.value = detail.allocatedByItem;
    boxesByOrder.value = detail.boxesByOrder;
    transitionLogs.value = detail.transitionLogs;

    const nextBoxSelections: Record<string, string> = {};
    for (const [itemId, packages] of Object.entries(detail.packagesByItem)) {
      for (const pkg of packages) {
        if (!pkg.shippingBoxId) {
          nextBoxSelections[pkg.id] = boxSelections.value[pkg.id] ?? "";
        }
      }
    }
    packagesByItem.value = detail.packagesByItem;
    boxSelections.value = nextBoxSelections;
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

async function openScan(itemId?: string) {
  scanPickingItemId.value = itemId;
  const result = await scan({
    task: "receiving",
    receivingOrderId: orderId,
    pickingItemId: scanPickingItemId.value,
    targets: scanTargets.value,
    confirmSingleMatch: true,
    supplierCode: order.value?.supplier?.code,
  });
  if (result.status === "error") {
    showToast(result.message);
  }
  // applied/review/manual are handled by useLabelScanReview.
}

function openReportIssue(item: DisplayReceivingItem) {
  reportModalItem.value = item;
  reportModalOpen.value = true;
}

function onReportModalModelValueUpdate(v: boolean) {
  reportModalOpen.value = v;
  if (!v) reportModalItem.value = null;
}

async function onConfirmIssue(payload: {
  reason: MismatchReason;
  mismatchQty: number | null;
  wrongPartNo: string | null;
  note: string;
  isEdit: boolean;
}) {
  if (!currentUser.value || !reportModalItem.value) return;
  saving.value[reportModalItem.value.id] = true;
  error.value = null;
  try {
    const item = reportModalItem.value;
    if (payload.isEdit && item.mismatch) {
      await warehouse.editMismatch(item.mismatch.id, {
        reason: payload.reason,
        mismatchQty: payload.mismatchQty,
        wrongPartNo: payload.wrongPartNo,
        note: payload.note,
      });
    } else {
      await warehouse.reportMismatch(item.id, {
        reason: payload.reason,
        mismatchQty: payload.mismatchQty,
        wrongPartNo: payload.wrongPartNo,
        note: payload.note,
      });
    }
    reportModalOpen.value = false;
    await load();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    saving.value[reportModalItem.value.id] = false;
  }
}

async function confirmMismatch(mismatchId: string) {
  if (!currentUser.value) return;
  saving.value[mismatchId] = true;
  error.value = null;
  try {
    await warehouse.confirmMismatch(mismatchId);
    await load();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    saving.value[mismatchId] = false;
  }
}

async function cancelMismatch(mismatchId: string) {
  if (!currentUser.value) return;
  saving.value[mismatchId] = true;
  error.value = null;
  try {
    await warehouse.cancelMismatch(mismatchId);
    await load();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    saving.value[mismatchId] = false;
  }
}

async function confirmArrival() {
  confirming.value = true;
  try {
    await warehouse.confirmReceivingOrderArrived(orderId);
    await load();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    confirming.value = false;
  }
}

async function createBox(pickingOrderId: string) {
  creatingBox.value[pickingOrderId] = true;
  try {
    await warehouse.createShippingBoxForPickingOrder(pickingOrderId);
    await load();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    creatingBox.value[pickingOrderId] = false;
  }
}

async function addAllToBox(boxId: string) {
  if (anyAddingAll.value) return;

  let pickingOrderId: string | null = null;
  for (const po of filteredGroupedPickingOrders.value) {
    const boxes = boxesByOrder.value[po.id] ?? [];
    if (boxes.some((b) => b.id === boxId)) {
      pickingOrderId = po.id;
      break;
    }
  }
  if (!pickingOrderId) return;

  const count = unboxedCountByOrderId.value[pickingOrderId] ?? 0;
  if (count === 0) return;

  const confirmed = window.confirm(t("receiving.pickingTab.addAllConfirm", { count }));
  if (!confirmed) return;

  addingAll.value[boxId] = true;
  error.value = null;
  try {
    await warehouse.addAllUnboxedPackagesToBox(boxId);
    await load();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    addingAll.value[boxId] = false;
  }
}

async function addToBox(packageId: string) {
  const boxId = boxSelections.value[packageId];
  if (!boxId) return;
  addingPackage.value[packageId] = true;
  try {
    await warehouse.addPackageToBox(packageId, boxId);
    await load();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    addingPackage.value[packageId] = false;
  }
}

async function removeFromBox(packageId: string) {
  removingPackage.value[packageId] = true;
  try {
    await warehouse.removePackageFromBox(packageId);
    await load();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    removingPackage.value[packageId] = false;
  }
}

async function removeScannedPackageHandler(packageId: string) {
  removingPackage.value[packageId] = true;
  try {
    await warehouse.removeScannedPackage(packageId);
    await load();
  } catch (e: any) {
    error.value = errorMessage(e);
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
