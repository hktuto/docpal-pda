<template>
  <div class="language-switcher">
    <label :for="selectId" class="sr-only">{{ $t('languageSwitcher.label') }}</label>
    <select
      :id="selectId"
      :value="locale"
      class="language-switcher__select"
      @change="onChange"
    >
      <option value="en-US">{{ $t('languageSwitcher.enUS') }}</option>
      <option value="zh-CN">{{ $t('languageSwitcher.zhCN') }}</option>
      <option value="zh-HK">{{ $t('languageSwitcher.zhHK') }}</option>
    </select>
  </div>
</template>

<script setup lang="ts">
const { locale, setLocale } = useI18n();
const selectId = useId();

function onChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  setLocale(target.value);
}
</script>

<style scoped>
.language-switcher {
  display: flex;
  align-items: center;
}

.language-switcher__select {
  appearance: none;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  padding: 0.375rem 1.75rem 0.375rem 0.625rem;
  font-size: 0.875rem;
  line-height: 1.25rem;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.375rem center;
  background-size: 1rem;
}

.language-switcher__select:focus {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
</style>
