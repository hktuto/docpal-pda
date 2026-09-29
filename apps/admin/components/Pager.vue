<script setup lang="ts">
const page = defineModel<number>("page", { required: true });
const pageSize = defineModel<number>("pageSize", { required: true });
const props = defineProps<{ total: number }>();
const { t } = useI18n();

const SIZES = [5, 10, 20, 50, 100, 200];
// Backend list endpoints cap pageSize at 200 (e.g. src/routes/admin/crud.ts).
const MAX_PAGE_SIZE = 200;
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

// Free-input page size; commits on Enter/blur, clamped to the backend cap.
const customSize = ref(String(pageSize.value));
watch(pageSize, (v) => {
  customSize.value = String(v);
});
function applyCustomSize() {
  const n = Math.round(Number(customSize.value));
  if (Number.isFinite(n) && n >= 1) pageSize.value = Math.min(MAX_PAGE_SIZE, n);
  customSize.value = String(pageSize.value);
}
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
    <input
      v-model="customSize"
      type="number"
      min="1"
      :max="MAX_PAGE_SIZE"
      class="pager-custom"
      :aria-label="$t('admin.pager.customPerPage')"
      :title="$t('admin.pager.customPerPage')"
      @change="applyCustomSize"
      @keydown.enter="applyCustomSize"
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
.pager-custom {
  width: 4.5rem;
  padding: 0.4375rem 0.375rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  font-size: 0.8125rem;
}
.pager-custom:hover {
  border-color: var(--brand-teal);
}
</style>
