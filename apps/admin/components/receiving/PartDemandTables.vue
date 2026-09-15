<script setup lang="ts">
import type { PartDemandRow } from "~/utils/flowApi";

// Open picking demand for a part, split into two tables: rows matching the
// context partition (the allocation rule — same org + sub-inventory) first,
// then every other open demand row. Read-only by default; with `allocatable`
// an extra action column renders through the #allocate slot.
const props = withDefaults(
  defineProps<{
    rows: PartDemandRow[];
    contextOrgId?: number | null;
    contextSubInventory?: string | null;
    allocatable?: boolean;
    /** Qty allocated this session per pickingItemId (reflected in the allocated/remaining columns). */
    sessionUsed?: Record<string, number>;
  }>(),
  { contextOrgId: null, contextSubInventory: null, allocatable: false, sessionUsed: () => ({}) }
);

defineSlots<{
  allocate?(props: { row: PartDemandRow; left: number }): unknown;
}>();

function matches(d: PartDemandRow): boolean {
  // Without a context partition nothing "matches the rule" — all rows fall
  // into the all-demand table instead of matching on null === null.
  if (props.contextOrgId == null && props.contextSubInventory == null) return false;
  return d.orgId === props.contextOrgId && d.subInventoryCode === props.contextSubInventory;
}
const matching = computed(() => props.rows.filter(matches));
const others = computed(() => props.rows.filter((d) => !matches(d)));

function used(d: PartDemandRow): number {
  return props.sessionUsed[d.pickingItemId] ?? 0;
}
function left(d: PartDemandRow): number {
  return Math.max(0, d.remainingQty - used(d));
}
</script>

<template>
  <div v-if="rows.length === 0" class="muted">{{ $t("admin.pages.receiving.demandNone") }}</div>
  <template v-else>
    <template v-for="group in [matching, others]" :key="group === matching ? 'matching' : 'all'">
      <h3 class="avail-section">
        {{ $t(group === matching ? "admin.pages.receiving.demandMatching" : "admin.pages.receiving.demandAll") }}
      </h3>
      <table v-if="group.length > 0" class="avail-table">
        <thead>
          <tr>
            <th>{{ $t("admin.pages.pickingOrders.orderNo") }}</th>
            <th>{{ $t("admin.pages.pickingOrders.status") }}</th>
            <th>{{ $t("admin.pages.receiving.deliveryDate") }}</th>
            <th>{{ $t("admin.pages.receiving.orgSubInventory") }}</th>
            <th class="num">{{ $t("admin.pages.pickingOrders.required") }}</th>
            <th class="num">{{ $t("admin.pages.pickingOrders.picked") }}</th>
            <th class="num">{{ $t("admin.pages.pickingOrders.allocated") }}</th>
            <th class="num">{{ $t("admin.pages.receiving.remaining") }}</th>
            <th v-if="allocatable" class="num">{{ $t("admin.pages.receiving.allocate") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in group" :key="d.pickingItemId">
            <td>{{ d.orderNo }}</td>
            <td>{{ $t(`status.picking.${d.orderStatus}`) }}</td>
            <td>{{ d.deliveryDate ? new Date(d.deliveryDate).toLocaleDateString() : "—" }}</td>
            <td>{{ d.orgId ?? "—" }} / {{ d.subInventoryCode ?? "—" }}</td>
            <td class="num">{{ d.qty }}</td>
            <td class="num">{{ d.pickedQty }}</td>
            <td class="num">{{ d.allocatedQty + used(d) }}</td>
            <td class="num">{{ left(d) }}</td>
            <td v-if="allocatable" class="num">
              <slot name="allocate" :row="d" :left="left(d)" />
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="muted">{{ $t("admin.pages.receiving.demandGroupEmpty") }}</div>
    </template>
  </template>
</template>
