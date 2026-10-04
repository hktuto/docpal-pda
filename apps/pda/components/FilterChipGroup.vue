<template>
  <div class="chip-group">
    <input
      v-if="options.length > SEARCH_BOX_THRESHOLD"
      v-model="query"
      type="search"
      class="chip-group__search"
      :placeholder="searchPlaceholder"
      :aria-label="ariaLabel"
    />
    <div class="chip-group__list" role="group" :aria-label="ariaLabel">
      <template v-for="(item, index) in filtered" :key="item.value">
        <div v-if="item.group && item.group !== filtered[index - 1]?.group" class="chip-group__group">
          {{ item.group }}
        </div>
        <button
          type="button"
          class="chip"
          :class="{ 'chip--active': selected.has(item.value) }"
          :aria-pressed="selected.has(item.value)"
          @click="toggle(item.value)"
        >
          {{ item.label }}
        </button>
      </template>
      <p v-if="filtered.length === 0" class="chip-group__empty">{{ emptyText }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
export interface FilterChipOption {
  value: string;
  label: string;
  /** Options sharing a group label get a small heading between chip rows. */
  group?: string;
}

const props = withDefaults(
  defineProps<{
    options: FilterChipOption[];
    modelValue: string[];
    searchPlaceholder?: string;
    ariaLabel?: string;
    emptyText?: string;
  }>(),
  { searchPlaceholder: "", ariaLabel: "", emptyText: "—" }
);

const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();

// Long lists (e.g. the real HK shelf layout) get a filter box so the chips
// stay usable on a phone screen.
const SEARCH_BOX_THRESHOLD = 8;

const query = ref("");

const selected = computed(() => new Set(props.modelValue));

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter(
    (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
  );
});

function toggle(value: string) {
  const next = selected.value.has(value)
    ? props.modelValue.filter((v) => v !== value)
    : [...props.modelValue, value];
  emit("update:modelValue", next);
}
</script>

<style scoped>
.chip-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.chip-group__search {
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
}

.chip-group__list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  max-height: 11rem;
  overflow-y: auto;
  padding: 0.125rem;
}

.chip-group__group {
  flex-basis: 100%;
  margin-top: 0.25rem;
  font-size: 0.75rem;
  color: var(--muted);
}

.chip-group__group:first-child {
  margin-top: 0;
}

.chip {
  min-height: 2rem;
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text);
  font-size: 0.875rem;
  cursor: pointer;
}

.chip--active {
  background: var(--primary);
  border-color: transparent;
  color: #fff;
}

.chip-group__empty {
  margin: 0;
  color: var(--muted);
  font-size: 0.875rem;
}
</style>
