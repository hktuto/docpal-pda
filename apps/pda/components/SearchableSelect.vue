<script setup lang="ts">
export interface SearchableSelectOption {
  value: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    options: SearchableSelectOption[];
    allLabel: string;
    ariaLabel?: string;
    multiple?: boolean;
    disabled?: boolean;
  }>(),
  { multiple: false, disabled: false }
);
const model = defineModel<string>({ default: "" });

const open = ref(false);
const query = ref("");
const rootRef = ref<HTMLElement | null>(null);
const searchRef = ref<HTMLInputElement | null>(null);

const isAll = computed(() => model.value === "");
const buttonLabel = computed(() => {
  if (isAll.value) return props.allLabel;
  return props.options.find((o) => o.value === model.value)?.label ?? model.value;
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter(
    (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
  );
});

function toggle() {
  open.value = !open.value;
  if (open.value) {
    query.value = "";
    nextTick(() => searchRef.value?.focus());
  }
}

function pick(value: string) {
  model.value = value;
  open.value = false;
}

function clearAll() {
  model.value = "";
  open.value = false;
}

function onDocumentClick(event: MouseEvent) {
  if (rootRef.value && !rootRef.value.contains(event.target as Node)) open.value = false;
}
watch(open, (v) => {
  if (v) document.addEventListener("click", onDocumentClick);
  else document.removeEventListener("click", onDocumentClick);
});
onBeforeUnmount(() => document.removeEventListener("click", onDocumentClick));
</script>

<template>
  <div ref="rootRef" class="ssel">
    <button
      type="button"
      class="ssel-toggle"
      :class="{ 'ssel-placeholder': isAll }"
      :aria-label="ariaLabel ?? allLabel"
      :aria-expanded="open"
      :disabled="disabled"
      @click="toggle"
    >
      <span class="ssel-label">{{ buttonLabel }}</span>
      <span class="ssel-caret">▾</span>
    </button>
    <div v-if="open" class="ssel-panel" @keydown.escape="open = false">
      <input
        v-model="query"
        ref="searchRef"
        type="text"
        class="ssel-search"
        :placeholder="$t('adHocPutAway.searchPlaceholder')"
      />
      <div class="ssel-list">
        <div class="ssel-item" :class="{ selected: isAll }" @click="clearAll">
          {{ allLabel }}
          <span v-if="isAll" class="ssel-check">✓</span>
        </div>
        <label
          v-for="o in filtered"
          :key="o.value"
          class="ssel-item"
          :class="{ selected: model === o.value }"
          @click="pick(o.value)"
        >
          <span class="ssel-item-label">{{ o.label }}</span>
          <span v-if="model === o.value" class="ssel-check">✓</span>
        </label>
        <div v-if="filtered.length === 0" class="ssel-item muted">{{ $t('adHocPutAway.noMatch') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ssel {
  position: relative;
}
.ssel-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.375rem;
  width: 100%;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font-size: 1rem;
  cursor: pointer;
  text-align: left;
}
.ssel-toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ssel-placeholder .ssel-label {
  color: var(--muted);
}
.ssel-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ssel-caret {
  font-size: 0.625rem;
  color: var(--muted);
}
.ssel-panel {
  position: absolute;
  top: calc(100% + 0.25rem);
  left: 0;
  z-index: 30;
  min-width: 100%;
  width: max-content;
  max-width: 21.25rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 6px 18px rgba(15, 23, 32, 0.14);
  padding: 0.375rem;
}
.ssel-search {
  width: 100%;
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.875rem;
  margin-bottom: 0.25rem;
  box-sizing: border-box;
  background: var(--surface);
  color: var(--text);
}
.ssel-list {
  max-height: 16.25rem;
  overflow-y: auto;
}
.ssel-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3125rem 0.5rem;
  font-size: 0.875rem;
  white-space: nowrap;
  cursor: pointer;
  border-radius: var(--radius);
}
.ssel-item:hover {
  background: var(--surface);
  filter: brightness(0.95);
}
.ssel-item.selected {
  color: var(--primary);
  font-weight: 600;
}
.ssel-item-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ssel-item.muted {
  color: var(--muted);
  cursor: default;
}
.ssel-check {
  font-size: 0.6875rem;
  margin-left: auto;
}
</style>
