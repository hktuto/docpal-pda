<script setup lang="ts">
// Manual-allocation dialog for ONE internal transfer item line (spec
// 2026-11-10-internal-transfer-admin-allocate-design.md): lists the part's
// allocatable stock at the order's tn-converted source partition and pins
// manual allocations. Confirm submits every filled qty row in one batch
// (all-or-nothing). The picking modal (PartAvailabilityModal) is not reused —
// its final-state allocate-form / group / steal modes are picking-specific.
import type { InternalTransferItemRow, PartAvailabilityReceivingRow, PartAvailabilityStockRow } from "~/utils/flowApi";

const props = defineProps<{
  open: boolean;
  orderId: string;
  orderNo: string;
  item: InternalTransferItemRow | null;
}>();

const emit = defineEmits<{ close: []; allocated: [] }>();

const flow = useFlowApi();
const { t } = useI18n();
const dismiss = useOverlayDismiss(() => emit("close"));

const loading = ref(false);
const saving = ref(false);
const error = ref("");
const stock = ref<PartAvailabilityStockRow[]>([]);
const receiving = ref<PartAvailabilityReceivingRow[]>([]);
const dockAllowed = ref(true);
const qtyByKey = ref<Record<string, string>>({});
// The tn-converted source partition the server resolved for this item —
// shown in the header so the admin sees which partition was really searched.
const resolvedCtx = ref<{ orgId: number | null; subInventoryCode: string | null } | null>(null);

// stage 1: pickedQty is always 0 (packages arrive with the PDA stage)
const remaining = computed(() => Math.max(0, (props.item?.qty ?? 0) - (props.item?.allocatedQty ?? 0)));

function dockAvailable(r: PartAvailabilityReceivingRow): number {
  return Math.max(0, r.receivedQty - r.pickedQty - r.allocatedQty);
}

type DraftRow = {
  key: string;
  qty: number;
  available: number;
  inventoryLotId?: string;
  receivingInvoiceItemId?: string;
};

function parseDrafts(): { rows: DraftRow[]; total: number; overRow: boolean; overRemaining: boolean } {
  const rows: DraftRow[] = [];
  for (const r of stock.value) {
    const key = `l:${r.lotId}`;
    const raw = qtyByKey.value[key];
    if (raw === undefined || raw === "") continue;
    const qty = Number(raw);
    if (!Number.isInteger(qty) || qty <= 0) continue;
    rows.push({ key, qty, available: r.availableQty, inventoryLotId: r.lotId });
  }
  for (const r of receiving.value) {
    const key = `r:${r.receivingInvoiceItemId}`;
    const raw = qtyByKey.value[key];
    if (raw === undefined || raw === "") continue;
    const qty = Number(raw);
    if (!Number.isInteger(qty) || qty <= 0) continue;
    rows.push({ key, qty, available: dockAvailable(r), receivingInvoiceItemId: r.receivingInvoiceItemId });
  }
  const total = rows.reduce((s, r) => s + r.qty, 0);
  return {
    rows,
    total,
    overRow: rows.some((r) => r.qty > r.available),
    overRemaining: total > remaining.value,
  };
}

const draft = computed(() => parseDrafts());
const canSubmit = computed(
  () =>
    !loading.value &&
    !saving.value &&
    remaining.value > 0 &&
    draft.value.rows.length > 0 &&
    !draft.value.overRow &&
    !draft.value.overRemaining
);

async function load() {
  if (!props.item) return;
  loading.value = true;
  error.value = "";
  try {
    const res = await flow.getPartAvailability(props.item.partNo, props.item.wclItemNo, {
      transferItemIds: [props.item.id],
    });
    resolvedCtx.value = res.context;
    stock.value = res.stock.filter((r) => r.matched && r.availableQty > 0);
    receiving.value = res.receiving.filter((r) => r.matched);
    dockAllowed.value = res.dockStockAllowed;
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    loading.value = false;
  }
}

/** A breakdown remove changed the world (either engine's rows) — refresh the
 *  dialog's numbers AND tell the parent detail to reload. */
async function onAllocationsChanged() {
  await load();
  emit("allocated");
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      qtyByKey.value = {};
      error.value = "";
      load();
    }
  }
);

/** JSON 409 bodies (lock_held etc.) — same style as AllocationBreakdown. */
function describeError(e: any): string {
  try {
    const body = JSON.parse(e?.message ?? "");
    if (typeof body?.error === "string") return body.error;
  } catch {
    // not JSON — fall through
  }
  return e?.message ?? String(e);
}

