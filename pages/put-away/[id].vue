<template>
  <div>
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="order">
      <DetailHeader
        v-model="headerExpanded"
        :title="order.refNo"
        :status="headerStatus"
        :badge-class="badgeClass(order.status)"
        :flush-top="route.meta.props?.noPadding"
        style="margin-bottom: 1.5rem;"
      >
        <DetailRow :label="$t('putAway.detail.supplier')" :value="order.supplier?.name" />
        <DetailRow :label="$t('putAway.detail.deliveryDate')" :value="order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : null" />
      </DetailHeader>

      <ShelfBoxesPanel
        v-model:boxes-expanded="boxesExpanded"
        v-model:expanded-item-boxes="expandedItemBoxes"
        :boxes="boxes"
        :shelves="shelves"
        :actionable="order.status !== 'clear'"
        :creating="creating"
        :closing="closing"
        :cancelling-box="cancellingBox"
        :adding-all="addingAll"
        :any-adding-all="anyAddingAll"
        :unboxed-count="unboxedCountForOrder"
        @new-box="openNewBoxDialog"
        @close-box="closeBox"
        @cancel-box="cancelBox"
        @add-all-to-box="addAllToBox"
      />

      <SelectShelfDialog
        v-model="newBoxDialogOpen"
        :shelves="shelves"
        @selected="createBoxFromDialog"
      />

      <PutAwayLotsPanel
        v-model:box-selections="boxSelections"
        v-model:expanded-items="expandedItems"
        :lots="lots"
        :scans="scans"
        :boxes="boxes"
        :scanning="scanning"
        :adding-scan="addingScan"
        :removing-scan="removingScan"
        @scan="openScan"
        @add-to-box="addScanToBox"
        @remove-from-box="removeScanFromBoxHandler"
        @remove-scan="removeScanHandler"
      />
    </template>

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
      :context="{ task: 'put-away', receivingItem: scanLot ?? undefined }"
      @applied="onApplied"
      @retake="onRetake"
    />
  </div>
</template>

<script setup lang="ts">
import { useVisibleReload } from "~/composables/useVisibleReload";
import { badgeClass } from "~/composables/useStatusBadge";
import { useStatusLabel } from "~/composables/useStatusLabel";
import { useLabelScanReview } from "~/composables/useLabelScanReview";
import { useErrorMessage } from "~/composables/errorMessage";
import { I18nError } from "~/composables/i18nError";
import { useWarehouse } from "~/composables/useWarehouse";
import { useToast } from "~/composables/useToast";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import SelectShelfDialog from "~/components/SelectShelfDialog.vue";
import ShelfBoxesPanel from "~/components/put-away/ShelfBoxesPanel.vue";
import PutAwayLotsPanel from "~/components/put-away/PutAwayLotsPanel.vue";
import type {
  PutAwayLot,
  PutAwayScan,
  ShelfBox,
  Shelf,
  ReceivingOrderDetail,
} from "~/services/types";

definePageMeta({ title: "meta.putAwayDetail", props: { noPadding: true } });

const { t } = useI18n();
const errorMessage = useErrorMessage();
const { showToast } = useToast();

useHead({ title: t("putAway.detail.title") });

const route = useRoute();
const orderId = route.params.id as string;

const headerExpanded = ref(false);
const boxesExpanded = ref(false);
const newBoxDialogOpen = ref(false);
const expandedItemBoxes = ref<Set<string>>(new Set());

const statusLabel = useStatusLabel();
const headerStatus = computed(() =>
  order.value ? statusLabel.receiving(order.value.status) : ""
);

const warehouse = useWarehouse();

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<ReceivingOrderDetail | null>(null);
const lots = ref<PutAwayLot[]>([]);
const shelves = ref<Shelf[]>([]);
const boxes = ref<ShelfBox[]>([]);
const creating = ref(false);
const closing = ref(false);
const cancellingBox = ref<Record<string, boolean>>({});

