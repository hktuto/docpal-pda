<template>
  <div class="section-title boxes-header">
    <h2 class="boxes-title">{{ $t('picking.boxesSection.title', { count: boxes?.length ?? 0 }) }}</h2>
    <div class="boxes-actions">
      <button
        v-if="actionable"
        class="btn btn--small"
        :disabled="creatingBox"
        @click="$emit('create-box')"
      >
        <template v-if="creatingBox">
          <InlineSpinner /> {{ $t('actions.creating') }}
        </template>
        <template v-else>
          {{ $t('picking.boxesSection.newBox') }}
        </template>
      </button>
      <button
        v-if="actionable"
        class="btn btn--small"
        :disabled="scanningBox"
        @click="$emit('scan-box')"
      >
        {{ $t('picking.boxesSection.scanBox') }}
      </button>
      <button
        class="btn btn--small btn--ghost"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? $t('actions.hide') : $t('actions.show') }}
      </button>
    </div>
  </div>

  <div v-if="expanded" class="boxes-list">
    <p v-if="!boxes?.length" class="empty">{{ $t('common.noBoxes') }}</p>

    <div
      v-for="box in boxes"
      :key="box.id"
      class="card box-card"
      :class="{ 'card--done': box.status !== 'open' }"
    >
      <DetailRow :label="$t('picking.boxesSection.boxId')">
        <span class="card__title">{{ box.id }}</span>
      </DetailRow>
      <DetailRow :label="$t('picking.boxesSection.status')">
        <span class="badge" :class="badgeClass(box.status)">{{ statusLabel.box(box.status) }}</span>
      </DetailRow>
      <DetailRow :label="$t('picking.boxesSection.packages')" :value="box.packageCount" />
      <p v-if="mixedCoos(box.id).length > 1" class="box-coo-warning" role="alert">
        ⚠️ {{ $t('picking.boxesSection.mixedCoo', { coos: mixedCoos(box.id).join(' / ') }) }}
      </p>
      <div v-if="contentsOf(box.id).length" class="box-contents">
        <button
          type="button"
          class="btn btn--small btn--ghost box-contents__toggle"
          :aria-expanded="contentsExpanded.has(box.id)"
          @click="toggleContents(box.id)"
        >
          {{ contentsExpanded.has(box.id) ? $t('actions.hide') : $t('actions.show') }}
          {{ $t('picking.boxesSection.contents') }} ({{ contentsOf(box.id).length }})
        </button>
        <div v-if="contentsExpanded.has(box.id)" class="box-contents__list">
          <div v-for="entry in contentsOf(box.id)" :key="entry.packageId" class="box-contents__row">
            <span class="box-contents__info">
              <span class="box-contents__part">{{ entry.partLabel }}</span>
              {{ entry.qty }} {{ $t('common.pcs') }} ·
              {{ $t('picking.itemsSection.dateLotCooCow') }}:
              {{ entry.dateCode || $t('common.noData') }} / {{ entry.lotCode || $t('common.noData') }} /
              {{ entry.coo || $t('common.noData') }} / {{ entry.cow || $t('common.noData') }}
            </span>
            <button
              v-if="box.status === 'open' && actionable"
              class="btn btn--small btn--secondary"
              :disabled="removing[entry.packageId]"
              @click="emit('remove-from-box', entry.packageId)"
            >
              <template v-if="removing[entry.packageId]">
                <InlineSpinner /> {{ $t('picking.boxesSection.movingOut') }}
              </template>
              <template v-else>
                {{ $t('picking.boxesSection.moveOut') }}
              </template>
            </button>
          </div>
        </div>
      </div>
      <div v-if="box.status === 'open'" class="box-actions">
        <button
          class="btn btn--small"
          :disabled="anyAddingAll || addingAll[box.id] || unboxedCount === 0"
          @click="emit('add-all-to-box', box.id)"
        >
          <template v-if="addingAll[box.id]">
            <InlineSpinner /> {{ $t('picking.boxesSection.addAll') }}
          </template>
          <template v-else>
            {{ $t('picking.boxesSection.addAll') }}
          </template>
        </button>
        <button
          class="btn btn--small"
          :class="{ 'btn--ghost': scanIntoBoxId !== box.id }"
          :disabled="scanningIntoBox"
          @click="emit('toggle-scan-into-box', box.id)"
        >
          <template v-if="scanningIntoBox && scanIntoBoxId === box.id">
            <InlineSpinner />
          </template>
          {{ scanIntoBoxId === box.id ? $t('picking.boxesSection.scanIntoBoxStop') : $t('picking.boxesSection.scanIntoBox') }}
        </button>
        <button
          v-if="box.packageCount === 0"
          class="btn btn--small btn--danger"
          :disabled="cancellingBox[box.id]"
          @click="$emit('cancel-box', box.id)"
        >
          {{ cancellingBox[box.id] ? $t('actions.canceling') : $t('picking.boxesSection.cancelBox') }}
        </button>
      </div>
      <p v-if="box.status === 'open' && scanIntoBoxId === box.id" class="scan-into-hint">
        {{ $t('picking.boxesSection.scanIntoBoxHint') }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PickingOrderDetail } from "~/services/types";
