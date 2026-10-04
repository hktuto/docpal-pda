<template>
  <h2 class="section-title">
    {{ $t('picking.itemsSection.title') }}
    <button
      type="button"
      class="btn btn--small merge-toggle"
      :class="{ 'merge-toggle--active': mergeByPart }"
      :aria-pressed="mergeByPart"
      @click="mergeByPart = !mergeByPart"
    >
      {{ $t('picking.itemsSection.mergePartNo') }}
    </button>
  </h2>
  <div class="list-panel">
    <div
      v-for="group in displayGroups"
      :key="group.key"
      :data-item-id="group.items[0].id"
      class="list-row list-row--expandable"
      :class="{ 'list-row--done': group.pickedQty >= group.qty }"
    >
      <button type="button" class="list-row__main list-row__toggle" @click="toggle(group.key)">
        <div class="list-row__line1">
          <span class="list-row__title">{{ group.title || $t('common.noData') }}</span>
          <span
            class="badge"
            :class="badgeClass(group.pickedQty >= group.qty ? 'finished' : 'picking')"
          >
            {{ group.pickedQty >= group.qty ? statusLabel.picking('finished') : statusLabel.picking('picking') }}
          </span>
        </div>
        <div class="list-row__meta">
          {{ groupMeta(group) }}
        </div>
      </button>
      <!-- <div class="list-row__aside">
        <span class="list-row__qty">{{ item.pickedQty }}/{{ item.qty }}</span>
      </div> -->
      <svg
        class="list-row__chevron"
        :class="{ 'list-row__chevron--open': expandedItems.has(group.key) }"
        viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      ><path d="m9 18 6-6-6-6"/></svg>

      <div v-if="expandedItems.has(group.key)" class="list-row__detail">
        <template v-if="group.items.length > 1">
          <div v-for="item in group.items" :key="item.id" class="merged-line">
            {{ $t('picking.itemsSection.line') }} {{ item.lineNumber ?? '—' }}
            ({{ $t('picking.itemsSection.shipment') }} {{ item.shipmentNumber ?? '—' }})
            · {{ $t('picking.itemsSection.requiredQty') }}: {{ item.qty }}
            · {{ $t('picking.itemsSection.scannedQty') }}: {{ scannedQty(item) }}
          </div>
        </template>
        <DetailRow
          v-else
          :label="$t('picking.itemsSection.line')"
          :value="`${group.items[0].lineNumber ?? '—'} (${$t('picking.itemsSection.shipment')} ${group.items[0].shipmentNumber ?? '—'})`"
        />

        <div v-if="group.unboxed.length && actionable" class="unboxed-packages">
          <h3 class="subsection-title">{{ $t('picking.itemsSection.unboxedPackages') }}</h3>
          <div
            v-for="pkg in group.unboxed"
            :key="pkg.id"
            class="lot package-row"
          >
            <span class="package-info">
              {{ pkg.qty }} {{ $t('common.pcs') }} · {{ formatLotFields(pkg) }}
              <span v-if="pkg.labelBarcode" class="package-label"> · {{ $t('picking.itemsSection.label') }}: {{ pkg.labelBarcode }}</span>
            </span>
            <div class="package-actions">
              <select :value="boxSelections[pkg.id]" :disabled="adding[pkg.id]" class="box-select" @change="updateBoxSelection(pkg.id, ($event.target as HTMLSelectElement).value)">
                <option value="">{{ $t('picking.itemsSection.selectBox') }}</option>
                <option v-for="box in openBoxes" :key="box.id" :value="box.id">{{ box.id }}</option>
              </select>
              <button
                class="btn btn--small"
                :disabled="adding[pkg.id] || !boxSelections[pkg.id]"
                @click="emit('add-to-box', pkg.id)"
              >
                <template v-if="adding[pkg.id]">
                  <InlineSpinner /> {{ $t('picking.itemsSection.adding') }}
                </template>
                <template v-else>
                  {{ $t('picking.itemsSection.addToBox') }}
                </template>
              </button>
            </div>
          </div>
        </div>

        <div v-if="group.boxed.length && actionable" class="boxed-packages">
          <h3 class="boxed-title">{{ $t('picking.itemsSection.boxedPackages') }}</h3>
          <div
            v-for="pkg in group.boxed"
            :key="pkg.id"
            class="lot package-row"
          >
            <span class="package-info">
              {{ pkg.qty }} {{ $t('common.pcs') }} · {{ formatLotFields(pkg) }} · {{ pkg.shippingBoxId }}
              <span v-if="pkg.labelBarcode" class="package-label"> · {{ $t('picking.itemsSection.label') }}: {{ pkg.labelBarcode }}</span>
            </span>
            <button
              v-if="openBoxById[pkg.shippingBoxId!]?.status === 'open'"
              class="btn btn--small"
              :disabled="removing[pkg.id]"
              @click="emit('remove-from-box', pkg.id)"
            >
              <template v-if="removing[pkg.id]">
                <InlineSpinner /> {{ $t('picking.itemsSection.removing') }}
              </template>
              <template v-else>
                {{ $t('picking.itemsSection.remove') }}
              </template>
            </button>
          </div>
        </div>

        <details v-if="group.allocations.length && actionable && group.pickedQty < group.qty" class="planned">
          <summary class="subsection-title planned__summary">{{ $t('picking.itemsSection.planned') }}</summary>
          <div
            v-for="allocation in group.allocations"
            :key="allocation.key"
            class="lot"
          >
            <template v-if="allocation.lot">
              <DetailRow v-if="showAllocLocation" :label="$t('picking.itemsSection.location')">
                <span v-if="allocation.lot.shelfCode && allocation.lot.boxId">
                  {{ allocation.lot.shelfCode }} / {{ allocation.lot.boxId }}
                </span>
                <span v-else-if="allocation.lot.shelfCode">{{ allocation.lot.shelfCode }}</span>
                <span v-else-if="allocation.lot.boxId">{{ allocation.lot.boxId }}</span>
                <span v-else>{{ $t('picking.itemsSection.receivingArea') }}</span>
                <span
                  v-if="allocation.lot.shelfWarning"
                  class="shelf-warning"
                  :title="allocation.lot.shelfWarning"
                  role="img"
                  :aria-label="allocation.lot.shelfWarning"
                >⚠️</span>
              </DetailRow>
              <DetailRow v-if="allocBatchLabel(allocation.lot)" :label="$t('picking.itemsSection.dateLotCooCow')">
                {{ allocBatchLabel(allocation.lot) }}
              </DetailRow>
              <DetailRow v-if="showAllocQty" :label="$t('picking.itemsSection.allocatedQty')" :value="allocation.qty" />
            </template>

            <template v-else>
              <DetailRow v-if="showAllocSource" :label="$t('picking.itemsSection.source')">
                {{ $t('picking.itemsSection.receivingArea') }}
                <span v-if="allocation.boxId">
                  ({{ allocation.boxId }})
                </span>
              </DetailRow>
              <DetailRow v-if="showAllocQty" :label="$t('picking.itemsSection.allocatedQty')" :value="allocation.qty" />
            </template>
          </div>
        </details>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PickingOrderDetail } from "~/services/types";
