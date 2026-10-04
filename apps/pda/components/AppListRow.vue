<template>
  <div
    class="app-list-row"
    :class="{
      'app-list-row--expandable': expandable,
      'app-list-row--done': done,
      'app-list-row--danger': danger,
      'app-list-row--disabled': disabled,
    }"
  >
    <slot name="leading" />

    <button
      v-if="expandable"
      type="button"
      class="app-list-row__main app-list-row__toggle"
      @click="emit('toggle')"
    >
      <span class="app-list-row__line1">
        <span class="app-list-row__title">{{ title }}</span>
        <span v-if="chipText" class="badge app-list-row__chip" :class="chipClass">{{ chipText }}</span>
      </span>
      <span v-for="(line, i) in metaLines" :key="i" class="app-list-row__meta">{{ line }}</span>
    </button>
    <NuxtLink v-else-if="to" :to="to" class="app-list-row__main">
      <span class="app-list-row__line1">
        <span class="app-list-row__title">{{ title }}</span>
        <span v-if="chipText" class="badge app-list-row__chip" :class="chipClass">{{ chipText }}</span>
      </span>
      <span v-for="(line, i) in metaLines" :key="i" class="app-list-row__meta">{{ line }}</span>
    </NuxtLink>
    <div v-else class="app-list-row__main">
      <div class="app-list-row__line1">
        <span class="app-list-row__title">{{ title }}</span>
        <span v-if="chipText" class="badge app-list-row__chip" :class="chipClass">{{ chipText }}</span>
      </div>
      <div v-for="(line, i) in metaLines" :key="i" class="app-list-row__meta">{{ line }}</div>
    </div>

    <svg
      class="app-list-row__chevron"
      :class="{ 'app-list-row__chevron--open': expandable && expanded }"
      viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    ><path d="m9 18 6-6-6-6"/></svg>

    <div v-if="expandable && expanded" class="app-list-row__detail">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Shared single-column list row (spec 2026-10-04 PDA app rewrite): the title
 * takes the full width and wraps to 2 lines; ONE small status chip sits
 * inline at the end of the title line (no right-hand aside column); up to 2
 * full-width meta lines; chevron on the right. `expandable` + the default
 * slot cover the detail-page variant (toggle button + expandable detail
 * block), `done`/`danger` paint the left border. The root is never an
 * anchor — `to` turns only the main area into a NuxtLink, so the `leading`
 * slot can hold interactive controls (e.g. selection checkboxes).
 */
const props = defineProps<{
  title: string;
  /** Up to 2 meta lines; null/empty entries are dropped. */
  meta?: (string | null | undefined)[];
  chipText?: string;
  chipClass?: string;
  /** Navigation target for the main area. Omit for a plain row. */
  to?: string;
  expandable?: boolean;
  expanded?: boolean;
  done?: boolean;
  danger?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();

const metaLines = computed(() =>
  (props.meta ?? []).filter((l): l is string => Boolean(l && l.trim())).slice(0, 2)
);
</script>
