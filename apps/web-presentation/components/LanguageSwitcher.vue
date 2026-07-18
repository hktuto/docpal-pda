<template>
  <div class="language-switcher">
    <span class="language-switcher__label">{{ $t('languageSwitcher.label') }}</span>
    <div class="language-switcher__options">
      <button
        v-for="loc in SUPPORTED_LOCALES"
        :key="loc"
        type="button"
        class="language-switcher__option"
        :class="{ 'language-switcher__option--active': locale === loc }"
        :aria-pressed="locale === loc"
        @click="setLocale(loc)"
      >
        {{ $t(`languageSwitcher.${loc.replace('-', '')}`) }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
const SUPPORTED_LOCALES = ["en-US", "zh-CN", "zh-HK"] as const;

const { locale, setLocale } = useI18n();
</script>

<style scoped>
.language-switcher {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  width: 100%;
}

.language-switcher__label {
  font-size: 0.75rem;
  color: var(--muted);
}

.language-switcher__options {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.language-switcher__option {
  width: 100%;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font-size: 0.875rem;
  cursor: pointer;
}

.language-switcher__option:hover {
  background: var(--bg);
}

.language-switcher__option--active {
  border-color: var(--primary);
  background: var(--primary);
  color: #fff;
}
</style>
