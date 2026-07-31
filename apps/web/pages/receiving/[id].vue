<template>
  <div>
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="order">
      <DetailHeader
        v-model="headerExpanded"
        :title="order.batchNo"
        :status="order.status"
        :badge-class="badgeClass(order.status)"
        :flush-top="route.meta.props?.noPadding"
        style="margin-bottom: 1.5rem;"
      >
        <template #actions>
          <button
            v-if="order.status === 'pending' || order.status === 'provisional_received'"
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
            v-if="(order.status === 'in_hand' || order.status === 'provisional_received') && remainingItems > 0"
            :to="`/put-away/${order.id}`"
            class="btn btn--small"
          >
            {{ $t('actions.putAwayRemaining') }}
          </NuxtLink>
        </template>

        <DetailRow :label="$t('receiving.detail.supplier')" :value="order.supplier?.name" />
        <DetailRow :label="$t('goodsVerify.detail.dateCode')" :value="order.dateCode" />
        <DetailRow :label="$t('receiving.detail.deliveryDate')" :value="order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : null" />

        <DetailRow
          v-if="order.status !== 'clear' && remainingItems > 0"
          :label="$t('receiving.detail.remainingItems')"
          :value="`${remainingItems} ${remainingItems === 1 ? $t('common.item') : $t('common.items')}`"
        />
      </DetailHeader>

      <ScanFab
        v-if="order.status === 'provisional_received'"
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
          <span v-if="opt.value === 'picking'" class="tab-badge">({{ pickingOrders.length }})</span>
        </button>
      </div>

      <ReceivingItemsTab
        v-if="view === 'receiving'"
        :order="order"
        :saving="saving"
        @report-issue="openReportIssue"
        @confirm-mismatch="confirmMismatch"
        @cancel-mismatch="cancelMismatch"
      />

      <ReceivingPickingTab
        v-else
        :picking-orders="filteredPickingOrders"
        v-model:search-query="searchQuery"
        v-model:expanded-items="expandedItems"
        v-model:box-selections="boxSelections"
        :creating-box="creatingBox"
        :adding-package="addingPackage"
        :removing-package="removingPackage"
        :adding-all="addingAll"
        :any-adding-all="anyAddingAll"
        @create-box="createBox"
        @scan="openPickingScan"
        @print-box="printBox"
        @add-all-to-box="addAllToBox"
        @add-to-box="addToBox"
        @remove-from-box="removeFromBox"
        @remove-scanned-package="removeScannedPackageHandler"
      />

      <ReceivingScanReviewModal
        v-if="review"
        v-model="reviewOpen"
        :message="review.message"
        :candidates="review.candidates"
        :initial-qty="review.initialQty"
        :applying="applying"
        @pick="onPickCandidate"
      />

      <ReceivingScanMultiItemModal
        v-if="multiReview"
        :model-value="multiOpen"
        :rows="multiReview.rows"
        :candidates="multiReview.candidates"
        :applying="applying"
        :results="multiResults"
        @update:model-value="onMultiModalModelValueUpdate"
        @apply="onApplyMulti"
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
import ReceivingScanReviewModal from "~/components/receiving/ReceivingScanReviewModal.vue";
import ReceivingScanMultiItemModal from "~/components/receiving/ReceivingScanMultiItemModal.vue";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { badgeClass } from "~/composables/useStatusBadge";
import { useReceivingScan } from "~/composables/useReceivingScan";
import type {
  MultiApplyResult,
  MultiScanRow,
} from "~/composables/useReceivingScan";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { useWarehouse } from "~/composables/useWarehouse";
import { useToast } from "~/composables/useToast";
import ReportIssueModal from "~/components/ReportIssueModal.vue";
import { DisplayReceivingItem, DisplayReceivingOrder } from "~/components/receiving/types";
import type {
  MismatchReason,
  ReceivingPickingOrder,
  ReceivingScanCandidate,
} from "~/services/types";

definePageMeta({ title: "meta.receivingDetail", props: { noPadding: true } });

const { t } = useI18n();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const { showToast } = useToast();

useHead({ title: t("receiving.detail.title") });

const route = useRoute();
const router = useRouter();
const orderId = route.params.id as string;

const pending = ref(true);
const error = ref<string | null>(null);

const order = ref<DisplayReceivingOrder | null>(null);
const pickingOrders = ref<ReceivingPickingOrder[]>([]);
const saving = ref<Record<string, boolean>>({});
const confirming = ref(false);
const {
  scan,
  submitRaw,
  pickCandidate,
  applyRows,
  closeMulti,
  scanning,
  applying,
  review,
  reviewOpen,
  multiReview,
  multiOpen,
} = useReceivingScan({
  onApplied: async () => {
    await load();
    showToast(t("common.scanSuccess"));
  },
  scanItems: () =>
    (order.value?.invoices ?? []).flatMap((invoice) =>
      invoice.items.map((item) => ({
        id: item.id,
        partNo: item.partNo,
        wclItemNo: item.wclItemNo,
        lineQty: item.lineQty,
        receivedQty: item.receivedQty,
      }))
    ),
});

const multiResults = ref<MultiApplyResult[] | null>(null);