import { badgeClass } from "~/composables/useStatusBadge";

/** One row of a box's contents list (derived from the order's packages). */
export interface BoxContentEntry {
  packageId: string;
  partLabel: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
}

const statusLabel = useStatusLabel();

const props = defineProps<{
  boxes: PickingOrderDetail["boxes"];
  /** The boxes' contents, keyed by shipping box id. */
  boxContents: Record<string, BoxContentEntry[]>;
  actionable: boolean;
  creatingBox: boolean;
  scanningBox: boolean;
  cancellingBox: Record<string, boolean>;
  addingAll: Record<string, boolean>;
  anyAddingAll: boolean;
  unboxedCount: number;
  expanded: boolean;
  removing: Record<string, boolean>;
  /** The box armed for cross-order "scan item into box", if any. */
  scanIntoBoxId: string | null;
  scanningIntoBox: boolean;
}>();

const emit = defineEmits<{
  "create-box": [];
  "scan-box": [];
  "cancel-box": [boxId: string];
  "add-all-to-box": [boxId: string];
  "toggle-scan-into-box": [boxId: string];
  "remove-from-box": [packageId: string];
  "update:expanded": [value: boolean];
}>();

const expanded = computed({
  get: () => props.expanded,
  set: (value) => emit("update:expanded", value),
});

function contentsOf(boxId: string): BoxContentEntry[] {
  return props.boxContents[boxId] ?? [];
}

/** Distinct non-null COOs in the box — a mixed list (>1) flags the warning. */
function mixedCoos(boxId: string): string[] {
  return [...new Set(contentsOf(boxId).map((e) => e.coo).filter((c): c is string => !!c))];
}

// Per-box contents expander state.
const contentsExpanded = ref<Set<string>>(new Set());

function toggleContents(boxId: string) {
  const next = new Set(contentsExpanded.value);
  if (next.has(boxId)) next.delete(boxId);
  else next.add(boxId);
  contentsExpanded.value = next;
}

</script>

<style scoped>
.boxes-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.boxes-title {
  margin: 0;
}

.boxes-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.boxes-list {
  margin-bottom: 1.5rem;
}

.box-card {
  margin-bottom: 1rem;
}

.box-actions {
  margin-top: 1rem;
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.scan-into-hint {
  margin: 0.5rem 0 0;
  color: var(--muted);
  font-size: 0.8125rem;
}

.box-coo-warning {
  margin: 0.5rem 0 0;
  color: #92400e;
  font-size: 0.8125rem;
  font-weight: 600;
}

.box-contents {
  margin-top: 0.5rem;
}

.box-contents__toggle {
  font-weight: 400;
}

.box-contents__list {
  margin-top: 0.4rem;
  border-top: 1px dashed var(--muted-light, #e5e7eb);
}

.box-contents__row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  padding: 0.35rem 0;
  border-bottom: 1px dashed var(--muted-light, #e5e7eb);
  font-size: 0.8125rem;
}

.box-contents__part {
  font-weight: 600;
  margin-right: 0.25rem;
}
</style>
