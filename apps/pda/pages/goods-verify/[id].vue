<template>
  <div>
    <p v-if="pending" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: error }) }}</p>

    <template v-else-if="detail">
      <h2 class="section-title">{{ $t('goodsVerify.detail.shelf') }}</h2>
      <div class="card" style="margin-bottom: 1.5rem;">
        <DetailRow :label="$t('goodsVerify.detail.shelf')" :value="detail.task.shelfCode" />
        <DetailRow :label="$t('goodsVerify.detail.taskDate')" :value="detail.task.taskDate" />
        <DetailRow :label="$t('goodsVerify.detail.movementsCount')" :value="String(detail.task.movementsCount)" />
      </div>

      <h2 class="section-title">{{ $t('goodsVerify.detail.movements') }}</h2>
      <p v-if="detail.task.movements.length === 0" class="empty">{{ $t('goodsVerify.detail.noMovements') }}</p>
      <div v-for="m in detail.task.movements" :key="m.partNo" class="card movement-card">
        <DetailRow :label="$t('goodsVerify.detail.part')">
          <span>{{ m.wclItemNo ?? m.partNo }}</span>
        </DetailRow>
        <DetailRow v-if="m.description" :label="$t('goodsVerify.detail.description')" :value="m.description" />
        <DetailRow :label="$t('goodsVerify.detail.change')">
          <span :class="m.qtyChange > 0 ? 'qty-positive' : 'qty-negative'">
            {{ m.qtyChange > 0 ? '+' : '' }}{{ m.qtyChange }}
          </span>
        </DetailRow>
        <DetailRow :label="$t('goodsVerify.detail.currentTotal')" :value="String(m.currentTotal)" />
      </div>

      <template v-if="detail.task.status === 'pending'">
        <div class="card" style="margin-top: 1.5rem;">
          <button class="btn btn-primary" :disabled="verifying" @click="verify">
            {{ verifying ? $t('goodsVerify.detail.verifying') : $t('goodsVerify.detail.confirm') }}
          </button>
        </div>
      </template>
    </template>

    <p v-else class="empty">{{ $t('goodsVerify.detail.notFound') }}</p>
  </div>
</template>

<script setup lang="ts">
import { useErrorMessage } from "~/composables/errorMessage";
import { useToast } from "~/composables/useToast";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useWarehouse } from "~/composables/useWarehouse";
import { badgeClass } from "~/composables/useStatusBadge";
import type { GoodsVerifyTaskDetail } from "~/services/types";

definePageMeta({ title: "meta.goodsVerifyDetail" });

const { t } = useI18n();
useHead({ title: t('goodsVerify.detail.title') });

const route = useRoute();
const taskId = route.params.id as string;

const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const { showToast } = useToast();

const pending = ref(true);
const error = ref<string | null>(null);
const detail = ref<GoodsVerifyTaskDetail | null>(null);
const verifying = ref(false);

// Title, status badge and header info rows render in the AppHeader.
usePageHeader({
  title: () =>
    detail.value ? detail.value.task.shelfCode : undefined,
  badgeText: () => (detail.value ? statusLabel.goodsVerify(detail.value.task.status) : undefined),
  badgeClass: () => badgeClass(detail.value?.task.status),
  info: () => {
    const d = detail.value;
    if (!d) return [];
    const rows = [
      { label: t("goodsVerify.detail.taskDate"), value: d.task.taskDate || t("common.noData") },
      { label: t("goodsVerify.detail.shelf"), value: d.task.shelfCode || t("common.noData") },
      { label: t("goodsVerify.detail.movementsCount"), value: String(d.task.movementsCount) },
    ];
    if (d.task.verifiedAt) {
      rows.push({
        label: t("goodsVerify.detail.verifiedAt"),
        value: new Date(d.task.verifiedAt).toLocaleString(),
      });
    }
    if (d.task.verifiedBy) {
      rows.push({ label: t("goodsVerify.detail.verifiedBy"), value: d.task.verifiedBy });
    }
    return rows;
  },
});

async function load() {
  try {
    detail.value = await warehouse.getGoodsVerifyTask(taskId);
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

async function verify() {
  verifying.value = true;
  error.value = null;
  try {
    await warehouse.verifyGoodsVerifyTask(taskId);
    showToast(t('goodsVerify.detail.verified'));
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    verifying.value = false;
  }
}

useVisibleReload(load);
</script>

<style scoped>
.section-title {
  margin: 0 0 1rem;
  font-size: 1rem;
}

.movement-card {
  margin-bottom: 0.75rem;
}

.qty-positive {
  color: var(--success, #16a34a);
  font-weight: 600;
}

.qty-negative {
  color: var(--danger, #dc2626);
  font-weight: 600;
}

.btn-primary {
  width: 100%;
  padding: 0.75rem;
  font-size: 1rem;
  font-weight: 600;
}
</style>
