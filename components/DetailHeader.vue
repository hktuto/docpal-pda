<template>
  <div class="card" :class="{ 'card--flush-top': flushTop }">
    <div class="detail-header" @click="toggle">
      <div class="detail-header__main">
        <span class="detail-header__title">{{ title }}</span>
        <span class="badge" :class="badgeClass">{{ status }}</span>
      </div>
      <button
        class="detail-header__toggle"
        aria-label="Toggle details"
        @click.stop="toggle"
      >
        {{ expanded ? "▲" : "▼" }}
      </button>
    </div>

    <div v-if="$slots.actions" class="detail-header__actions" @click.stop>
      <slot name="actions" />
    </div>

    <div v-if="expanded" class="detail-header__body">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
interface Props {
  title: string;
  status: string;
  badgeClass?: string;
  flushTop?: boolean;
  modelValue: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
}>();

const expanded = computed({
  get: () => props.modelValue,
  set: (value) => emit("update:modelValue", value),
});

function toggle() {
  expanded.value = !expanded.value;
}
</script>

<style scoped>
.detail-header {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  cursor: pointer;
}

.detail-header__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
}

.detail-header__title {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--text);
  word-break: break-word;
  flex: 0 1 auto;
  min-width: 0;
}

.detail-header__main .badge {
  font-size: 0.625rem;
  padding: 0.12rem 0.4rem;
  letter-spacing: 0.03em;
}

.detail-header__toggle {
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 0.875rem;
  cursor: pointer;
  padding: 0.25rem;
  margin-top: 0.15rem;
}

.detail-header__actions {
  margin-top: 0.75rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.detail-header__body {
  margin-top: 0.75rem;
}

.card.card--flush-top {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
</style>