async function submit() {
  if (!props.item || !canSubmit.value) return;
  const { rows, overRow, overRemaining } = parseDrafts();
  if (rows.length === 0) return;
  if (overRow || overRemaining) {
    error.value = t("internalTransfer.mOverRemaining", { qty: remaining.value });
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    await flow.addInternalTransferAllocationsBatch(
      props.orderId,
      props.item.id,
      rows.map((r) => ({
        qty: r.qty,
        inventoryLotId: r.inventoryLotId,
        receivingInvoiceItemId: r.receivingInvoiceItemId,
      }))
    );
    emit("allocated");
    emit("close");
  } catch (e: any) {
    error.value = describeError(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="overlay" @mousedown="dismiss.onMousedown" @click="dismiss.onClick">
    <div class="dialog transfer-alloc-dialog">
      <button type="button" class="dialog-close" @click="emit('close')" aria-label="Close">&times;</button>
      <h2>{{ $t("internalTransfer.mTitle", { partNo: item?.partNo ?? "" }) }}</h2>

      <div class="dialog-body">
        <div v-if="error" class="error-banner">{{ error }}</div>
        <div v-if="loading" class="muted">{{ $t("admin.common.loading") }}</div>
        <template v-else>
          <p class="hint">
            {{ $t("internalTransfer.mRemaining", { qty: remaining }) }}
            <span v-if="resolvedCtx"> · {{ $t("internalTransfer.mAt", { org: resolvedCtx.orgId ?? "—", sub: resolvedCtx.subInventoryCode ?? "—" }) }}</span>
            <span v-if="draft.total > 0"> · {{ draft.total }} / {{ remaining }}</span>
          </p>
          <p v-if="draft.overRemaining" class="error-banner">{{ $t("internalTransfer.mOverRemaining", { qty: remaining }) }}</p>

          <h3>{{ $t("internalTransfer.mStock") }}</h3>
          <table class="data">
            <thead>
              <tr>
                <th>{{ $t("internalTransfer.mShelf") }}</th>
                <th>{{ $t("internalTransfer.mBox") }}</th>
                <th>{{ $t("internalTransfer.mDateCode") }}</th>
                <th class="num">{{ $t("stockSearch.allocatedQty") }}</th>
                <th class="num">{{ $t("internalTransfer.mAvailable") }}</th>
                <th class="num">{{ $t("internalTransfer.colQty") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in stock" :key="r.lotId">
                <td>{{ r.shelfDisplayName ?? r.shelfCode ?? "—" }}</td>
                <td>{{ r.boxId ?? "—" }}</td>
                <td>{{ r.dateCode ?? "—" }}</td>
                <td class="num">
                  <AllocationBreakdown
                    :part-no="r.partNo"
                    :wcl-item-no="r.wclItemNo"
                    :allocated-qty="r.allocatedQty"
                    :lot-id="r.lotId"
                    @changed="onAllocationsChanged"
                  />
                </td>
                <td class="num">{{ r.availableQty }}</td>
                <td class="num">
                  <input
                    v-model="qtyByKey[`l:${r.lotId}`]"
                    class="qty-input"
                    type="number"
                    min="1"
                    :max="Math.min(r.availableQty, remaining)"
                    :disabled="remaining <= 0 || saving"
                  />
                </td>
              </tr>
              <tr v-if="stock.length === 0">
                <td colspan="6" class="muted">{{ $t("internalTransfer.mNone") }}</td>
              </tr>
            </tbody>
          </table>

          <template v-if="dockAllowed">
            <h3>{{ $t("internalTransfer.mDock") }}</h3>
            <table class="data">
              <thead>
                <tr>
                  <th>{{ $t("internalTransfer.mBatch") }}</th>
                  <th>{{ $t("internalTransfer.mBox") }}</th>
                  <th>{{ $t("internalTransfer.mDateCode") }}</th>
                  <th class="num">{{ $t("stockSearch.allocatedQty") }}</th>
                  <th class="num">{{ $t("internalTransfer.mAvailable") }}</th>
                  <th class="num">{{ $t("internalTransfer.colQty") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in receiving" :key="r.receivingInvoiceItemId">
                  <td>{{ r.batchNo }} · {{ r.invoiceNo }}</td>
                  <td>{{ r.ctnNo ?? "—" }}</td>
                  <td>{{ r.dateCode ?? "—" }}</td>
                  <td class="num">
                    <AllocationBreakdown
                      :part-no="item?.partNo ?? ''"
                      :wcl-item-no="item?.wclItemNo ?? null"
                      :allocated-qty="r.allocatedQty"
                      :receiving-invoice-item-id="r.receivingInvoiceItemId"
                      @changed="onAllocationsChanged"
                    />
                  </td>
                  <td class="num">{{ dockAvailable(r) }}</td>
                  <td class="num">
                    <input
                      v-model="qtyByKey[`r:${r.receivingInvoiceItemId}`]"
                      class="qty-input"
                      type="number"
                      min="1"
                      :max="Math.min(dockAvailable(r), remaining)"
                      :disabled="remaining <= 0 || saving"
                    />
                  </td>
                </tr>
                <tr v-if="receiving.length === 0">
                  <td colspan="6" class="muted">{{ $t("internalTransfer.mNone") }}</td>
                </tr>
              </tbody>
            </table>
          </template>
        </template>
      </div>

      <div v-if="!loading" class="dialog-actions">
        <button class="btn" :disabled="saving" @click="emit('close')">{{ $t("admin.common.cancel") }}</button>
        <button class="btn btn-primary" :disabled="!canSubmit" @click="submit">
          {{ saving ? $t("admin.common.saving") : $t("internalTransfer.mSubmit") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.transfer-alloc-dialog {
  width: 56.25rem;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dialog-body {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.hint {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #fff;
  margin: 0 0 0.5rem;
  padding: 0.25rem 0;
}
.qty-input {
  width: 7ch;
  font: inherit;
  text-align: right;
}
</style>
