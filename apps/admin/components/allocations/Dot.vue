<script setup lang="ts">
defineProps<{ source: "stock" | "receiving" }>();
</script>

<template>
  <span
    class="alloc-dot"
    :class="source === 'stock' ? 'dot-stock' : 'dot-receiving'"
    aria-hidden="true"
  />
</template>

<style scoped>
.alloc-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.dot-stock {
  background: #1e7a46;
}
.dot-receiving {
  background: #1a6fc4;
}
</style>
