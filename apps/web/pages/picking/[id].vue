<template>
  <div>
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="order">
      <DetailHeader
        v-model="headerExpanded"
        :title="order.orderNo"
        :status="headerStatus"
        :badge-class="headerBadgeClass"
        :flush-top="route.meta.props?.noPadding"
        style="margin-bottom: 1.5rem;"
      >
        <template #actions>
          <template v-if="order.status !== 'finished' && order.status !== 'issue' && !heldByOther">
            <NuxtLink :to="`/picking/scan/${orderId}`" class="btn btn--small">
              {{ $t('picking.detail.scan') }}
            </NuxtLink>
            <button
              v-if="allItemsFullyBoxed"
              class="btn btn--small"
              :disabled="finishing"
              @click="finish"
            >
              <template v-if="finishing">
                <InlineSpinner /> {{ $t('actions.finishing') }}
              </template>
              <template v-else>
                {{ $t('picking.detail.finishPicking') }}
              </template>
            </button>
          </template>
          <NuxtLink
            v-if="order.status === 'finished' && order.measuringTask"
            :to="`/measuring/${order.measuringTask.id}`"
            class="btn btn--small"
          >
            {{ $t('picking.detail.measuring') }}
          </NuxtLink>
        </template>

        <DetailRow :label="$t('picking.detail.customer')" :value="order.customerCode" />
        <DetailRow :label="$t('picking.detail.deliveryDate')" :value="order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : null" />
        <DetailRow :label="$t('picking.detail.poNo')" :value="order.poNo" />
        <DetailRow :label="$t('picking.detail.shipTo')" :value="order.shipTo" />
        <DetailRow v-if="order.orgId != null" :label="$t('picking.detail.org')" :value="`Org ${order.orgId}`" />
        <DetailRow v-if="order.subInventoryCode" :label="$t('picking.detail.subInventory')" :value="order.subInventoryCode" />
      </DetailHeader>

      <PickingIssueBanner v-if="order.status === 'issue'" :order="order" />

      <div v-if="heldByOther" class="work-lock-banner">
        {{ $t('picking.detail.heldBy', { name: heldByOther }) }}
      </div>

      <PickingBoxesSection
        v-model:expanded="boxesExpanded"
        :boxes="order.boxes"
        :actionable="actionable"
        :creating-box="creatingBox"
        :scanning-box="scanningBox"
        :cancelling-box="cancellingBox"
        :adding-all="addingAll"
        :any-adding-all="anyAddingAll"
        :unboxed-count="unboxedCountForOrder"
        @create-box="createBox"
        @scan-box="scanBoxId"
        @cancel-box="cancelBox"
        @add-all-to-box="addAllToBox"
      />

      <PickingItemsSection
        v-model:box-selections="boxSelections"
        :items="order.items ?? []"
        :actionable="actionable"
        :adding="adding"
        :removing="removing"
        :open-boxes="openBoxes"
        @add-to-box="addToBox"
        @remove-from-box="removeFromBox"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { useToast } from "~/composables/useToast";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { badgeClass } from "~/composables/useStatusBadge";
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { usePickingWorkLock } from "~/composables/usePickingWorkLock";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { useLabelScan, captureLabel, captureRawLabelValue } from "~/composables/useLabelScan";
import PickingBoxesSection from "~/components/picking/PickingBoxesSection.vue";
import PickingItemsSection from "~/components/picking/PickingItemsSection.vue";
import PickingIssueBanner from "~/components/picking/PickingIssueBanner.vue";
import type {
  PickingOrderDetail,
} from "~/services/types";

definePageMeta({ title: "meta.pickingDetail", props: { noPadding: true } });

const route = useRoute();
const orderId = route.params.id as string;
const warehouse = useWarehouse();
const { heldByOther } = usePickingWorkLock(orderId);
const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();

useHead({ title: t("picking.detail.title") });

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<PickingOrderDetail | null>(null);
const adding = ref<Record<string, boolean>>({});
const removing = ref<Record<string, boolean>>({});
const creatingBox = ref(false);
const cancellingBox = ref<Record<string, boolean>>({});
const addingAll = ref<Record<string, boolean>>({});
const finishing = ref(false);
const headerExpanded = ref(false);
const boxesExpanded = ref(false);
const boxSelections = ref<Record<string, string>>({});

const { showToast } = useToast();
const { parseRawValue } = useLabelScan();
const scanningBox = ref(false);

