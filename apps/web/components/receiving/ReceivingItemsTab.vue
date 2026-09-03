<template>
  <h2 class="section-title">{{ $t('receiving.itemsTab.title') }}</h2>
  <div v-for="invoice in order.invoices" :key="invoice.id" style="margin-bottom: 1.5rem;">
      <div class="sticky_header">

        <h3 style="margin-bottom: 0.5rem; color: var(--muted);">
        {{ $t('common.invoiceTitle', { no: invoice.invoiceNo }) }}
        </h3>
      </div>

    <div class="list-panel">
      <template v-for="group in groupsFor(invoice)" :key="group.key">
        <div v-if="group.label" class="list-group-header">
          {{ group.label }}
          <span class="list-group-header__count">({{ group.items.length }})</span>
        </div>

        <div
          v-for="item in group.items"
          :key="item.id"
          class="list-row list-row--expandable"
          :class="{ 'list-row--danger': item.mismatch }"
        >
          <button type="button" class="list-row__main list-row__toggle" @click="toggle(item.id)">
            <div class="list-row__line1">
              <span class="list-row__title">{{ item.wclItemNo ?? item.partNo }}</span>
            </div>
            <div class="list-row__meta">
              {{ $t('receiving.itemsTab.expected') }}: {{ item.lineQty ?? '—' }}
              · {{ item.poNo ?? '—' }}/{{ item.poLine ?? '—' }}
            </div>
          </button>
          <div class="list-row__aside">
            <span v-if="item.pickedQty > 0 || item.putAwayQty > 0" class="mismatch-locked">
              {{ $t('common.locked') }}
            </span>
          </div>
          <svg
            class="list-row__chevron"
            :class="{ 'list-row__chevron--open': expandedItems.has(item.id) }"
            viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
          ><path d="m9 18 6-6-6-6"/></svg>

          <div v-if="expandedItems.has(item.id)" class="list-row__detail">
            <DetailRow :label="$t('receiving.itemsTab.expected')" :value="item.lineQty ?? '—'" />
            <DetailRow :label="$t('receiving.itemsTab.boxId')" :value="item.ctnNo" />
            <DetailRow :label="$t('receiving.itemsTab.poLine')" :value="`${item.poNo} / ${item.poLine}`" />
            <DetailRow :label="$t('receiving.itemsTab.reserved')" :value="item.allocatedQty" />
            <DetailRow :label="$t('receiving.itemsTab.picked')" :value="item.pickedQty" />
            <DetailRow :label="$t('receiving.itemsTab.putAway')" :value="item.putAwayQty" />
            <DetailRow
                :label="$t('receiving.itemsTab.available')"
                :value="item.receivedQty - item.pickedQty - item.putAwayQty - item.allocatedQty"
            />
            <DetailRow
              :label="$t('receiving.itemsTab.dateLotCooCow')"
              :value="`${item.dateCode} / ${item.lotCode} / ${item.coo} / ${item.cow}`"
            />

            <div v-if="order.status !== 'clear'" style="margin-top: 0.75rem;">
              <template v-if="item.pickedQty > 0 || item.putAwayQty > 0">
                <p class="mismatch-locked">{{ $t('common.locked') }}</p>
              </template>

              <template v-else-if="item.mismatch">
                <div class="mismatch-summary">
                  <span class="mismatch-badge">{{ formatMismatchSummary(item) }}</span>
                  <span v-if="item.mismatch.note" class="mismatch-note">{{ item.mismatch.note }}</span>

                  <button class="btn btn--small" :disabled="saving[item.id]" @click="emit('report-issue', item)">
                    <template v-if="saving[item.id]">
                      <InlineSpinner /> {{ $t('actions.saving') }}
                    </template>
                    <template v-else>
                      {{ $t('receiving.itemsTab.editIssue') }}
                    </template>
                  </button>
                  <button
                    class="btn btn--small"
                    :disabled="saving[item.id]"
                    @click="emit('confirm-mismatch', item.id)"
                  >
                    <template v-if="saving[item.id]">
                      <InlineSpinner /> {{ $t('actions.saving') }}
                    </template>
                    <template v-else>
                      {{ $t('receiving.itemsTab.confirmMismatch') }}
                    </template>
                  </button>
                  <button
                    class="btn btn--small btn--danger"
                    :disabled="saving[item.id]"
                    @click="emit('cancel-mismatch', item.id)"
                  >
                    <template v-if="saving[item.id]">
                      <InlineSpinner /> {{ $t('actions.saving') }}
                    </template>
                    <template v-else>
                      {{ $t('receiving.itemsTab.cancelMismatch') }}
                    </template>
                  </button>
                </div>
              </template>

              <template v-else>
                <button class="btn btn--small btn--danger" :disabled="saving[item.id]" @click="emit('report-issue', item)">
                  <template v-if="saving[item.id]">
                    <InlineSpinner /> {{ $t('actions.saving') }}
                  </template>
                  <template v-else>
                    {{ $t('receiving.itemsTab.reportIssue') }}
                  </template>
                </button>
              </template>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { DisplayReceivingItem, DisplayReceivingOrder } from "./types";

