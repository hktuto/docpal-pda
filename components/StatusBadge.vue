<template>
  <span class="badge" :class="badgeClass(status)">
    <slot>{{ label || status }}</slot>
  </span>
</template>

<script setup lang="ts">
import { badgeClass } from "~/composables/useStatusBadge";

defineProps<{
  status: string;
  label?: string;
}>();
</script>