useHardwareScanner({
  enabled: () => !reviewOpen.value && !multiOpen.value,
  onScan: async (rawValue: string) => {
    const result = await submitRaw(orderId, rawValue, order.value?.supplier?.code ?? undefined);
    if (result.status === "error") {
      showToast(result.message);
      return false;
    }
    // applied → onApplied reloaded + toasted; review → modal opened.
  },
});

async function onPickCandidate(payload: { candidate: ReceivingScanCandidate; qty: number }) {
  const result = await pickCandidate(payload.candidate, payload.qty);
  if (result.status === "error") {
    showToast(result.message);
  }
}

async function onApplyMulti(rows: MultiScanRow[]) {
  const results = await applyRows(rows);
  // Merge with earlier results (replacing by partNo) so locked rows stay marked.
  const merged = new Map<string, MultiApplyResult>();
  for (const r of multiResults.value ?? []) merged.set(r.partNo, r);
  for (const r of results) merged.set(r.partNo, r);
  multiResults.value = [...merged.values()];
  if (multiResults.value.every((r) => r.ok)) {
    closeMulti();
    multiResults.value = null;
  }
}

function onMultiModalModelValueUpdate(v: boolean) {
  if (!v) {
    closeMulti();
    multiResults.value = null;
  }
}

const view = ref<"receiving" | "picking">(
  route.query.tab === "picking" ? "picking" : "receiving"
);

function setView(next: "receiving" | "picking") {
  view.value = next;
  router.replace({ query: { ...route.query, tab: next } });
}
const headerExpanded = ref(false);
const expandedItems = ref<Set<string>>(new Set());
const searchQuery = ref("");
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

const filteredPickingOrders = computed<ReceivingPickingOrder[]>(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return pickingOrders.value;
  return pickingOrders.value.filter((po) => {
    const orderMatch = po.orderNo.toLowerCase().includes(query);
    const itemMatch = po.items.some(
      (pi) =>
        pi.partNo.toLowerCase().includes(query) ||
        pi.allocations.some(
          (a) =>
            (a.lot?.dateCode ?? "").toLowerCase().includes(query) ||
            (a.lot?.lotCode ?? "").toLowerCase().includes(query)
        )
    );
    return orderMatch || itemMatch;
  });
});

const anyAddingAll = computed(() => Object.values(addingAll.value).some(Boolean));

// Same definition as the backend list endpoint: invoice items not fully put away.
const remainingItems = computed(() => {
  if (!order.value) return 0;
  return order.value.invoices
    .flatMap((invoice) => invoice.items)
    .filter((item) => item.putAwayQty < item.lineQty).length;
});

async function load() {
  try {
    const [detail, picking] = await Promise.all([
      warehouse.getReceivingOrder(orderId),
      warehouse.getPickingOrdersByReceivingOrder(orderId),
    ]);
    order.value = detail;
    pickingOrders.value = picking.pickingOrders;

    const nextBoxSelections: Record<string, string> = {};
    for (const po of picking.pickingOrders) {
      for (const item of po.items) {
        for (const pkg of item.packages) {
          if (!pkg.shippingBoxId) {
            nextBoxSelections[pkg.id] = boxSelections.value[pkg.id] ?? "";
          }
        }
      }
    }
    boxSelections.value = nextBoxSelections;
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

async function openScan() {
  const result = await scan(orderId, order.value?.supplier?.code ?? undefined);
  if (result.status === "error") {
    showToast(result.message);
  }
  // applied → onApplied reloaded + toasted; review/cancelled need nothing.
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
  if (!reportModalItem.value) return;
  saving.value[reportModalItem.value.id] = true;
  error.value = null;
  try {
    const item = reportModalItem.value;
    if (payload.isEdit) {
      await warehouse.editMismatch(item.id, {
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

async function confirmMismatch(itemId: string) {
  saving.value[itemId] = true;
  error.value = null;
  try {
    await warehouse.confirmMismatch(itemId);
    await load();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    saving.value[itemId] = false;
  }
}

async function cancelMismatch(itemId: string) {
  saving.value[itemId] = true;
  error.value = null;
  try {
    await warehouse.cancelMismatch(itemId);
    await load();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    saving.value[itemId] = false;
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

function openPickingScan(pickingOrderId: string) {
  router.push(`/picking/scan/${pickingOrderId}?from=receiving&ro=${orderId}`);
}

// Placeholder until backend-side printing lands.
function printBox(_boxId: string) {
  showToast(t("picking.detail.printComingSoon"));
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

function findPackage(packageId: string) {
  for (const po of pickingOrders.value) {
    for (const item of po.items) {
      const pkg = item.packages.find((p) => p.id === packageId);
      if (pkg) return { pkg, pickingOrderId: po.id };
    }
  }
  return null;
}

async function addAllToBox(boxId: string) {
  if (anyAddingAll.value) return;

  const po = pickingOrders.value.find((o) => o.boxes.some((b) => b.id === boxId));
  if (!po) return;

  const count = po.items
    .flatMap((item) => item.packages)
    .filter((p) => !p.shippingBoxId).length;
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
  const found = findPackage(packageId);
  if (!found?.pkg.shippingBoxId) return;
  removingPackage.value[packageId] = true;
  try {
    await warehouse.removePackageFromBox(found.pkg.shippingBoxId, packageId);
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
