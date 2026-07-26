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
/* Fallback values keep the component usable in apps that don't define the
   PDA design tokens (e.g. the admin console). */
.language-switcher {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  width: 100%;
}

.language-switcher__label {
  font-size: 0.75rem;
  color: var(--muted, #666);
}

.language-switcher__options {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.language-switcher__option {
  width: 100%;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--border, #ccc);
  border-radius: var(--radius, 6px);
  background: var(--surface, #fff);
  color: var(--text, #222);
  font-size: 0.875rem;
  cursor: pointer;
}

.language-switcher__option:hover {
  background: var(--bg, #f0f0f0);
}

.language-switcher__option--active {
  border-color: var(--primary, #2563eb);
  background: var(--primary, #2563eb);
  color: #fff;
}
</style>
