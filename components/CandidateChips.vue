<template>
  <div
    v-if="showChips"
    class="candidate-chips"
    role="group"
    :aria-label="label"
  >
    <button
      v-for="(candidate, index) in candidates"
      :key="index"
      type="button"
      class="candidate-chip"
      :class="{ 'candidate-chip--active': candidate === modelValue }"
      :aria-pressed="candidate === modelValue"
      @click="emit('update:modelValue', candidate)"
    >
      {{ candidate }}
    </button>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  modelValue: string;
  candidates: string[];
  label?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const showChips = computed(() => props.candidates.length > 1);
</script>

<style scoped>
.candidate-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.candidate-chip {
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 0.8125rem;
  cursor: pointer;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.candidate-chip:hover:not(.candidate-chip--active) {
  border-color: var(--primary);
}

.candidate-chip:focus-visible {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(0, 191, 165, 0.15);
}

.candidate-chip--active {
  border-color: var(--primary);
  background: var(--primary);
  color: #fff;
}
</style>