import { badgeClass } from "~/composables/useStatusBadge";
import { normalizePartNo } from "~/utils/text";
import { PICKING_GROUP_FIELDS, IDENTITY_DETAIL_FIELDS } from "~/utils/viewConfig";

type PickingItem = PickingOrderDetail["items"][number];

type ShippingBox = PickingOrderDetail["boxes"][number];

const props = defineProps<{
  items: PickingOrderDetail["items"];
  actionable: boolean;
  boxSelections: Record<string, string>;
  adding: Record<string, boolean>;
  removing: Record<string, boolean>;
  openBoxes: PickingOrderDetail["boxes"];
}>();

const emit = defineEmits<{
  "update:boxSelections": [value: Record<string, string>];
  "add-to-box": [packageId: string];
  "remove-from-box": [packageId: string];
}>();

const { t } = useI18n();
const statusLabel = useStatusLabel();
const { viewConfig } = useViewConfig();

// Collapsed meta line + expanded allocation rows are driven by
// pdaViewConfig.pickingDetail (spec 2026-10-04): itemFields pick the
// group-level collapsed fields, expandedFields gate the per-allocation rows.
const detailConfig = computed(() => viewConfig.value.pickingDetail);

function groupMeta(group: ItemGroup): string {
  const parts: string[] = [];
  for (const field of detailConfig.value.itemFields) {
    if (IDENTITY_DETAIL_FIELDS.has(field) || !PICKING_GROUP_FIELDS.has(field)) continue;
    if (field === "qty") parts.push(`${t("picking.itemsSection.requiredQty")}: ${group.qty}`);
    else if (field === "picked_qty") parts.push(`${t("picking.itemsSection.scannedQty")}: ${group.scannedQty}`);
    else if (field === "allocated_qty") {
      parts.push(`${t("picking.itemsSection.allocatedQty")}: ${group.allocations.reduce((s, a) => s + a.qty, 0)}`);
    }
  }
  return parts.join(" · ");
}

const showAllocLocation = computed(() => {
  const f = detailConfig.value.expandedFields;
  return f.includes("shelf_code") || f.includes("box_id");
});
const showAllocQty = computed(() => detailConfig.value.expandedFields.includes("allocated_qty"));
const showAllocSource = computed(() => detailConfig.value.expandedFields.includes("source"));

// The date/lot/COO/COW batch row shows only the batch fields present in
// expandedFields (all four by default); hidden when none are configured.
function allocBatchLabel(lot: { dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null }): string {
  const fields = detailConfig.value.expandedFields;
  const parts: string[] = [];
  if (fields.includes("date_code")) parts.push(lot.dateCode || t("common.noData"));
  if (fields.includes("lot_code")) parts.push(lot.lotCode || t("common.noData"));
  if (fields.includes("coo")) parts.push(lot.coo || t("common.noData"));
  if (fields.includes("cow")) parts.push(lot.cow || t("common.noData"));
  return parts.join(" / ");
}

