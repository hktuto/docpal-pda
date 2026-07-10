<template>
  <p class="empty" :class="{ 'empty--error': error }">
    <slot>{{ message }}</slot>
  </p>
</template>

<script setup lang="ts">
defineProps<{
  message?: string;
  error?: boolean;
}>();
</script>

<style scoped>
.empty--error {
  color: var(--danger);
}
</style>
