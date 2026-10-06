<template>
  <div v-if="scans.length" class="pending-panel">
    <h2 class="section-title">{{ $t('putAway.pendingPanel.title', { count: totalQty }) }}</h2>
    <p class="pending-hint">{{ hintText }}</p>

    <div v-for="group in groups" :key="group.key" class="pending-group">
      <div class="pending-group__head">
        <span class="pending-group__part">{{ group.label }}</span>
        <span class="pending-group__qty">{{ group.qty }} {{ $t('common.pcs') }}</span>
      </div>
      <div v-for="scan in group.scans" :key="scan.id" class="scan-row">
        <div class="scan-info">
          <span>{{ scan.qty }} {{ $t('common.pcs') }}</span>
          <span class="scan-meta">
            {{ scan.dateCode || $t('common.stateNone') }} / {{ scan.lotCode || $t('common.stateNone') }} / {{ scan.coo || $t('common.stateNone') }} / {{ scan.cow || $t('common.stateNone') }}
          </span>
        </div>
        <div class="scan-actions">
          <button
            class="btn btn--small"
            :disabled="!shelfCode || addingScan[scan.id] || removingScan[scan.id]"
            @click="emit('add-to-shelf', scan.id)"
          >
            <template v-if="addingScan[scan.id]">
              <InlineSpinner /> {{ $t('putAway.pendingPanel.addingToShelf') }}
            </template>
            <template v-else>
              {{ $t('putAway.pendingPanel.addToShelf') }}
            </template>
          </button>
          <button
            class="btn btn--small btn--secondary"
            :disabled="addingScan[scan.id] || removingScan[scan.id]"
            @click="emit('remove-scan', scan.id)"
          >
            <template v-if="removingScan[scan.id]">
              <InlineSpinner /> {{ $t('putAway.lotsPanel.removingScan') }}
            </template>
            <template v-else>
              {{ $t('putAway.lotsPanel.removeScan') }}
            </template>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import InlineSpinner from "~/components/InlineSpinner.vue";
import { normalizePartNo } from "~/utils/text";
import type { PutAwayScan } from "~/services/types";

// Pending = scans not yet committed to a shelf (the shelf-direct flow's
// staging list, spec 2026-10-06). Rows commit all-at-once via the shelf-scan
// prompt or one-by-one via "Add to shelf" (only enabled with a shelf
// selected), and are hard-deleted on remove (mis-scan correction).
interface Props {
  scans: PutAwayScan[];
  /** Selected shelf (the banner's value); null = "Add to shelf" disabled. */
  shelfCode: string | null;
  addingScan: Record<string, boolean>;
  removingScan: Record<string, boolean>;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  "add-to-shelf": [scanId: string];
  "remove-scan": [scanId: string];
}>();

const { t } = useI18n();

const totalQty = computed(() => props.scans.reduce((sum, s) => sum + s.qty, 0));

const hintText = computed(() =>
  props.shelfCode
    ? t("putAway.shelfBanner", { shelf: props.shelfCode })
    : t("putAway.pendingPanel.hint")
);

const groups = computed(() => {
  const byKey = new Map<string, { key: string; label: string; qty: number; scans: PutAwayScan[] }>();
  for (const scan of props.scans) {
    const key = normalizePartNo(scan.partNo);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: scan.wclItemNo ?? scan.partNo, qty: 0, scans: [] };
      byKey.set(key, group);
    }
    group.qty += scan.qty;
    group.scans.push(scan);
  }
  return [...byKey.values()];
});
</script>

<style scoped>
.pending-panel {
  margin-top: 1.5rem;
}

.section-title {
  margin: 0 0 0.25rem;
  font-size: 1rem;
}

.pending-hint {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  color: var(--muted);
}

.pending-group {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.5rem;
}

.pending-group__head {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  font-weight: 600;
  font-size: 0.9rem;
  margin-bottom: 0.25rem;
}

.pending-group__qty {
  color: var(--muted);
  font-weight: 400;
}

.scan-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border);
}

.scan-row:last-child {
  border-bottom: none;
}

.scan-info {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  font-size: 0.875rem;
  align-items: center;
}

.scan-meta {
  color: var(--muted);
}

.scan-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}
</style>
