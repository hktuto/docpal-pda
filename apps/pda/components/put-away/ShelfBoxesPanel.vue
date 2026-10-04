<template>
  <div class="card shelf-boxes-panel">
    <div class="section-header">
      <h2 class="section-title">{{ $t('putAway.shelfBoxesPanel.title', { count: boxes.length }) }}</h2>
      <div class="section-actions">
        <button
          v-if="actionable"
          class="btn btn--small"
          :disabled="creating"
          @click="emit('new-box')"
        >
          {{ creating ? $t('putAway.shelfBoxesPanel.creating') : $t('putAway.shelfBoxesPanel.newBox') }}
        </button>
        <button
          v-if="actionable"
          class="btn btn--small"
          :disabled="creating"
          @click="emit('scan-box')"
        >
          {{ $t('putAway.shelfBoxesPanel.scanBox') }}
        </button>
        <button
          class="btn btn--small btn--ghost"
          :aria-expanded="isBoxesExpanded"
          @click="isBoxesExpanded = !isBoxesExpanded"
        >
          {{ isBoxesExpanded ? $t('actions.hide') : $t('actions.show') }}
        </button>
      </div>
    </div>

    <div v-if="isBoxesExpanded">
      <p v-if="boxes.length === 0" class="empty no-padding">{{ $t('common.noBoxes') }}</p>

      <div
        v-for="(group, shelfCode) in boxesByShelf"
        :key="shelfCode"
        class="shelf-group"
      >
        <h3 class="subsection-title">{{ shelfLabel(shelfCode) }}</h3>

        <div
          v-for="box in group"
          :key="box.id"
          class="card box-card"
          :class="{ 'card--done': box.status !== 'open', 'box-card--active': box.id === activeBoxId }"
        >
          <DetailRow :label="$t('putAway.shelfBoxesPanel.box')">
            <span class="card__title">{{ box.id }}</span>
          </DetailRow>
          <DetailRow :label="$t('putAway.shelfBoxesPanel.status')">

            <span class="badge" :class="badgeClass(box.status)">{{ statusLabel.box(box.status) }}</span>
            <span v-if="box.id === activeBoxId" class="badge badge--active">{{ $t('putAway.shelfBoxesPanel.active') }}</span>
          </DetailRow>
          <DetailRow :label="$t('putAway.shelfBoxesPanel.items')">
            <span>{{ box.items?.length || 0 }} {{ box.items?.length === 1 ? $t('common.line') : $t('common.lines') }} · {{ boxTotalQty(box.items ?? []) }} {{ $t('common.pcs') }}</span>
          </DetailRow>

          <div v-if="box.items?.length" class="box-contents">
            <div class="contents-header">
              <p class="contents-label">{{ $t('putAway.shelfBoxesPanel.contents') }}</p>
              <button
                class="btn btn--small btn--ghost"
                @click="toggleItemVisibility(box.id)"
              >
                {{ isExpandedItemBoxes.has(box.id) ? $t('putAway.shelfBoxesPanel.hideItems') : $t('putAway.shelfBoxesPanel.showItems') }}
              </button>
            </div>
            <div v-if="isExpandedItemBoxes.has(box.id)">
              <div
                v-for="item in box.items"
                :key="item.id"
                class="lot"
              >
                <span>{{ (item.wclItemNo ?? item.partNo) || $t('common.noData') }}</span>
                <span class="lot-qty">× {{ item.qty }}</span>
                <button
                  v-if="box.status === 'open'"
                  class="btn btn--small btn--secondary lot-remove"
                  :disabled="removingItem[item.id]"
                  @click="emit('remove-from-box', box.id, item.id)"
                >
                  <template v-if="removingItem[item.id]">
                    <InlineSpinner /> {{ $t('putAway.shelfBoxesPanel.removingFromBox') }}
                  </template>
                  <template v-else>
                    {{ $t('putAway.shelfBoxesPanel.removeFromBox') }}
                  </template>
                </button>
              </div>
            </div>
          </div>

          <div v-if="box.status === 'open'" class="box-actions">
            <button
              v-if="box.id !== activeBoxId"
              class="btn btn--small btn--secondary"
              @click="emit('set-active', box.id)"
            >
              {{ $t('putAway.shelfBoxesPanel.setActive') }}
            </button>
            <button
              class="btn btn--small"
              :disabled="anyAddingAll || addingAll[box.id] || unboxedCount === 0"
              @click="emit('add-all-to-box', box.id)"
            >
              <template v-if="addingAll[box.id]">
                <InlineSpinner /> {{ $t('putAway.shelfBoxesPanel.addAll') }}
              </template>
              <template v-else>
                {{ $t('putAway.shelfBoxesPanel.addAll') }}
              </template>
            </button>
            <button
              v-if="box.items?.length"
              class="btn"
              :disabled="closing"
              @click="emit('close-box', box.id)"
            >
              {{ closing ? $t('putAway.shelfBoxesPanel.closing') : $t('putAway.shelfBoxesPanel.closeBox') }}
            </button>
            <button
              v-else
              class="btn btn--small btn--danger"
              :disabled="cancellingBox[box.id]"
              @click="emit('cancel-box', box.id)"
            >
              {{ cancellingBox[box.id] ? $t('putAway.shelfBoxesPanel.canceling') : $t('putAway.shelfBoxesPanel.cancelBox') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { badgeClass } from "~/composables/useStatusBadge";
import { boxTotalQty } from "~/utils/box";
import InlineSpinner from "~/components/InlineSpinner.vue";
import type { PutAwayBox, Shelf } from "~/services/types";

interface Props {
  boxes: PutAwayBox[];
  boxesExpanded: boolean;
  actionable: boolean;
  creating: boolean;
  closing: boolean;
  cancellingBox: Record<string, boolean>;
  expandedItemBoxes: Set<string>;
  shelves?: Shelf[];
  addingAll: Record<string, boolean>;
  anyAddingAll: boolean;
  unboxedCount: number;
  removingItem: Record<string, boolean>;
  /** The box that currently receives auto-put scans (highlighted). */
  activeBoxId?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
  shelves: () => [],
  activeBoxId: null,
});

const emit = defineEmits<{
  "update:boxesExpanded": [value: boolean];
  "update:expandedItemBoxes": [value: Set<string>];
  "new-box": [];
  "scan-box": [];
  "set-active": [boxId: string];
  "close-box": [boxId: string];
  "cancel-box": [boxId: string];
  "add-all-to-box": [boxId: string];
  "remove-from-box": [boxId: string, scanId: string];
}>();

const { t } = useI18n();
const statusLabel = useStatusLabel();

const isBoxesExpanded = computed({
  get: () => props.boxesExpanded,
  set: (value) => emit("update:boxesExpanded", value),
});

const isExpandedItemBoxes = computed({
  get: () => props.expandedItemBoxes,
  set: (value) => emit("update:expandedItemBoxes", value),
});

const boxesByShelf = computed(() => {
  const map: Record<string, PutAwayBox[]> = {};
  for (const box of props.boxes) {
    const code = box.shelfCode ?? t('common.unassigned');
    if (!map[code]) map[code] = [];
    map[code].push(box);
  }
  return map;
});

function shelfLabel(code: string) {
  const shelf = props.shelves.find((s) => s.code === code);
  if (shelf?.zone) {
    return t('common.shelfFormat', { code: shelf.code, zone: shelf.zone });
  }
  return shelf?.code ?? code;
}

function toggleItemVisibility(boxId: string) {
  const next = new Set(isExpandedItemBoxes.value);
  if (next.has(boxId)) {
    next.delete(boxId);
  } else {
    next.add(boxId);
  }
  isExpandedItemBoxes.value = next;
}
</script>

<style scoped>
.shelf-boxes-panel {
  margin-bottom: 1.5rem;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 0 0 1rem;
}

.section-title {
  margin: 0;
}

.section-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.no-padding {
  padding: 0;
}

.shelf-group {
  margin-bottom: 1.5rem;
}

.box-card {
  margin-bottom: 0.75rem;
}

.box-card--active {
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--primary);
}

.badge--active {
  margin-left: 0.5rem;
  background: var(--primary);
  color: #fff;
}

.box-contents {
  margin-top: 0.5rem;
}

.contents-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.contents-label {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--muted);
}

.lot {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.lot-qty {
  color: var(--muted);
}

.lot-remove {
  margin-left: auto;
}

.box-actions {
  margin-top: 1rem;
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
