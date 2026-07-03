<template>
  <div class="scan-fab">
    <button
      type="button"
      class="btn"
      :aria-label="ariaLabel"
      :disabled="loading"
      @click="$emit('click')"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
        <circle cx="12" cy="13" r="4"/>
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  loading?: boolean;
  ariaLabel?: string;
}>(), {
  ariaLabel: "Scan label",
});

defineEmits<{
  click: [];
}>();
</script>

<style scoped>
.scan-fab {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  z-index: 60;
}

.scan-fab .btn {
  border-radius: 9999px;
  width: 3.5rem;
  height: 3.5rem;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow);
}
</style>
