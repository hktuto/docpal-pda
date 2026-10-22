<script setup lang="ts">
import { useAnchoredPanel } from "~/composables/useAnchoredPanel";

export interface SearchableSelectOption {
  value: string;
  label: string;
  /** Optional group label — options with the same group must be contiguous;
   *  each run renders under a group header row. Omit for a flat list. */
  group?: string;
}

// Searchable select dropdown with a type-to-filter search box.
// - multiple (default): v-model is string[]; checkbox list, empty selection
//   means "all" (no filter).
// - single (multiple = false): v-model is string; "" means "all", picking an
//   option closes the panel.
// With showAll (default true) the first row resets to the "all" state
// (allLabel); showAll = false hides that row, and an empty model just shows
// allLabel as placeholder text.
const props = withDefaults(
  defineProps<{
    options: SearchableSelectOption[];
    /** Label shown in the "all" state, e.g. "All brands". */
    allLabel: string;
    ariaLabel?: string;
    /** false → single-select mode (v-model: string). Default true. */
    multiple?: boolean;
    /** false → no "all" reset row in the panel. Default true. */
    showAll?: boolean;
    disabled?: boolean;
  }>(),
  { multiple: true, showAll: true, disabled: false }
);
const model = defineModel<string[] | string>({ default: () => [] });
const { t } = useI18n();

const open = ref(false);
const query = ref("");
const rootRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const searchRef = ref<HTMLInputElement | null>(null);

// The panel teleports to <body> (a select inside a table cell would be
// clipped by the cell's overflow) and tracks the toggle's viewport position
// while open.
const { panelStyle } = useAnchoredPanel(rootRef, open);

const selectedValues = computed<string[]>(() =>
  props.multiple
    ? Array.isArray(model.value)
      ? model.value
      : []
    : typeof model.value === "string" && model.value !== ""
      ? [model.value]
      : []
);
const selectedSet = computed(() => new Set(selectedValues.value));
const isAll = computed(() => selectedValues.value.length === 0);

const buttonLabel = computed(() => {
  if (isAll.value) return props.allLabel;
  const labels = selectedValues.value.map(
    (v) => props.options.find((o) => o.value === v)?.label ?? v
  );
  return labels.join(", ");
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter(
    (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
  );
});

// Contiguous runs of the same option.group, each rendered under a header row.
const filteredGroups = computed<{ label: string | null; items: SearchableSelectOption[] }[]>(() => {
  const groups: { label: string | null; items: SearchableSelectOption[] }[] = [];
  for (const o of filtered.value) {
    const label = o.group ?? null;
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(o);
    else groups.push({ label, items: [o] });
  }
  return groups;
});

function toggle() {
  open.value = !open.value;
  if (open.value) {
    query.value = "";
    nextTick(() => searchRef.value?.focus());
  }
}

function pick(value: string) {
  if (props.multiple) {
    const next = new Set(selectedValues.value);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    model.value = [...next];
  } else {
    model.value = value;
    open.value = false;
  }
}

function clearAll() {
  model.value = props.multiple ? [] : "";
  if (!props.multiple) open.value = false;
}

function onDocumentClick(event: MouseEvent) {
  const target = event.target as Node;
  // The panel is teleported to <body> — a click inside it (e.g. its search
  // box) is outside rootRef.
  if (rootRef.value?.contains(target) || panelRef.value?.contains(target)) return;
  open.value = false;
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
    <Teleport to="body">
      <div v-if="open" ref="panelRef" :style="panelStyle" class="ssel-panel" @keydown.escape="open = false">
        <input
          ref="searchRef"
          v-model="query"
          class="ssel-search"
          :placeholder="t('admin.common.filterPlaceholder')"
        />
        <div class="ssel-list">
          <div v-if="showAll" class="ssel-item" :class="{ selected: isAll }" @click="clearAll">
            {{ allLabel }}
            <span v-if="isAll" class="ssel-check">✓</span>
          </div>
          <template v-for="(g, gi) in filteredGroups" :key="gi">
            <div v-if="g.label !== null" class="ssel-group">{{ g.label }}</div>
            <label
              v-for="o in g.items"
              :key="o.value"
              class="ssel-item"
              :class="{ selected: selectedSet.has(o.value) }"
              @click="!multiple && pick(o.value)"
            >
              <input
                v-if="multiple"
                type="checkbox"
                :checked="selectedSet.has(o.value)"
                @change="pick(o.value)"
              />
              <span class="ssel-item-label">{{ o.label }}</span>
              <span v-if="!multiple && selectedSet.has(o.value)" class="ssel-check">✓</span>
            </label>
          </template>
          <div v-if="filtered.length === 0" class="ssel-item muted">{{ t("admin.common.noRecords") }}</div>
        </div>
      </div>
    </Teleport>
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
  padding: 0.4375rem 0.5625rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  background: #fff;
  font-size: 0.875rem;
  cursor: pointer;
  text-align: left;
}
.ssel-toggle:hover {
  border-color: var(--brand-teal);
}
.ssel-toggle:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.ssel-placeholder .ssel-label {
  color: #7d8a97;
}
.ssel-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ssel-caret {
  font-size: 0.625rem;
  color: #52606d;
}
.ssel-panel {
  position: fixed;
  z-index: 30;
  width: max-content;
  max-width: 21.25rem;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 6px 18px rgba(15, 23, 32, 0.14);
  padding: 0.375rem;
}
.ssel-search {
  width: 100%;
  padding: 0.375rem 0.5rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  font-size: 0.8125rem;
  margin-bottom: 0.25rem;
  box-sizing: border-box;
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
  font-size: 0.8125rem;
  white-space: nowrap;
  cursor: pointer;
  border-radius: 0.1875rem;
}
.ssel-group {
  padding: 0.375rem 0.5rem 0.125rem;
  font-size: 0.6875rem;
  font-weight: 600;
  color: #7b8794;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.ssel-item:hover {
  background: #eef4f6;
}
.ssel-item.selected {
  color: var(--brand-teal-dark);
  font-weight: 600;
}
.ssel-item-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ssel-check {
  font-size: 0.6875rem;
  margin-left: auto;
}
</style>
