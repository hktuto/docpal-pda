<template>
  <div>
    <p v-if="pending" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: error }) }}</p>

    <template v-else-if="detail">
      <div class="card" style="margin-bottom: 1rem;">
        <DetailRow :label="$t('putBack.detail.source')" :value="$t(`putBack.source.${detail.cancelSource}`)" />
        <DetailRow :label="$t('putBack.detail.orderNo')" :value="detail.orderNo" />
      </div>

      <!-- Shelf scan overrides the target for dock-sourced items without a
           source shelf (same hardware-scanner match as the put-away page). -->
      <div class="card" style="margin-bottom: 1rem;">
        <DetailRow :label="$t('putBack.detail.fallbackShelf')">
          <span :class="fallbackShelf ? 'shelf-set' : 'shelf-missing'">
            {{ fallbackShelf || $t('putBack.detail.scanHint') }}
          </span>
        </DetailRow>
      </div>

      <h2 class="section-title">{{ $t('putBack.detail.items') }}</h2>
      <p v-if="detail.items.length === 0" class="empty">{{ $t('putBack.detail.noItems') }}</p>
      <div v-for="item in detail.items" :key="item.id" class="card item-card">
        <DetailRow :label="$t('putBack.detail.part')">
          <span>{{ item.wclItemNo ?? item.partNo }}</span>
        </DetailRow>
        <DetailRow :label="$t('putBack.detail.qty')" :value="String(item.qty)" />
        <DetailRow v-if="item.dateCode || item.lotCode" :label="$t('putBack.detail.batch')"
                   :value="[item.dateCode, item.lotCode, item.coo, item.cow].filter(Boolean).join(' · ')" />
        <DetailRow :label="$t('putBack.detail.shelf')">
          <span>{{ item.doneShelfCode ?? item.shelfCode ?? $t('putBack.detail.pendingShelf') }}</span>
        </DetailRow>
      </div>

      <div v-if="detail.status === 'pending'" class="card" style="margin-top: 1.5rem;">
        <button class="btn btn-primary" :disabled="completing" @click="complete">
          {{ completing ? $t('putBack.detail.completing') : $t('putBack.detail.complete') }}
        </button>
      </div>
    </template>

    <p v-else class="empty">{{ $t('putBack.detail.notFound') }}</p>
  </div>
</template>

<script setup lang="ts">
import { useErrorMessage } from "~/composables/errorMessage";
import { useToast } from "~/composables/useToast";
import { useWarehouse } from "~/composables/useWarehouse";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { badgeClass } from "~/composables/useStatusBadge";
import type { PutBackTaskDetail } from "~/services/types";

definePageMeta({ title: "meta.putBackDetail" });

const { t } = useI18n();
useHead({ title: t('putBack.detail.title') });

const route = useRoute();
const taskId = route.params.id as string;

const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const { showToast } = useToast();

const pending = ref(true);
const error = ref<string | null>(null);
const detail = ref<PutBackTaskDetail | null>(null);
const completing = ref(false);
const fallbackShelf = ref<string | null>(null);
const shelves = ref<{ code: string }[]>([]);

usePageHeader({
  title: () => (detail.value ? detail.value.orderNo : undefined),
  badgeText: () => (detail.value ? t(`putBack.status.${detail.value.status}`) : undefined),
  badgeClass: () => badgeClass(detail.value?.status),
});

async function load() {
  try {
    detail.value = await warehouse.getPutBackTaskDetail(taskId);
    error.value = null;
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

// Shelf-code scans set the fallback target; anything else is ignored.
useHardwareScanner({
  enabled: () => detail.value?.status === "pending",
  onScan: async (raw) => {
    const value = raw.trim().toUpperCase();
    if (shelves.value.length === 0) shelves.value = await warehouse.getShelves();
    const hit = shelves.value.find((s) => s.code.toUpperCase() === value);
    if (hit) {
      fallbackShelf.value = hit.code;
      return true;
    }
    return false;
  },
});

async function complete() {
  completing.value = true;
  error.value = null;
  try {
    const res = await warehouse.completePutBackTask(taskId, fallbackShelf.value);
    showToast(t("putBack.detail.done", { items: res.itemsCredited, qty: res.totalQty }));
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    completing.value = false;
  }
}

useVisibleReload(load);
</script>

<style scoped>
.section-title {
  margin: 0 0 1rem;
  font-size: 1rem;
}

.item-card {
  margin-bottom: 0.75rem;
}

.shelf-set {
  color: var(--success, #16a34a);
  font-weight: 600;
}

.shelf-missing {
  color: var(--muted);
}

.btn-primary {
  width: 100%;
  padding: 0.75rem;
  font-size: 1rem;
  font-weight: 600;
}
</style>
