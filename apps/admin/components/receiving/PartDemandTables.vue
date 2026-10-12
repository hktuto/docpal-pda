<script setup lang="ts">
import type { PartDemandRow } from "~/utils/flowApi";

// Re-allocation form for one receiving item across the part's open picking
// demand (spec docs/superpowers/specs/2026-10-12-admin-receiving-reallocate-form-design.md).
//
// Each input is the DESIRED FINAL TOTAL this receiving item should hold on
// that picking item — not an increment. That is what makes the whole set
// coherent: rows that shrink are released before rows that grow are filled,
// so the pool balances itself and no other picking order is left short.
//
// Only the matching rows are listed (the allocation engine's location rule:
// the item's org plus the same sub-inventory or a share-group sibling), so a
// pin can never land in a partition the engine would fight. Fully-allocated
// rows ARE listed — with a final-state form they are exactly the rows you may
// want to raise.
//
// Inputs are never disabled: the admin is told what is wrong (a row over its
// own requirement, or the form oversubscribing the pool) instead of being
// stopped at the control. Rows whose order is open on a PDA are read-only and
// badged, because committing them would reject the entire batch.
const props = withDefaults(
  defineProps<{
    rows: PartDemandRow[];
    contextOrgId?: number | null;
    contextSubInventory?: string | null;
    /** This receiving item's pool size (receivedQty - pickedQty). */
    available: number;
    /** Desired totals per pickingItemId; rows absent from here keep their current value. */
    modelValue: Record<string, number>;
  }>(),
  { contextOrgId: null, contextSubInventory: null }
);

const emit = defineEmits<{
  "update:modelValue": [value: Record<string, number>];
}>();

function matches(d: PartDemandRow): boolean {
  // Without a context partition nothing "matches the rule" — every row would
  // otherwise report a match and cross-location allocation would look allowed.
  if (props.contextOrgId == null && props.contextSubInventory == null) return false;
  // `matched` is the allocation engine's own rule: same org, and the same
  // sub-inventory or a sibling in the same share group.
  return d.matched;
}
const matching = computed(() => props.rows.filter(matches));

/** What the row holds from this receiving item right now. */
function current(d: PartDemandRow): number {
  return props.modelValue[d.pickingItemId] === undefined
    ? d.fromItemQty
    : Number(props.modelValue[d.pickingItemId]);
}
function planned(d: PartDemandRow): number {
  const v = current(d);
  return Number.isInteger(v) && v >= 0 ? v : 0;
}
function setPlanned(d: PartDemandRow, value: number | string) {
  emit("update:modelValue", { ...props.modelValue, [d.pickingItemId]: Number(value) || 0 });
}

// A row may hold at most what it still needs; anything more would be an
// over-allocation the backend rejects outright.
function rowCap(d: PartDemandRow): number {
  return Math.max(0, d.qty - d.pickedQty);
}
function rowOver(d: PartDemandRow): boolean {
  return planned(d) > rowCap(d);
}

const plannedTotal = computed(() => matching.value.reduce((sum, d) => sum + planned(d), 0));
const poolOver = computed(() => plannedTotal.value > props.available);
// The engine tops any row you leave short back up from the leftovers, so a
// partial placement does NOT hold. Warn rather than silently let the admin
// believe they starved a row. (Submit gating lives in the dialog, which owns
// the Confirm button.)
const dirty = computed(() => matching.value.some((d) => !d.locked && planned(d) !== d.fromItemQty));
const poolUnderplaced = computed(
  () => !poolOver.value && plannedTotal.value < props.available && dirty.value
);
</script>

<template>
  <div v-if="rows.length === 0" class="muted">{{ $t("admin.pages.receiving.demandNone") }}</div>
  <template v-else>
    <h3 class="avail-section">{{ $t("admin.pages.receiving.demandMatching") }}</h3>
    <p class="hint-text">{{ $t("admin.pages.receiving.reallocHint") }}</p>
    <table v-if="matching.length > 0" class="avail-table">
      <thead>
        <tr>
          <th>{{ $t("admin.pages.pickingOrders.orderNo") }}</th>
          <th>{{ $t("admin.pages.pickingOrders.status") }}</th>
          <th>{{ $t("admin.pages.receiving.deliveryDate") }}</th>
          <th class="num">{{ $t("admin.pages.pickingOrders.required") }}</th>
          <th class="num">{{ $t("admin.pages.pickingOrders.picked") }}</th>
          <th class="num">{{ $t("admin.pages.pickingOrders.allocated") }}</th>
          <th class="num">{{ $t("admin.pages.receiving.fromThisItem") }}</th>
          <th class="num">{{ $t("admin.pages.receiving.reallocTarget") }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="d in matching" :key="d.pickingItemId" :class="{ 'avail-match': rowOver(d) || poolOver }">
          <td>
            {{ d.orderNo }}
            <span v-if="d.locked" class="lock-badge" :title="$t('admin.pages.receiving.reallocLockedBy', { name: d.workingByName ?? '—' })">
              🔒 {{ $t("admin.pages.receiving.reallocLockedShort") }}
            </span>
          </td>
          <td>{{ $t(`status.picking.${d.orderStatus}`) }}</td>
          <td>{{ d.deliveryDate ? formatDate(d.deliveryDate) : "—" }}</td>
          <td class="num">{{ d.qty }}</td>
          <td class="num">{{ d.pickedQty }}</td>
          <td class="num">{{ d.allocatedQty }}</td>
          <td class="num">{{ d.fromItemQty }}</td>
          <td class="num">
            <input
              :value="planned(d)"
              type="number"
              min="0"
              :max="rowCap(d)"
              class="avail-qty"
              :disabled="d.locked"
              @input="setPlanned(d, ($event.target as HTMLInputElement).value)"
            />
            <div v-if="rowOver(d)" class="warn-text">{{ $t("admin.pages.receiving.reallocRowOver") }}</div>
          </td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <th colspan="6"></th>
          <th class="num">{{ $t("admin.pages.receiving.reallocPlanned") }}</th>
          <th class="num">
            {{ plannedTotal }} / {{ available }}
            <div v-if="poolOver" class="warn-text">{{ $t("admin.pages.receiving.reallocPoolOver") }}</div>
            <div v-else-if="poolUnderplaced" class="hint-text">{{ $t("admin.pages.receiving.reallocPoolUnder") }}</div>
          </th>
        </tr>
      </tfoot>
    </table>
    <div v-else class="muted">{{ $t("admin.pages.receiving.demandGroupEmpty") }}</div>
  </template>
</template>

<style scoped>
.hint-text { font-size: .8125rem; color: #52606d; margin: .25rem 0 .5rem; }
.warn-text { font-size: .75rem; color: #b54708; }
.lock-badge { font-size: .6875rem; color: #b54708; white-space: nowrap; }
</style>