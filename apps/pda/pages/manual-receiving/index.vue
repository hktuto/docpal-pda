<script setup lang="ts">
import { formatCompactQtyUpper } from "~/utils/formatNumber";
import { captureLabel, captureRawLabelValue } from "~/composables/useLabelScan";
import {
  isDuplicateOrderNo,
  isDuplicateRaw,
  normalizeOrderNo,
  orderTotalQty,
  type ManualReceivingDraftItem,
  type ManualReceivingDraftOrder,
} from "~/utils/manualReceiving";
import type { CnManualReceiptOrder } from "~/services/types";

// 手動收貨 (spec 2026-10-27-manual-receiving-pda-design): one page, two views.
// Task view stages order numbers + their scanned items locally; the scan view
// decodes supplier labels into items (hardware scanner / camera OCR). 完成
// commits the whole task via POST /receiving-cn/manual-receipts.

definePageMeta({ title: "meta.manualReceiving" });

const { t } = useI18n();
const { showToast } = useToast();
const warehouse = useWarehouse();
const { parseRawValue } = useLabelScan();

const orders = ref<ManualReceivingDraftOrder[]>([]);
let nextUid = 1;

// One task = one brand: locked by the first label that resolves to a supplier
// template (single-brand profile → the brand, otherwise the supplier code).
const taskBrand = ref<string | null>(null);

const view = ref<"task" | "scan">("task");
const scanOrderIndex = ref(-1);
let scanSnapshot: ManualReceivingDraftItem[] = [];

// ---- task view: order numbers ----

const newOrderNo = ref("");

function addOrder() {
  const orderNo = newOrderNo.value.trim();
  if (!orderNo) return;
  if (isDuplicateOrderNo(orders.value, orderNo)) {
    showToast(t("manualReceiving.duplicateOrderNo"));
    return;
  }
  orders.value.push({ orderNo, items: [] });
  newOrderNo.value = "";
}

// 修改 order no dialog
const editOrderOpen = ref(false);
const editOrderIndex = ref(-1);
const editOrderValue = ref("");

function openEditOrder(index: number) {
  editOrderIndex.value = index;
  editOrderValue.value = orders.value[index].orderNo;
  editOrderOpen.value = true;
}

function saveEditOrder() {
  const orderNo = editOrderValue.value.trim();
  if (!orderNo) return;
  if (isDuplicateOrderNo(orders.value, orderNo, editOrderIndex.value)) {
    showToast(t("manualReceiving.duplicateOrderNo"));
    return;
  }
  orders.value[editOrderIndex.value].orderNo = orderNo;
  editOrderOpen.value = false;
}

function removeOrder(index: number) {
  orders.value.splice(index, 1);
}

// ---- scan view ----

const scanning = ref(false);
const scanOrder = computed(() => orders.value[scanOrderIndex.value] ?? null);

function openScan(index: number) {
  scanOrderIndex.value = index;
  scanSnapshot = [...orders.value[index].items];
  view.value = "scan";
}

function cancelScan() {
  if (scanOrder.value) scanOrder.value.items = scanSnapshot;
  view.value = "task";
}

function finishScan() {
  if (!scanOrder.value || scanOrder.value.items.length === 0) {
    showToast(t("manualReceiving.noScannedItems"));
    return;
  }
  view.value = "task";
}

const editItemOpen = ref(false);
const editItemIsNew = ref(false);
const editItemDraft = ref<ManualReceivingDraftItem | null>(null);

function openEditItem(item: ManualReceivingDraftItem, isNew: boolean) {
  editItemDraft.value = { ...item };
  editItemIsNew.value = isNew;
  editItemOpen.value = true;
}

function saveEditItem() {
  const draft = editItemDraft.value;
  const order = scanOrder.value;
  if (!draft || !order) return;
  const partNo = draft.partNo.trim();
  const qty = Number(draft.qty);
  if (!partNo || !Number.isInteger(qty) || qty <= 0) {
    showToast(t("manualReceiving.invalidItem"));
    return;
  }
  draft.partNo = partNo;
  draft.qty = qty;
  if (editItemIsNew.value) {
    order.items.push(draft);
  } else {
    const index = order.items.findIndex((i) => i.uid === draft.uid);
    if (index >= 0) order.items[index] = draft;
  }
  editItemOpen.value = false;
}

function deleteItem(item: ManualReceivingDraftItem) {
  const order = scanOrder.value;
  if (!order) return;
  order.items = order.items.filter((i) => i.uid !== item.uid);
}

