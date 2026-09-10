<script setup lang="ts">
// Banner pair for useChangeNotice: amber "data changed elsewhere" prompt
// (busy state) or a brief green "updated" flash after a silent reload.
defineProps<{ pending: boolean; justUpdated: boolean }>();
const emit = defineEmits<{ (e: "refresh"): void; (e: "dismiss"): void }>();
</script>

<template>
  <div v-if="pending" class="change-notice">
    <span>{{ $t("admin.common.dataChangedElsewhere") }}</span>
    <button class="btn btn-small" @click="emit('refresh')">{{ $t("admin.common.refresh") }}</button>
    <button type="button" class="notice-dismiss" :title="$t('admin.common.dismiss')" @click="emit('dismiss')">×</button>
  </div>
  <div v-else-if="justUpdated" class="change-notice updated">
    {{ $t("admin.common.dataUpdated") }}
  </div>
</template>

<style scoped>
.change-notice {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 14px;
  background: #fff8e6;
  border: 1px solid #f0dca0;
  color: #8a6d1a;
}
.change-notice.updated {
  background: #e9f7ef;
  border-color: #b5e2c8;
  color: #1e7a46;
}
.notice-dismiss {
  margin-left: auto;
  border: none;
  background: none;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  color: inherit;
  opacity: 0.6;
}
.notice-dismiss:hover {
  opacity: 1;
}
</style>
