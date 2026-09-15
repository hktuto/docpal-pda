<script setup lang="ts">
// One allocated qty row sourced from stock (a shelf/box lot). Green dot.
// The source description goes in the default slot; the remove (x) is always
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
    <AllocationDot source="stock" />
    <span>{{ qty }} × <slot /></span>
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