// Merge view (default): one row per part no, aggregating the quantities of
// all order lines carrying that part (expanded detail still lists every
// line). Toggleable per session — no persistence.
const mergeByPart = ref(true);

type PickingAllocation = NonNullable<PickingItem["allocations"]>[number];
type PickingPackage = NonNullable<PickingItem["packages"]>[number];

/** Display form of an allocation row: identical for a single line and for a
 *  merged part group — merged rows carry the summed qty of every allocation
 *  fed by the same source (same stock lot, or the same receiving
 *  invoice item / receiving-order pool / carton). */
interface MergedAllocation {
  key: string;
  lot: PickingAllocation["lot"];
  boxId: string | null;
  qty: number;
}

function mergeAllocations(allocations: PickingAllocation[]): MergedAllocation[] {
  const groups = new Map<string, MergedAllocation>();
  for (const a of allocations) {
    if (a.qty <= 0) continue;
    const key = a.lot
      ? `lot:${a.lot.id}`
      : `src:${a.receivingInvoiceItemId ?? ""}:${a.receivingOrderId ?? ""}:${a.boxId ?? ""}`;
    const g = groups.get(key);
    if (g) {
      g.qty += a.qty;
    } else {
      groups.set(key, { key, lot: a.lot ?? null, boxId: a.boxId ?? null, qty: a.qty });
    }
  }
  return [...groups.values()];
}

interface ItemGroup {
  key: string;
  title: string;
  items: PickingItem[];
  qty: number;
  pickedQty: number;
  scannedQty: number;
  allocations: MergedAllocation[];
  unboxed: PickingPackage[];
  boxed: PickingPackage[];
}

function toGroup(key: string, items: PickingItem[]): ItemGroup {
  const packages = items.flatMap((i) => i.packages ?? []);
  return {
    key,
    title: (items[0].wclItemNo ?? items[0].partNo) || "",
    items,
    qty: items.reduce((sum, i) => sum + i.qty, 0),
    pickedQty: items.reduce((sum, i) => sum + i.pickedQty, 0),
    scannedQty: items.reduce((sum, i) => sum + scannedQty(i), 0),
    allocations: mergeAllocations(items.flatMap((i) => i.allocations ?? [])),
    unboxed: packages.filter((p) => !p.shippingBoxId),
    boxed: packages.filter((p) => p.shippingBoxId),
  };
}

const displayGroups = computed<ItemGroup[]>(() => {
  if (!mergeByPart.value) {
    return props.items.map((item) => toGroup(item.id, [item]));
  }
  const groups = new Map<string, PickingItem[]>();
  for (const item of props.items) {
    const key = normalizePartNo(item.partNo);
    const g = groups.get(key);
    if (g) g.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([key, items]) => toGroup(key, items));
});

const expandedItems = ref<Set<string>>(new Set());

function toggle(itemId: string) {
  const next = new Set(expandedItems.value);
  if (next.has(itemId)) {
    next.delete(itemId);
  } else {
    next.add(itemId);
  }
  expandedItems.value = next;
}

const openBoxById = computed(() => {
  const map: Record<string, ShippingBox> = {};
  for (const box of props.openBoxes) {
    map[box.id] = box;
  }
  return map;
});

function scannedQty(item: PickingItem) {
  return (item.packages ?? []).reduce((sum, p) => sum + p.qty, 0);
}

function updateBoxSelection(packageId: string, value: string) {
  emit("update:boxSelections", { ...props.boxSelections, [packageId]: value });
}

function formatLotFields(source: { dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null }): string {
  return `${source.dateCode || t('common.noData')} / ${source.lotCode || t('common.noData')} / ${source.coo || t('common.noData')} / ${source.cow || t('common.noData')}`;
}

</script>

<style scoped>
.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.merge-toggle {
  font-weight: 400;
  background: transparent;
  color: var(--primary);
  border-color: var(--primary);
}

.merge-toggle:hover:not(:disabled) {
  background: var(--primary-soft);
  box-shadow: none;
}

.merge-toggle--active {
  background: var(--primary);
  color: #fff;
}

.merge-toggle--active:hover:not(:disabled) {
  background: var(--primary-hover);
}

.merged-line {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--muted);
  padding: 0.35rem 0;
  border-bottom: 1px dashed var(--muted-light, #e5e7eb);
  margin-bottom: 0.35rem;
}

.allocations,
.unboxed-packages,
.boxed-packages,
.planned {
  margin-top: 0.75rem;
}

.planned__summary {
  cursor: pointer;
}

.package-label {
  color: var(--muted);
  word-break: break-all;
}

.package-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
}

.package-info {
  font-size: 0.875rem;
}

.shelf-warning {
  margin-left: 0.25rem;
  cursor: help;
}

.package-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}


.boxed-title {
  margin: 0 0 0.5rem;
  font-size: 0.875rem;
  color: var(--muted);
}

.box-select {
  min-width: 8rem;
}
</style>
