<template>
  <div class="list-panel">
    <div
      v-for="group in displayGroups"
      :key="group.key"
      :data-item-id="group.items[0].id"
      class="list-row list-row--expandable"
      :class="{ 'list-row--done': group.scannedQty >= group.qty }"
    >
      <button type="button" class="list-row__main list-row__toggle" @click="emit('toggle', group.key)">
        <div class="list-row__line1">
          <span class="list-row__title">{{ group.title || $t('common.noData') }}</span>
        </div>
        <div class="list-row__meta">{{ collapsedMeta(group) }}</div>
      </button>
      <svg
        class="list-row__chevron"
        :class="{ 'list-row__chevron--open': expandedItems.has(group.key) }"
        viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      ><path d="m9 18 6-6-6-6"/></svg>

      <div v-if="expandedItems.has(group.key)" class="list-row__detail">
        <!-- Pending (unconfirmed) scans of this part -->
        <div v-if="pendingOf(group).length" class="pending-scans">
          <h3 class="subsection-title">{{ $t('picking.unified.pendingTitle') }}</h3>
          <div
            v-for="row in pendingOf(group)"
            :key="row.key"
            class="lot pending-row"
            :class="{ 'pending-row--failed': row.status === 'failed' }"
          >
            <span class="package-info">
              {{ formatCompactQtyUpper(row.qty) }} · {{ row.lotCode || $t('common.stateNone') }} / {{ row.dateCode || $t('common.stateNone') }}
              · {{ row.source === 'mixed' ? 'QR/OCR' : row.source === 'ocr' ? 'OCR' : 'QR' }}
              <span v-if="row.status === 'failed'" class="pending-error">{{ row.error }}</span>
            </span>
            <button
              type="button"
              class="btn btn--small btn--secondary"
              :disabled="row.status !== 'queued'"
              @click="emit('remove-queue', row.keys)"
            >
              {{ $t('picking.scanSession.removeRow') }}
            </button>
          </div>
        </div>

        <template v-if="group.items.length > 1">
          <div v-for="item in group.items" :key="item.id" class="merged-line">
            {{ $t('picking.itemsSection.line') }} {{ item.lineNumber ?? '—' }}
            ({{ $t('picking.itemsSection.shipment') }} {{ item.shipmentNumber ?? '—' }})
            · {{ $t('picking.itemsSection.requiredQty') }}: {{ item.qty }}
            · {{ $t('picking.itemsSection.scannedQty') }}: {{ scannedQty(item) }}
          </div>
        </template>

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
                type="button"
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
              type="button"
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

        <details v-if="group.allocations.length && actionable && group.scannedQty < group.qty" class="planned">
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
              <DetailRow v-if="showAllocBatch && allocBatchLabel(allocation.lot)" :label="$t('picking.itemsSection.dateLotCooCow')">
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
import type { ScanQueueRow } from "~/composables/usePickingScanQueue";
import type { PdaDetailCollapsedStyle } from "~/utils/viewConfig";
import { normalizePartNo } from "~/utils/text";
import {
  pendingScanGroups,
  unifiedCollapsedMeta,
  type PendingGroup,
  type UnifiedAllocation,
} from "~/utils/pickingUnifiedItems";

type PickingItem = PickingOrderDetail["items"][number];
type ShippingBox = PickingOrderDetail["boxes"][number];

const props = defineProps<{
  items: PickingOrderDetail["items"];
  /** Live queue rows (pending + failed) from usePickingScanSession. */
  queueRows: ScanQueueRow[];
  actionable: boolean;
  boxSelections: Record<string, string>;
  adding: Record<string, boolean>;
  removing: Record<string, boolean>;
  openBoxes: PickingOrderDetail["boxes"];
  collapsedStyle: PdaDetailCollapsedStyle;
}>();

const emit = defineEmits<{
  "toggle": [groupKey: string];
  "remove-queue": [keys: string[]];
  "add-to-box": [packageId: string];
  "remove-from-box": [packageId: string];
  "update:boxSelections": [value: Record<string, string>];
}>();

const { t } = useI18n();
const { viewConfig } = useViewConfig();

// Collapsed meta + expanded allocation rows are driven by
// pdaViewConfig.pickingDetail (spec 2026-10-04; collapsedStyle knob spec
// 2026-10-12): itemFields pick the group-level collapsed fields in "fields"
// mode, expandedFields gate the per-allocation rows.
const detailConfig = computed(() => viewConfig.value.pickingDetail);

const showAllocLocation = computed(() => {
  const f = detailConfig.value.expandedFields;
  return f.includes("shelf_code") || f.includes("box_id");
});
const showAllocQty = computed(() => detailConfig.value.expandedFields.includes("allocated_qty"));
const showAllocSource = computed(() => detailConfig.value.expandedFields.includes("source"));