const scanLot = ref<PutAwayLot | null>(null);
const scans = ref<PutAwayScan[]>([]);
const addingScan = ref<Record<string, boolean>>({});
const removingScan = ref<Record<string, boolean>>({});
const boxSelections = ref<Record<string, string>>({});
const expandedItems = ref<Set<string>>(new Set());
const addingAll = ref<Record<string, boolean>>({});

const unboxedCountForOrder = computed(
  () => scans.value.filter((s) => !s.shelfBoxId).length
);

const anyAddingAll = computed(() =>
  Object.values(addingAll.value).some(Boolean)
);

const { scan, scanning, review, reviewOpen, onApplied } = useLabelScanReview({ onApplied: load });

async function addScanToBox(scanId: string) {
  const boxId = boxSelections.value[scanId];
  if (!boxId) return;
  addingScan.value[scanId] = true;
  error.value = null;
  try {
    await warehouse.assignPutAwayScanToBox(scanId, boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    addingScan.value[scanId] = false;
  }
}

async function removeScanFromBoxHandler(scanId: string) {
  removingScan.value[scanId] = true;
  error.value = null;
  try {
    await warehouse.removePutAwayScanFromBox(scanId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    removingScan.value[scanId] = false;
  }
}

async function removeScanHandler(scanId: string) {
  removingScan.value[scanId] = true;
  error.value = null;
  try {
    await warehouse.removePutAwayScannedPiece(scanId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    removingScan.value[scanId] = false;
  }
}

useVisibleReload(load);

async function load() {
  pending.value = true;
  error.value = null;
  try {
    const [orderData, lotsData, shelvesData, boxesData, scansData] = await Promise.all([
      warehouse.getReceivingOrder(orderId),
      warehouse.getPutAwayLots(orderId),
      warehouse.getShelves(),
      warehouse.getShelfBoxesForReceivingOrder(orderId),
      warehouse.getPutAwayScans(orderId),
    ]);
    order.value = orderData;
    lots.value = lotsData;
    shelves.value = shelvesData;

    const previousBoxIds = new Set(boxes.value.map((b) => b.id));
    boxes.value = boxesData;
    scans.value = scansData;
    const nextExpanded = new Set(expandedItemBoxes.value);
    for (const b of boxesData) {
      if (b.status === "open" && !previousBoxIds.has(b.id)) {
        nextExpanded.add(b.id);
      }
    }
    expandedItemBoxes.value = nextExpanded;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

function openNewBoxDialog() {
  newBoxDialogOpen.value = true;
  boxesExpanded.value = true;
}

async function createBoxFromDialog(shelfCode: string) {
  error.value = null;
  creating.value = true;
  try {
    await warehouse.createShelfBox(orderId, shelfCode);
    await load();
    boxesExpanded.value = true;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    creating.value = false;
  }
}

async function closeBox(boxId: string) {
  error.value = null;
  closing.value = true;
  try {
    await warehouse.closeShelfBox(boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    closing.value = false;
  }
}

async function cancelBox(boxId: string) {
  error.value = null;
  cancellingBox.value[boxId] = true;
  try {
    await warehouse.cancelShelfBox(boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    cancellingBox.value[boxId] = false;
  }
}

async function addAllToBox(boxId: string) {
  const count = unboxedCountForOrder.value;
  if (count === 0) return;
  const confirmed = window.confirm(t('putAway.shelfBoxesPanel.addAllConfirm', { count }));
  if (!confirmed) return;

  addingAll.value[boxId] = true;
  error.value = null;
  try {
    await warehouse.addAllUnboxedScansToBox(boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    addingAll.value[boxId] = false;
  }
}

async function openScan(lot: PutAwayLot) {
  error.value = null;
  scanLot.value = lot;
  const result = await scan({
    task: 'put-away',
    receivingItem: lot,
    targets: lot.partNo ? [lot.partNo] : [],
  });
  if (result.status === 'error') {
    showToast(result.message);
  }
}

async function onRetake() {
  reviewOpen.value = false;
  const lot = scanLot.value;
  if (!lot) {
    error.value = errorMessage(new I18nError("no_scan_item_to_retake"));
    return;
  }
  await openScan(lot);
}
</script>

<style scoped>
</style>