async function handleRawScan(raw: string): Promise<boolean | void> {
  const order = scanOrder.value;
  if (!order) return false;
  const value = raw.trim();
  if (!value) return false;
  if (isDuplicateRaw(order, value)) {
    showToast(t("manualReceiving.duplicateLabel"));
    return false;
  }
  scanning.value = true;
  try {
    const result = await parseRawValue(value);
    const parsed = result.parsed;
    if (!parsed.itemId) {
      showToast(t("manualReceiving.noPartNo"));
      return false;
    }
    const scanBrand = result.supplier
      ? (result.supplier.brands?.length === 1 ? result.supplier.brands[0] : result.supplier.code)
      : undefined;
    if (scanBrand) {
      if (!taskBrand.value) taskBrand.value = scanBrand;
      else if (taskBrand.value !== scanBrand) {
        showToast(t("manualReceiving.mixedBrand", { brand: taskBrand.value }));
        return false;
      }
    }
    const item: ManualReceivingDraftItem = {
      uid: nextUid++,
      partNo: parsed.itemId,
      wclItemNo: parsed.wclItemNo,
      brand: scanBrand ?? taskBrand.value ?? undefined,
      supplierCode: result.supplier?.code,
      qty: parsed.qty ?? 0,
      dateCode: parsed.dateCode ?? "",
      lotCode: parsed.lotCode ?? "",
      coo: parsed.coo ?? "",
      cow: parsed.cow ?? "",
      raw: value,
    };
    // The label gave no qty → the operator must confirm the row by hand.
    if (item.qty > 0) order.items.push(item);
    else openEditItem(item, true);
    return true;
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    scanning.value = false;
  }
}

useHardwareScanner({
  enabled: () => view.value === "scan" && !editItemOpen.value && !scanning.value,
  onScan: handleRawScan,
});

async function onCameraScan() {
  const capture = await captureLabel();
  if (!capture) return;
  await handleRawScan(captureRawLabelValue(capture));
}

// ---- task footer: cancel / finish ----

const submitting = ref(false);
const confirmDiscardOpen = ref(false);
const confirmFinishOpen = ref(false);

const canFinish = computed(() => orders.value.length > 0 && orders.value.every((o) => o.items.length > 0));

function cancelTask() {
  if (orders.value.length === 0) {
    navigateTo("/");
    return;
  }
  confirmDiscardOpen.value = true;
}

async function submit() {
  if (!canFinish.value || submitting.value) return;
  if (!taskBrand.value) {
    showToast(t("manualReceiving.brandRequired"));
    return;
  }
  submitting.value = true;
  try {
    const payload: CnManualReceiptOrder[] = orders.value.map((order) => ({
      orderNo: order.orderNo,
      items: order.items.map((item) => ({
        partNo: item.partNo,
        qty: item.qty,
        ...(item.wclItemNo ? { wclItemNo: item.wclItemNo } : {}),
        brand: item.brand ?? taskBrand.value!,
        ...(item.supplierCode ? { supplierCode: item.supplierCode } : {}),
        ...(item.dateCode ? { dateCode: item.dateCode } : {}),
        ...(item.lotCode ? { lotCode: item.lotCode } : {}),
        ...(item.coo ? { coo: item.coo } : {}),
        ...(item.cow ? { cow: item.cow } : {}),
        ...(item.raw ? { raw: item.raw } : {}),
      })),
    }));
    await warehouse.createCnManualReceipt(payload);
    showToast(t("manualReceiving.submitted"));
    await navigateTo("/put-away");
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
  } finally {
    submitting.value = false;
    confirmFinishOpen.value = false;
  }
}
</script>

