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
          :class="{ 'card--done': box.status !== 'open' }"
        >
          <DetailRow :label="$t('putAway.shelfBoxesPanel.box')">
            <span class="card__title">{{ box.id }}</span>
          </DetailRow>
          <DetailRow :label="$t('putAway.shelfBoxesPanel.status')">
            <span class="badge" :class="badgeClass(box.status)">{{ statusLabel.box(box.status) }}</span>
          </DetailRow>
          <DetailRow :label="$t('putAway.shelfBoxesPanel.items')">
            <span>{{ box.items?.length || 0 }} {{ box.items?.length === 1 ? $t('common.line') : $t('common.lines') }} · {{ boxTotalQty(box) }} {{ $t('common.pcs') }}</span>
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
                <span>{{ item.part?.partNo || $t('common.noData') }}</span>
                <span class="lot-qty">× {{ item.qty }}</span>
              </div>
            </div>
          </div>

          <div v-if="box.status === 'open'" class="box-actions">
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
import * as schema from "~/db/schema";
import { type ShelfBox } from "~/db/putAway";
import { badgeClass } from "~/composables/useStatusBadge";

type Shelf = typeof schema.shelves.$inferSelect;

interface Props {
  boxes: ShelfBox[];
  boxesExpanded: boolean;
  actionable: boolean;
  creating: boolean;
  closing: boolean;
  cancellingBox: Record<string, boolean>;
  expandedItemBoxes: Set<string>;
  shelves?: Shelf[];
}

const props = withDefaults(defineProps<Props>(), {
  shelves: () => [],
});

const emit = defineEmits<{
  "update:boxesExpanded": [value: boolean];
  "update:expandedItemBoxes": [value: Set<string>];
  "new-box": [];
  "close-box": [boxId: string];
  "cancel-box": [boxId: string];
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
  const map: Record<string, ShelfBox[]> = {};
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

function boxTotalQty(box: ShelfBox) {
  return (box.items || []).reduce((sum, item) => sum + (item.qty || 0), 0);
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

.lot-qty {
  color: var(--muted);
}

.box-actions {
  margin-top: 1rem;
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
