<template>
  <span class="badge" :class="badgeClass(status)">
    <slot>{{ status }}</slot>
  </span>
</template>

<script setup lang="ts">
const props = defineProps<{
  status: string;
}>();

const { badgeClass } = useStatusBadge();
</script>