<template>
  <div class="manual-receiving">
    <!-- Task view -->
    <template v-if="view === 'task'">
      <div class="add-order">
        <label class="add-order__label" for="mr-order-no">{{ $t("manualReceiving.addOrderNo") }}</label>
        <div class="add-order__row">
          <input
            id="mr-order-no"
            v-model="newOrderNo"
            class="add-order__input"
            type="text"
            :placeholder="$t('manualReceiving.addOrderNoPlaceholder')"
            @keydown.enter.prevent="addOrder"
          />
          <button class="btn" :disabled="!newOrderNo.trim()" @click="addOrder">
            {{ $t("manualReceiving.confirm") }}
          </button>
        </div>
      </div>

      <EmptyState v-if="orders.length === 0" :message="$t('manualReceiving.noOrders')" />

      <div v-for="(order, index) in orders" :key="normalizeOrderNo(order.orderNo)" class="order-card">
        <div class="order-card__head">
          <span class="order-card__no">
            {{ order.orderNo }}
            <span v-if="order.items.length" class="order-card__progress">
              ({{ order.items.length }}/{{ formatCompactQtyUpper(orderTotalQty(order)) }})
            </span>
          </span>
          <span class="order-card__actions">
            <button class="btn btn--ghost btn--small" @click="openEditOrder(index)">
              {{ $t("manualReceiving.edit") }}
            </button>
            <button class="btn btn--small" @click="openScan(index)">
              {{ $t("actions.scan") }}
            </button>
          </span>
        </div>
        <ul v-if="order.items.length" class="order-card__items">
          <li v-for="item in order.items" :key="item.uid" class="order-card__item">
            <span class="item-part">{{ item.wclItemNo || item.partNo }}</span>
            <span class="item-meta">
              {{ item.dateCode || "—" }} · {{ formatCompactQtyUpper(item.qty) }}
            </span>
          </li>
        </ul>
      </div>

      <div class="footer">
        <button class="btn btn--ghost" @click="cancelTask">{{ $t("actions.cancel") }}</button>
        <button
          class="btn"
          :disabled="!canFinish || submitting"
          @click="confirmFinishOpen = true"
        >
          {{ submitting ? $t("actions.confirming") : $t("manualReceiving.finish") }}
        </button>
      </div>
    </template>

    <!-- Scan view -->
    <template v-else>
      <p class="scan-banner">{{ $t("manualReceiving.scannedTo", { orderNo: scanOrder?.orderNo }) }}</p>

      <EmptyState v-if="!scanOrder || scanOrder.items.length === 0" :message="$t('manualReceiving.noScannedItems')" />

      <ul v-else class="scan-items">
        <li v-for="item in scanOrder.items" :key="item.uid" class="scan-item">
          <div class="scan-item__main">
            <span class="item-part">{{ item.wclItemNo || item.partNo }}</span>
            <span class="item-meta">
              {{ item.dateCode || "—" }} · {{ formatCompactQtyUpper(item.qty) }}
            </span>
          </div>
          <span class="scan-item__actions">
            <button class="btn btn--ghost btn--small" @click="openEditItem(item, false)">
              {{ $t("manualReceiving.edit") }}
            </button>
            <button class="btn btn--danger btn--small" @click="deleteItem(item)">
              {{ $t("manualReceiving.delete") }}
            </button>
          </span>
        </li>
      </ul>

      <ScanFab :loading="scanning" @click="onCameraScan" />

      <div class="footer">
        <button class="btn btn--ghost" @click="cancelScan">{{ $t("actions.cancel") }}</button>
        <button class="btn" :disabled="!scanOrder || scanOrder.items.length === 0" @click="finishScan">
          {{ $t("manualReceiving.finishScan") }}
        </button>
      </div>
    </template>

    <!-- Edit order no dialog -->
    <div v-if="editOrderOpen" class="modal-backdrop" @click.self="editOrderOpen = false">
      <div class="modal">
        <h3 class="modal__title">{{ $t("manualReceiving.editOrderNo") }}</h3>
        <input v-model="editOrderValue" class="modal__input" type="text" @keydown.enter.prevent="saveEditOrder" />
        <div class="modal__actions">
          <button class="btn btn--ghost" @click="editOrderOpen = false">{{ $t("actions.cancel") }}</button>
          <button class="btn" :disabled="!editOrderValue.trim()" @click="saveEditOrder">
            {{ $t("manualReceiving.confirm") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Edit / review item dialog -->
    <div v-if="editItemOpen && editItemDraft" class="modal-backdrop" @click.self="editItemOpen = false">
      <div class="modal">
        <h3 class="modal__title">{{ $t("manualReceiving.editItem") }}</h3>
        <label class="modal__field">
          <span>{{ $t("manualReceiving.fields.partNo") }}</span>
          <input v-model="editItemDraft.partNo" class="modal__input" type="text" />
        </label>
        <label class="modal__field">
          <span>{{ $t("manualReceiving.fields.wclItemNo") }}</span>
          <input v-model="editItemDraft.wclItemNo" class="modal__input" type="text" />
        </label>
        <label class="modal__field">
          <span>{{ $t("manualReceiving.fields.qty") }}</span>
          <input v-model.number="editItemDraft.qty" class="modal__input" type="number" inputmode="numeric" min="1" step="1" />
        </label>
        <label class="modal__field">
          <span>{{ $t("manualReceiving.fields.dateCode") }}</span>
          <input v-model="editItemDraft.dateCode" class="modal__input" type="text" />
        </label>
        <label class="modal__field">
          <span>{{ $t("manualReceiving.fields.lotCode") }}</span>
          <input v-model="editItemDraft.lotCode" class="modal__input" type="text" />
        </label>
        <label class="modal__field">
          <span>{{ $t("manualReceiving.fields.coo") }}</span>
          <input v-model="editItemDraft.coo" class="modal__input" type="text" />
        </label>
        <label class="modal__field">
          <span>{{ $t("manualReceiving.fields.cow") }}</span>
          <input v-model="editItemDraft.cow" class="modal__input" type="text" />
        </label>
        <div class="modal__actions">
          <button class="btn btn--ghost" @click="editItemOpen = false">{{ $t("actions.cancel") }}</button>
          <button class="btn" @click="saveEditItem">{{ $t("manualReceiving.confirm") }}</button>
        </div>
      </div>
    </div>

    <!-- Discard confirm -->
    <div v-if="confirmDiscardOpen" class="modal-backdrop" @click.self="confirmDiscardOpen = false">
      <div class="modal">
        <p>{{ $t("manualReceiving.confirmDiscard") }}</p>
        <div class="modal__actions">
          <button class="btn btn--ghost" @click="confirmDiscardOpen = false">{{ $t("actions.cancel") }}</button>
          <button class="btn btn--danger" @click="navigateTo('/')">{{ $t("manualReceiving.confirm") }}</button>
        </div>
      </div>
    </div>

    <!-- Finish confirm -->
    <div v-if="confirmFinishOpen" class="modal-backdrop" @click.self="confirmFinishOpen = false">
      <div class="modal">
        <p>{{ $t("manualReceiving.confirmFinish") }}</p>
        <div class="modal__actions">
          <button class="btn btn--ghost" @click="confirmFinishOpen = false">{{ $t("actions.cancel") }}</button>
          <button class="btn" :disabled="submitting" @click="submit">
            {{ submitting ? $t("actions.confirming") : $t("manualReceiving.confirm") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.manual-receiving {
  padding-bottom: 4.5rem;
}
.add-order__label {
  display: block;
  font-size: 0.85rem;
  color: var(--muted);
  margin-bottom: 0.25rem;
}
.add-order__row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.add-order__input {
  flex: 1;
  min-width: 0;
  padding: 0.625rem 0.875rem;
  font-size: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--surface);
}
.order-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  padding: 0.75rem;
  margin-bottom: 0.75rem;
}
.order-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.order-card__no {
  font-weight: 700;
}
.order-card__progress {
  color: var(--muted);
  font-weight: 400;
  font-size: 0.85rem;
}
.order-card__actions {
  display: flex;
  gap: 0.375rem;
}
.order-card__items {
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0.5rem 0 0;
  border-top: 1px solid var(--border);
  display: grid;
  gap: 0.25rem;
}
.order-card__item {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.875rem;
}
.item-part {
  font-weight: 600;
  word-break: break-all;
}
.item-meta {
  color: var(--muted);
  white-space: nowrap;
}
.scan-banner {
  font-weight: 600;
  margin: 0 0 0.75rem;
}
.scan-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}
.scan-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  padding: 0.625rem 0.75rem;
}
.scan-item__main {
  display: grid;
  gap: 0.125rem;
  min-width: 0;
}
.scan-item__actions {
  display: flex;
  gap: 0.375rem;
  flex-shrink: 0;
}
.footer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: var(--surface);
  border-top: 1px solid var(--border);
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
.modal {
  background: var(--surface);
  border-radius: 1rem;
  padding: 1rem;
  width: 100%;
  max-width: 22rem;
  display: grid;
  gap: 0.75rem;
}
.modal__title {
  margin: 0;
  font-size: 1rem;
}
.modal__field {
  display: grid;
  gap: 0.25rem;
  font-size: 0.85rem;
  color: var(--muted);
}
.modal__input {
  padding: 0.5rem 0.75rem;
  font-size: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  width: 100%;
  box-sizing: border-box;
}
.modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