/** Display form of an allocation row: identical for a single line and for a
 *  merged part group — merged rows carry the summed qty of every allocation
 *  fed by the same source (same stock lot, or the same receiving
 *  invoice item / receiving-order pool / carton). */
interface MergedAllocation {
  key: string;
  lot: PickingItem['allocations'][number]['lot'];
  boxId: string | null;
  qty: number;
}

function mergeAllocations(allocations: PickingItem["allocations"]): MergedAllocation[] {
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
  scannedQty: number;
  allocations: MergedAllocation[];
  unboxed: PickingItem["packages"];
  boxed: PickingItem["packages"];
  queuedQty: number;
}

function toGroup(key: string, items: PickingItem[], queuedByItem: Record<string, number>): ItemGroup {
  const packages = items.flatMap((i) => i.packages ?? []);
  return {
    key,
    title: (items[0].wclItemNo ?? items[0].partNo) || "",
    items,
    qty: items.reduce((sum, i) => sum + i.qty, 0),
    scannedQty: items.reduce((sum, i) => sum + scannedQty(i), 0),
    allocations: mergeAllocations(items.flatMap((i) => i.allocations ?? [])),
    unboxed: packages.filter((p) => !p.shippingBoxId),
    boxed: packages.filter((p) => p.shippingBoxId),
    queuedQty: items.reduce((sum, i) => sum + (queuedByItem[i.id] ?? 0), 0),
  };
}

// One row per part no, aggregating the quantities of all order lines
// carrying that part (expanded detail still lists every line).
const displayGroups = computed<ItemGroup[]>(() => {
  const groups = new Map<string, PickingItem[]>();
  for (const item of props.items) {
    const key = normalizePartNo(item.partNo);
    const g = groups.get(key);
    if (g) g.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([key, items]) =>
    toGroup(key, items, queuedQtyByItem.value)
  );
});

// Queued (not yet confirmed) qty per picking item id.
const queuedQtyByItem = computed(() => {
  const map: Record<string, number> = {};
  for (const r of props.queueRows) {
    if (r.status !== "queued") continue;
    map[r.itemId] = (map[r.itemId] ?? 0) + r.qty;
  }
  return map;
});

const expandedItems = ref(new Set<string>());

function toggle(groupKey: string) {
  const next = new Set(expandedItems.value);
  if (next.has(groupKey)) {
    next.delete(groupKey);
  } else {
    next.add(groupKey);
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

// ------------------------------------------------------------------
// Collapsed line 2 + expanded pending scans — pure logic lives in
// utils/pickingUnifiedItems.ts (unit-tested); this component renders it.
// ------------------------------------------------------------------

function collapsedMeta(group: ItemGroup): string {
  return unifiedCollapsedMeta(
    {
      scannedQty: group.scannedQty,
      qty: group.qty,
      queuedQty: group.queuedQty,
      actionable: props.actionable,
      collapsedStyle: props.collapsedStyle,
      itemFields: detailConfig.value.itemFields,
      allocations: group.allocations,
    },
    t
  );
}

/** Pending/failed queue rows of one part group, aggregated per batch. */
function pendingOf(group: ItemGroup): PendingGroup[] {
  return pendingScanGroups(group.items, props.queueRows);
}

const showAllocBatch = computed(() => {
  const f = detailConfig.value.expandedFields;
  return f.includes("date_code") || f.includes("lot_code") || f.includes("coo") || f.includes("cow");
});

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

function formatLotFields(source: { dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null }): string {
  return `${source.dateCode || t('common.noData')} / ${source.lotCode || t('common.noData')} / ${source.coo || t('common.noData')} / ${source.cow || t('common.noData')}`;
}
</script>

<style scoped>
.list-row__meta {
  font-size: 0.8rem;
  color: var(--muted);
  line-height: 1.5;
  word-break: break-word;
  text-overflow: initial;
  white-space: break-spaces;
}

.subsection-title {
  margin: 0.75rem 0 0.35rem;
  font-size: 0.875rem;
  color: var(--muted);
}

.pending-scans .pending-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  padding: 0.35rem 0;
  border-bottom: 1px dashed var(--muted-light, #e5e7eb);
}

.pending-row--failed {
  color: #b91c1c;
}

.pending-error {
  font-size: 0.75rem;
  margin-right: 0.5rem;
}

.merged-line {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--muted);
  padding: 0.35rem 0;
  border-bottom: 1px dashed var(--muted-light, #e5e7eb);
  margin-bottom: 0.35rem;
}

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
