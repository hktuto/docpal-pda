<script setup lang="ts">
import type { PartDemandRow } from "~/utils/flowApi";

// Open picking demand for a part, showing only the rows matching the context
// partition (the allocation rule — same org + sub-inventory); allocating into
// other org/sub-inventory partitions from this dialog is not allowed.
// Read-only by default; with `allocatable` an extra action column renders
// through the #allocate slot.
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
  // Without a context partition nothing "matches the rule" — matching on
  // null === null would wrongly accept rows with no partition.
  if (props.contextOrgId == null && props.contextSubInventory == null) return false;
  return d.orgId === props.contextOrgId && d.subInventoryCode === props.contextSubInventory;
}
const matching = computed(() => props.rows.filter(matches));

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
    <h3 class="avail-section">{{ $t("admin.pages.receiving.demandMatching") }}</h3>
    <table v-if="matching.length > 0" class="avail-table">
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
        <tr v-for="d in matching" :key="d.pickingItemId">
          <td>{{ d.orderNo }}</td>
          <td>{{ $t(`status.picking.${d.orderStatus}`) }}</td>
          <td>{{ d.deliveryDate ? formatDate(d.deliveryDate) : "—" }}</td>
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
