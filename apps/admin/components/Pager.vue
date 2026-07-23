<script setup lang="ts">
const page = defineModel<number>("page", { required: true });
const pageSize = defineModel<number>("pageSize", { required: true });
const props = defineProps<{ total: number }>();

const SIZES = [20, 50, 100];
const pageCount = computed(() => Math.max(1, Math.ceil(props.total / pageSize.value)));
</script>

<template>
  <div class="pager">
    <span class="muted">{{ total }} row{{ total === 1 ? "" : "s" }}</span>
    <span class="pager-controls">
      <button class="btn btn-small" :disabled="page <= 1" @click="page--">‹ Prev</button>
      <span class="muted">Page {{ page }} / {{ pageCount }}</span>
      <button class="btn btn-small" :disabled="page >= pageCount" @click="page++">Next ›</button>
    </span>
    <select v-model.number="pageSize" class="pager-size">
      <option v-for="s in SIZES" :key="s" :value="s">{{ s }} / page</option>
    </select>
  </div>
</template>

<style scoped>
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 4px 0;
  font-size: 13px;
}
.pager-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pager-size {
  padding: 4px 6px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
  font-size: 13px;
}
</style>
