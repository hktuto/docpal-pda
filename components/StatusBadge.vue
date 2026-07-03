<template>
  <span class="badge" :class="badgeClass(status)">
    <slot>{{ status }}</slot>
  </span>
</template>

<script setup lang="ts">
import { badgeClass } from "~/composables/useStatusBadge";

defineProps<{
  status: string;
}>();
</script>
