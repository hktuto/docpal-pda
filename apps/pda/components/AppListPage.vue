<template>
  <div>
    <div class="list-toolbar">
      <div v-if="filters?.length" class="filters">
        <button
          v-for="opt in filters"
          :key="opt.value"
          class="filter-chip"
          :class="{ 'filter-chip--active': filter === opt.value }"
          @click="emit('update:filter', opt.value)"
        >
          {{ $t(opt.labelKey) }}
        </button>
      </div>

      <div class="search-row">
        <input
          :value="search"
          class="search"
          type="text"
          :placeholder="searchPlaceholder ? $t(searchPlaceholder) : undefined"
          @input="onSearchInput"
        />
        <slot name="toolbar-actions" />
        <button
          type="button"
          class="refresh-btn"
          :aria-label="$t('common.refresh')"
          :disabled="loading"
          @click="reload()"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
        </button>
      </div>
    </div>

    <p v-if="loading && empty" class="empty">{{ $t('common.loading') }}</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">{{ $t('common.errorPrefix', { message: error }) }}</p>
    <p v-else-if="notice" class="empty" style="color: #92400e;">{{ notice }}</p>
    <p v-else-if="empty" class="empty">{{ emptyText ? $t(emptyText) : '' }}</p>

    <div v-else class="list-panel">
      <slot />
    </div>

    <div v-if="!empty" class="list-footer">
      <span class="list-footer__count">{{ $t('common.showingOf', { shown, total }) }}</span>
      <button
        v-if="hasMore"
        type="button"
        class="btn btn--small"
        :disabled="loading"
        @click="emit('load-more')"
      >
        {{ $t('common.loadMore') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
export interface AppListFilterOption {
  labelKey: string;
  value: string;
}

/**
 * Shared list-page scaffold (spec 2026-10-04 PDA app rewrite): sticky toolbar
 * (filter chips + refresh + search), loading/error/empty states, 50-row
 * load-more footer, and useVisibleReload wiring (mount / visibility regain /
 * SSE topics). Pages own the fetch logic; they rebuild the query from
 * `search`/`filter` and reload on `apply` (debounced for search input,
 * immediate for filter-chip changes) and `load-more`.
 */
const props = defineProps<{
  search: string;
  searchPlaceholder?: string;
  filters?: AppListFilterOption[];
  filter?: string;
  loading: boolean;
  error?: string | null;
  /** True when there is nothing to render (drives loading/empty states). */
  empty: boolean;
  emptyText?: string;
  shown: number;
  total: number;
  hasMore: boolean;
  /** Re-fetch keeping the loaded row count (visibility regain / SSE). */
  reload: () => void | Promise<void>;
  topics?: string[];
  /** Warning-style message that replaces the list (e.g. issue-report summary). */
  notice?: string | null;
}>();

const emit = defineEmits<{
  "update:search": [value: string];
  "update:filter": [value: string];
  /** Search (debounced) or filter (immediate) changed — reset and reload. */
  apply: [];
  "load-more": [];
}>();

let searchTimer: ReturnType<typeof setTimeout> | null = null;

function onSearchInput(event: Event) {
  emit("update:search", (event.target as HTMLInputElement).value);
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => emit("apply"), 300);
}

watch(
  () => props.filter,
  () => emit("apply")
);

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer);
});

useVisibleReload(() => props.reload(), props.topics);
</script>

<style scoped>
.filters {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  overflow-x: auto;
  padding-bottom: 0.25rem;
}

.refresh-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  border: 1px solid var(--border);
  border-radius: 9999px;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
}

.search-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.search-row .search {
  flex: 1;
  margin-bottom: 0;
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.list-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-top: 0.75rem;
}

.list-footer__count {
  font-size: 0.8125rem;
  color: var(--muted);
}
</style>
