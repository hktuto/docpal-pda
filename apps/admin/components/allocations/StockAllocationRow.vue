<script setup lang="ts">
// One allocated qty row sourced from stock (a shelf/box lot). Green dot.
// The source description goes in the default slot; optional allocation detail
// (date code, lot code, …) in the "tooltip" slot; the remove (x) is always
// rendered — the parent decides whether removal is allowed via `removing`.
defineProps<{
  qty: number;
  removing: boolean;
  removeTitle: string;
}>();

const emit = defineEmits<{ remove: [] }>();
</script>

<template>
  <div class="alloc-row">
    <AllocationsTooltip>
      <AllocationsDot source="stock" />
      <span>{{ qty }} × <slot /></span>
      <template v-if="$slots.tooltip" #popup>
        <slot name="tooltip" />
      </template>
    </AllocationsTooltip>
    <button
      class="icon-btn alloc-remove"
      :disabled="removing"
      :title="removeTitle"
      @click.stop="emit('remove')"
    >
      {{ removing ? "…" : "✕" }}
    </button>
  </div>
</template>
