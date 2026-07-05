<template>
  <div class="loading-overlay" role="status" aria-live="polite">
    <div class="loading-overlay__spinner" aria-hidden="true" />
    <p v-if="label" class="loading-overlay__label">{{ label }}</p>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  label?: string;
}>();
</script>

<style scoped>
.loading-overlay {
  position: fixed;
  inset: 0;
  z-index: 999;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(2px);
}

.loading-overlay__spinner {
  width: 2.5rem;
  height: 2.5rem;
  border: 3px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.loading-overlay__label {
  color: var(--muted);
  font-size: 0.9375rem;
  font-weight: 500;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