// Scan-to-create-box: on this page a scan that matches a supplier QR template
// is an item label (point the operator at scan mode); anything else is treated
// as a pre-printed box id and creates an open box with that id.
async function createBoxWithId(boxId: string) {
  const trimmed = boxId.trim();
  if (!trimmed || scanningBox.value) return;
  scanningBox.value = true;
  try {
    await warehouse.createShippingBoxForPickingOrder(orderId, trimmed);
    boxesExpanded.value = true;
    await load();
    showToast(t("picking.detail.boxCreated", { id: trimmed }));
  } catch (e) {
    showToast(errorMessage(e));
  } finally {
    scanningBox.value = false;
  }
}

useHardwareScanner({
  enabled: () => actionable.value && !scanningBox.value,
  onScan: async (rawValue: string) => {
    const parsedResult = await parseRawValue(rawValue);
    if (parsedResult.matched) {
      showToast(t("picking.detail.itemQrUseScanMode"));
      return;
    }
    await createBoxWithId(rawValue);
  },
});

async function scanBoxId() {
  if (scanningBox.value) return;
  try {
    const capture = await captureLabel();
    if (!capture) return;
    const value = captureRawLabelValue(capture).trim();
    if (value) await createBoxWithId(value);
  } catch (e) {
    showToast(errorMessage(e));
  }
}

const allItemsFullyBoxed = computed(
  () => order.value?.items?.every((i) => i.pickedQty >= i.qty) ?? false
);
const headerBadgeClass = computed(() => badgeClass(order.value?.status));
const headerStatus = computed(() => statusLabel.picking(order.value?.status ?? ""));
const openBoxes = computed(() =>
  (order.value?.boxes ?? []).filter((b) => b.status === "open")
);
const actionable = computed(
  () =>
    order.value?.status !== "finished" &&
    order.value?.status !== "issue" &&
    !heldByOther.value
);
const unboxedCountForOrder = computed(() => {
  return (order.value?.items ?? []).reduce((sum, item) => {
    const unboxed = (item.packages ?? []).filter((p) => !p.shippingBoxId);
    return sum + unboxed.length;
  }, 0);
});
const anyAddingAll = computed(() => Object.values(addingAll.value).some(Boolean));

async function load() {
  try {
    const data = await warehouse.getPickingOrder(orderId);
    order.value = data;
    const nextBoxSelections: Record<string, string> = {};
    for (const item of data.items) {
      for (const pkg of item.packages ?? []) {
        if (!pkg.shippingBoxId) {
          nextBoxSelections[pkg.id] = boxSelections.value[pkg.id] ?? "";
        }
      }
    }
    boxSelections.value = nextBoxSelections;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

async function createBox() {
  creatingBox.value = true;
  boxesExpanded.value = true;
  try {
    await warehouse.createShippingBoxForPickingOrder(orderId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    creatingBox.value = false;
  }
}

async function cancelBox(boxId: string) {
  cancellingBox.value[boxId] = true;
  try {
    await warehouse.cancelShippingBox(boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    cancellingBox.value[boxId] = false;
  }
}

async function addAllToBox(boxId: string) {
  if (anyAddingAll.value) return;
  const count = unboxedCountForOrder.value;
  if (count === 0) return;
  const confirmed = window.confirm(t("picking.boxesSection.addAllConfirm", { count }));
  if (!confirmed) return;

  addingAll.value[boxId] = true;
  error.value = null;
  try {
    await warehouse.addAllUnboxedPackagesToBox(boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    addingAll.value[boxId] = false;
  }
}

async function addToBox(packageId: string) {
  const boxId = boxSelections.value[packageId];
  if (!boxId) return;
  adding.value[packageId] = true;
  try {
    await warehouse.addPackageToBox(packageId, boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    adding.value[packageId] = false;
  }
}

async function removeFromBox(packageId: string) {
  const pkg = order.value?.items
    .flatMap((i) => i.packages ?? [])
    .find((p) => p.id === packageId);
  if (!pkg?.shippingBoxId) return;
  removing.value[packageId] = true;
  try {
    await warehouse.removePackageFromBox(pkg.shippingBoxId, packageId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    removing.value[packageId] = false;
  }
}

async function finish() {
  finishing.value = true;
  try {
    await warehouse.finishPickingOrder(orderId);
    await load();
    if (order.value?.measuringTask) {
      showToast(t("picking.detail.measuringTaskCreated"), {
        action: {
          label: t("picking.detail.goToMeasuring"),
          to: `/measuring/${order.value.measuringTask.id}`,
        },
      });
    }
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    finishing.value = false;
  }
}

useVisibleReload(load);
</script>

<style scoped>
.work-lock-banner {
  background: #fef3c7;
  border: 1px solid #f59e0b;
  border-radius: 6px;
  color: #92400e;
  font-size: 0.875rem;
  padding: 0.6rem 1rem;
  margin-bottom: 1rem;
}
</style>
