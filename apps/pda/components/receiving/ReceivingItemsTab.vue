<template>
  <h2 class="section-title">{{ $t('receiving.itemsTab.title') }}</h2>

  <div class="group-by">
    <span class="group-by__label">{{ $t('receiving.itemsTab.groupBy') }}</span>
    <button
      v-for="opt in groupByOptions"
      :key="opt.value"
      class="filter-chip"
      :class="{ 'filter-chip--active': groupBy === opt.value }"
      @click="groupBy = opt.value"
    >
      {{ $t(opt.labelKey) }}
    </button>
  </div>

  <div v-for="group in groups" :key="group.key" class="group">
    <button type="button" class="group__header" @click="toggleGroup(group.key)">
      <svg
        class="group__chevron"
        :class="{ 'group__chevron--open': !collapsedGroups.has(group.key) }"
        viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      ><path d="m9 18 6-6-6-6"/></svg>
      <span class="group__label">{{ groupLabel(group) }}</span>
      <span class="group__progress">{{ groupProgress(group) }}</span>
    </button>

    <div v-if="!collapsedGroups.has(group.key)" class="list-panel">
      <template v-for="sub in group.subGroups" :key="sub.key">
        <div v-if="sub.label" class="list-group-header">
          {{ sub.label }}
          <span class="list-group-header__count">({{ sub.items.length }})</span>
        </div>

        <ReceivingItemRow
          v-for="item in sub.items"
          :key="item.id"
          :item="item"
          :order-status="order.status"
          :saving="saving"
          @report-issue="emit('report-issue', $event)"
          @confirm-mismatch="emit('confirm-mismatch', $event)"
          @cancel-mismatch="emit('cancel-mismatch', $event)"
        />
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { DisplayReceivingItem, DisplayReceivingOrder } from "./types";
import {
  groupReceivingItems,
  type ReceivingGroupBy,
  type ReceivingItemGroup,
} from "~/utils/receivingGrouping";

// Receiving detail items with the group-by chip row (spec 2026-10-04):
// Invoice (today's default, carton sub-groups inside) / Carton / Part no.
// The chip choice is session-local; the admin default arrives with the
// pdaViewConfig work in Phase 4.
const props = defineProps<{
  order: DisplayReceivingOrder;
  saving: Record<string, boolean>;
}>();

const emit = defineEmits<{
  "report-issue": [item: DisplayReceivingItem];
  "confirm-mismatch": [itemId: string];
  "cancel-mismatch": [itemId: string];
}>();

const { t } = useI18n();

const groupByOptions: { labelKey: string; value: ReceivingGroupBy }[] = [
  { labelKey: "receiving.itemsTab.groupByInvoice", value: "invoice" },
  { labelKey: "receiving.itemsTab.groupByCarton", value: "carton" },
  { labelKey: "receiving.itemsTab.groupByPartNo", value: "part-no" },
];

const groupBy = ref<ReceivingGroupBy>("invoice");
const collapsedGroups = ref<Set<string>>(new Set());

const groups = computed(() =>
  groupReceivingItems(props.order.invoices, groupBy.value, {
    noCarton: t("receiving.itemsTab.noCarton"),
  })
);

function toggleGroup(key: string) {
  const next = new Set(collapsedGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedGroups.value = next;
}

function groupLabel(group: ReceivingItemGroup): string {
  if (groupBy.value === "invoice") return t("common.invoiceTitle", { no: group.label });
  return group.label;
}

// Invoice/carton groups count received items; part-no groups show the merged
// qty progress across lines/invoices (spec: "INV-1234 — 8/12 received").
function groupProgress(group: ReceivingItemGroup): string {
  if (groupBy.value === "part-no") {
    return `${group.receivedQty}/${group.expectedQty ?? "—"} ${t("common.pcs")}`;
  }
  return t("receiving.itemsTab.groupProgress", {
    received: group.receivedCount,
    total: group.totalCount,
  });
}
</script>

<style scoped>
.group-by {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  overflow-x: auto;
  padding-bottom: 0.25rem;
}

.group-by__label {
  flex-shrink: 0;
  font-size: 0.8125rem;
  color: var(--muted);
}

.group {
  margin-bottom: 1.5rem;
}

.group__header {
  position: sticky;
  top: var(--header-h);
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: calc(100% + 2rem);
  padding: 0.35rem 1rem;
  margin-inline: -1rem;
  background: var(--bg);
  border: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
  color: var(--muted);
}

.group__chevron {
  flex-shrink: 0;
  transition: transform 0.15s ease;
}

.group__chevron--open {
  transform: rotate(90deg);
}

.group__label {
  font-weight: 700;
  color: var(--muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group__progress {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 0.8125rem;
  color: var(--muted);
}
</style>
