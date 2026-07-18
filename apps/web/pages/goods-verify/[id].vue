<template>
  <div>
    <p v-if="pending" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: error }) }}</p>

    <template v-else-if="detail">
      <DetailHeader
        v-model="headerExpanded"
        :title="detail.task.partNo"
        :status="detail.task.status"
        :label="statusLabel.goodsVerify(detail.task.status)"
        :badge-class="badgeClass(detail.task.status)"
        :flush-top="route.meta.props?.noPadding"
        style="margin-bottom: 1.5rem;"
      >
        <DetailRow :label="$t('goodsVerify.detail.taskDate')" :value="detail.task.taskDate" />
        <DetailRow :label="$t('goodsVerify.detail.shelf')" :value="detail.task.shelfCode || $t('common.noData')" />
        <DetailRow :label="$t('goodsVerify.detail.box')" :value="detail.task.boxId || $t('common.noData')" />
        <DetailRow :label="$t('goodsVerify.detail.expectedQty')" :value="detail.task.expectedQty" />
        <DetailRow
          v-if="detail.task.verifiedAt"
          :label="$t('goodsVerify.detail.verifiedAt')"
          :value="new Date(detail.task.verifiedAt).toLocaleString()"
        />
        <DetailRow
          v-if="detail.task.verifiedBy"
          :label="$t('goodsVerify.detail.verifiedBy')"
          :value="detail.task.verifiedBy"
        />
      </DetailHeader>

      <h2 class="section-title">{{ $t('goodsVerify.detail.lot') }}</h2>
      <div class="card" style="margin-bottom: 1.5rem;">
        <DetailRow :label="$t('goodsVerify.detail.part')">
          <span>
            {{ detail.task.partNo }}
            <template v-if="detail.task.wclItemNo"> · {{ detail.task.wclItemNo }}</template>
          </span>
        </DetailRow>
        <DetailRow
          v-if="detail.task.description"
          :label="$t('goodsVerify.detail.description')"
          :value="detail.task.description"
        />
        <DetailRow :label="$t('goodsVerify.detail.dateCode')" :value="detail.lot.dateCode || $t('common.noData')" />
        <DetailRow :label="$t('goodsVerify.detail.lotCode')" :value="detail.lot.lotCode || $t('common.noData')" />
        <DetailRow
          :label="$t('goodsVerify.detail.cooCow')"
          :value="`${detail.lot.coo || $t('common.noData')} / ${detail.lot.cow || $t('common.noData')}`"
        />
        <DetailRow :label="$t('goodsVerify.detail.warehouse')" :value="detail.lot.warehouseCode" />
        <DetailRow :label="$t('goodsVerify.detail.section')" :value="detail.lot.warehouseSectionCode || $t('common.noData')" />
        <DetailRow :label="$t('goodsVerify.detail.subInventory')" :value="detail.lot.subInventoryCode || $t('common.noData')" />
        <DetailRow :label="$t('goodsVerify.detail.shelf')" :value="detail.lot.shelfCode || $t('common.noData')" />
        <DetailRow :label="$t('goodsVerify.detail.box')" :value="detail.lot.boxId || $t('common.noData')" />
        <DetailRow :label="$t('goodsVerify.detail.expectedQty')" :value="detail.task.expectedQty" />
        <DetailRow :label="$t('goodsVerify.detail.currentTotal')" :value="detail.lot.totalQty" />
        <DetailRow :label="$t('goodsVerify.detail.allocated')" :value="detail.lot.allocatedQty" />
        <DetailRow :label="$t('goodsVerify.detail.available')" :value="detail.lot.availableQty" />
      </div>

      <template v-if="detail.box">
        <h2 class="section-title">{{ $t('goodsVerify.detail.boxContents') }}</h2>
        <div class="card" style="margin-bottom: 1.5rem;">
          <DetailRow :label="$t('goodsVerify.detail.box')" :value="detail.box.id" />
          <DetailRow :label="$t('goodsVerify.detail.boxStatus')">
            <span class="badge" :class="badgeClass(detail.box.status)">{{ statusLabel.box(detail.box.status) }}</span>
          </DetailRow>
        </div>
        <p v-if="detail.box.items.length === 0" class="empty">{{ $t('goodsVerify.detail.noBoxItems') }}</p>
        <div
          v-for="item in detail.box.items"
          :key="item.id"
          class="card"
          :class="{ 'card--done': item.verified }"
        >
          <DetailRow :label="$t('goodsVerify.detail.part')" :value="item.partNo" />
          <DetailRow :label="$t('goodsVerify.detail.qty')" :value="item.qty" />
          <DetailRow :label="$t('goodsVerify.detail.itemVerified')">
            <span class="badge" :class="badgeClass(item.verified ? 'verified' : 'pending')">
              {{ item.verified ? $t('common.yes') : $t('common.no') }}
            </span>
          </DetailRow>
        </div>
      </template>

      <template v-if="detail.task.status === 'pending'">
        <h2 class="section-title">{{ $t('goodsVerify.detail.verify') }}</h2>
        <div class="card">
          <div class="verify-row">
            <label class="verify-label" for="counted-qty">{{ $t('goodsVerify.detail.countedQty') }}</label>
            <input
              id="counted-qty"
              v-model="countedInput"
              class="verify-input"
              type="text"
              inputmode="numeric"
              :placeholder="String(detail.task.expectedQty)"
            />
          </div>
          <p class="verify-hint">{{ verifyHint }}</p>
          <p v-if="countedError" class="verify-hint" style="color: var(--danger);">
            {{ $t('goodsVerify.detail.invalidCountedQty') }}
          </p>
          <button class="btn" :disabled="verifying || countedError" @click="verify">
            {{ verifying ? $t('goodsVerify.detail.verifying') : $t('goodsVerify.detail.verify') }}
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

definePageMeta({ title: "meta.goodsVerifyDetail", props: { noPadding: true } });

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
const headerExpanded = ref(false);
const countedInput = ref("");
const verifying = ref(false);

async function load() {
  try {
    detail.value = await warehouse.getGoodsVerifyTask(taskId);
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

// Empty input = confirm without count; otherwise a non-negative integer.
const countedQty = computed<number | null>(() => {
  const raw = countedInput.value.trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
});

const countedError = computed(() => countedQty.value !== null && Number.isNaN(countedQty.value));

const verifyHint = computed(() => {
  if (!detail.value) return "";
  const expected = detail.value.task.expectedQty;
  const counted = countedQty.value;
  if (counted === null) return t('goodsVerify.detail.hintEmpty', { qty: expected });
  if (Number.isNaN(counted)) return "";
  if (counted === expected) return t('goodsVerify.detail.hintMatch');
  return t('goodsVerify.detail.hintAdjust', { delta: counted - expected });
});

async function verify() {
  verifying.value = true;
  error.value = null;
  try {
    const counted = countedQty.value;
    await warehouse.verifyGoodsVerifyTask(taskId, counted === null || Number.isNaN(counted) ? undefined : counted);
    showToast(t('goodsVerify.detail.verified'));
    countedInput.value = "";
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

.verify-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.verify-label {
  font-size: 0.8125rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.verify-input {
  flex: 1;
  min-width: 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font-size: 0.9375rem;
}

.verify-hint {
  margin: 0.5rem 0 0.75rem;
  font-size: 0.8125rem;
  color: var(--muted);
}
</style>
