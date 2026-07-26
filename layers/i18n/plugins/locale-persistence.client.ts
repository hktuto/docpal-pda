// Restores the saved locale on app start and persists every change, so the
// language choice is shared across the web and admin apps (same storage key).
// NOTE: `useI18n()` is component-setup-only; in a plugin the composer is
// available as `nuxtApp.$i18n` (with `locale` + `setLocale`).
const SUPPORTED_LOCALES = ["en-US", "zh-CN", "zh-HK"] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
const STORAGE_KEY = "warehouse-locale";

export default defineNuxtPlugin((nuxtApp) => {
  const i18n = nuxtApp.$i18n;

  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && SUPPORTED_LOCALES.includes(saved as SupportedLocale)) {
    i18n.setLocale(saved as SupportedLocale);
  }

  watch(i18n.locale, (code) => {
    if (SUPPORTED_LOCALES.includes(code as SupportedLocale)) {
      localStorage.setItem(STORAGE_KEY, code);
    }
  });
});
