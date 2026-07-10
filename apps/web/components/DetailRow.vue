<template>
  <div class="detail-row">
    <span class="detail-label">{{ label }}</span>
    <span><slot>{{ displayValue }}</slot></span>
  </div>
</template>

<script setup lang="ts">
const { t } = useI18n();

const props = defineProps<{
  label: string;
  value?: string | number | null;
}>();

const displayValue = computed(() => {
  if (props.value === null || props.value === undefined || props.value === "") {
    return t('common.noData');
  }
  return String(props.value);
});
</script>
