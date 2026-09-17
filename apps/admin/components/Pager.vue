<script setup lang="ts">
const page = defineModel<number>("page", { required: true });
const pageSize = defineModel<number>("pageSize", { required: true });
const props = defineProps<{ total: number }>();
const { t } = useI18n();

const SIZES = [5, 10, 20, 50, 100,200];
const pageCount = computed(() => Math.max(1, Math.ceil(props.total / pageSize.value)));

// SearchableSelect is string-valued; bridge to the numeric pageSize model.
const pageSizeText = computed({
  get: () => String(pageSize.value),
  set: (v: string) => {
    const n = Number(v);
    if (SIZES.includes(n)) pageSize.value = n;
  },
});
const pageSizeOptions = computed(() =>
  SIZES.map((s) => ({ value: String(s), label: t("admin.pager.perPage", { n: s }) }))
);
</script>

<template>
  <div class="pager">
    <span class="muted">{{ $t("admin.pager.rows", { n: total }) }}</span>
    <span class="pager-controls">
      <button class="btn btn-small" :disabled="page <= 1" @click="page--">
        ‹ {{ $t("admin.pager.prev") }}
      </button>
      <span class="muted">{{ $t("admin.pager.pageOf", { page, count: pageCount }) }}</span>
      <button class="btn btn-small" :disabled="page >= pageCount" @click="page++">
        {{ $t("admin.pager.next") }} ›
      </button>
    </span>
    <SearchableSelect
      v-model="pageSizeText"
      :options="pageSizeOptions"
      :all-label="$t('admin.pager.perPage', { n: pageSize })"
      :aria-label="$t('admin.pager.perPage', { n: pageSize })"
      :multiple="false"
      :show-all="false"
      class="pager-size"
    />
  </div>
</template>

<style scoped>
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.25rem 0;
  font-size: 0.8125rem;
}
.pager-controls {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}
.pager-size {
  width: auto;
}
</style>