const { t } = useI18n();

defineProps<{
  order: DisplayReceivingOrder;
  saving: Record<string, boolean>;
}>();

const emit = defineEmits<{
  "report-issue": [item: DisplayReceivingItem];
  "confirm-mismatch": [itemId: string];
  "cancel-mismatch": [itemId: string];
}>();

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

type Invoice = DisplayReceivingOrder["invoices"][number];

interface ItemGroup {
  key: string;
  /** Empty label = no group header (invoice has no carton numbers at all). */
  label: string;
  items: DisplayReceivingItem[];
}

// Group an invoice's items by carton number (ctnNo) when present; items
// without one fall into a trailing "no carton" group.
function groupsFor(invoice: Invoice): ItemGroup[] {
  const items = invoice.items;
  if (!items.some((i) => i.ctnNo)) {
    return [{ key: "__all__", label: "", items }];
  }
  const byCarton = new Map<string, DisplayReceivingItem[]>();
  const noCarton: DisplayReceivingItem[] = [];
  for (const item of items) {
    if (item.ctnNo) {
      const group = byCarton.get(item.ctnNo) ?? [];
      group.push(item);
      byCarton.set(item.ctnNo, group);
    } else {
      noCarton.push(item);
    }
  }
  const groups: ItemGroup[] = [...byCarton.entries()].map(([ctnNo, groupItems]) => ({
    key: ctnNo,
    label: ctnNo,
    items: groupItems,
  }));
  if (noCarton.length > 0) {
    groups.push({ key: "__none__", label: t("receiving.itemsTab.noCarton"), items: noCarton });
  }
  return groups;
}

function formatMismatchSummary(item: DisplayReceivingItem): string {
  const mismatch = item.mismatch;
  if (!mismatch?.reason) return "";
  switch (mismatch.reason) {
    case "not_found":
      return t("receiving.itemsTab.mismatch.not_found");
    case "damaged":
      return t("receiving.itemsTab.mismatch.damaged", { qty: mismatch.mismatchQty ?? 0 });
    case "quality_rejection":
      return t("receiving.itemsTab.mismatch.quality_rejection", { qty: mismatch.mismatchQty ?? 0 });
    case "qty_mismatch":
      return t("receiving.itemsTab.mismatch.qty_mismatch", { qty: mismatch.mismatchQty ?? 0 });
    case "over_shipment":
      return t("receiving.itemsTab.mismatch.over_shipment", { qty: mismatch.mismatchQty ?? 0 });
    case "wrong_part":
      return t("receiving.itemsTab.mismatch.wrong_part", { part: mismatch.wrongPartNo ?? "" });
    default:
      return t("receiving.itemsTab.mismatch.reported");
  }
}
</script>

<style scoped>
.sticky_header{
    position: -webkit-sticky; /* For Safari */
    position: sticky;
    top: var(--header-h);
    z-index: 2;
    background: var(--bg);
    margin-inline: calc(1rem * -1);
    padding-inline: 1rem;
    padding-block: 0.22rem;
}
.mismatch-badge {
  display: inline-block;
  padding: 0.25rem 0.625rem;
  font-size: 0.75rem;
  font-weight: 600;
  border-radius: 9999px;
  background: var(--danger-soft);
  color: var(--danger);
}

.mismatch-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.mismatch-note {
  font-size: 0.875rem;
  color: var(--muted);
  flex: 1;
}

.mismatch-locked {
  font-size: 0.75rem;
  color: var(--danger);
  margin: 0;
}
</style>
