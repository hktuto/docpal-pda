<template>
  <div>
    <p v-if="loading" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: error }) }}</p>

    <template v-else-if="task">
      <div class="card" style="margin-bottom: 1rem;">
        <div class="list-card__header">
          <span class="list-card__title">{{ task.refNo }}</span>
          <span class="badge" :class="badgeClass(task.status)">{{ statusLabel.goodsVerifyTask(task.status) }}</span>
        </div>
        <DetailRow :label="$t('goodsVerify.task.dueDateLabel')" :value="formatDate(task.dueDate)" />
        <DetailRow :label="$t('goodsVerify.task.createdDateLabel')" :value="formatDate(task.createdAt)" />
      </div>

      <h2 class="section-title">{{ $t('goodsVerify.task.shelvesTitle') }}</h2>

      <div v-for="shelf in task.shelves" :key="shelf.code" class="card" style="margin-bottom: 1rem;">
        <div
          style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;"
          @click="toggleShelf(shelf.code)"
        >
          <div>
            <p class="card__title">{{ shelf.code }}</p>
            <p class="card__meta">{{ shelf.zone }}</p>
          </div>
          <span class="badge badge--info">{{ shelf.boxes.length }} {{ $t(shelf.boxes.length === 1 ? 'common.box' : 'common.boxes') }}</span>
        </div>

        <div v-if="expandedShelves.has(shelf.code)" style="margin-top: 0.75rem;">
          <NuxtLink
            v-for="box in shelf.boxes"
            :key="box.id"
            :to="`/goods-verify/box/${box.id}`"
            class="card"
            :class="{ 'card--done': box.status === 'verified' }"
            style="margin-bottom: 0.5rem;"
          >
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <p class="card__title" style="font-size: 0.9375rem;">{{ box.id }}</p>
                <p class="card__meta">
                  {{ box.verifiedCount }} / {{ box.itemCount }} {{ $t('goodsVerify.shelf.verified') }}
                </p>
              </div>
              <span class="badge" :class="badgeClass(box.status)">{{ statusLabel.box(box.status) }}</span>
            </div>
          </NuxtLink>
        </div>
      </div>
    </template>

    <p v-else class="empty">{{ $t('goodsVerify.task.notFound') }}</p>
  </div>
</template>

<script setup lang="ts">
import { badgeClass } from "~/composables/useStatusBadge";
import { useWarehouse } from "~/composables/useWarehouse";
import { useErrorMessage } from "~/composables/errorMessage";
import type { GoodsVerifyTaskDetail } from "~/services/types";

definePageMeta({ title: "meta.goodsVerifyTask" });

const { t } = useI18n();
useHead({ title: t('goodsVerify.task.title') });

const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const route = useRoute();
const taskId = route.params.id as string;

const task = ref<GoodsVerifyTaskDetail | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const expandedShelves = ref<Set<string>>(new Set());

async function load() {
  loading.value = true;
  error.value = null;
  try {
    task.value = await warehouse.getGoodsVerifyTask(taskId);
  } catch (e: unknown) {
    error.value = errorMessage(e);
    task.value = null;
  } finally {
    loading.value = false;
  }
}

function formatDate(value: string | null | undefined): string {
  if (!value) return t('common.noDate');
  return new Date(value).toLocaleDateString();
}

function toggleShelf(code: string) {
  const next = new Set(expandedShelves.value);
  if (next.has(code)) next.delete(code);
  else next.add(code);
  expandedShelves.value = next;
}

useVisibleReload(load);
</script>
