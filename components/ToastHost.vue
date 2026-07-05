<template>
  <Teleport to="body">
    <div class="toast-host">
      <TransitionGroup name="toast" tag="div" class="toast-list">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="toast"
          role="status"
          aria-live="polite"
        >
          <span class="toast__message">{{ toast.message }}</span>
          <NuxtLink
            v-if="toast.action"
            :to="toast.action.to"
            class="toast__action"
            @click="dismissToast(toast.id)"
          >
            {{ toast.action.label }}
          </NuxtLink>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useToast } from "~/composables/useToast";

const { toasts, dismissToast } = useToast();
</script>

<style scoped>
.toast-host {
  position: fixed;
  bottom: 1rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  pointer-events: none;
}

.toast-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.toast {
  pointer-events: auto;
  min-width: 16rem;
  max-width: calc(100vw - 2rem);
  padding: 0.75rem 1rem;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.toast__action {
  margin-left: auto;
  color: var(--primary);
  font-weight: 600;
  white-space: nowrap;
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.2s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(1rem);
}
</style>
