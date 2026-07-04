const STORAGE_KEY = "warehouse-locale";
const SUPPORTED_LOCALES = ["en-US", "zh-CN", "zh-HK"] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export function useLocalePreference() {
  const { locale, setLocale } = useI18n();

  function restore() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED_LOCALES.includes(saved as SupportedLocale)) {
      setLocale(saved as SupportedLocale);
    }
  }

  function persist(code: SupportedLocale) {
    localStorage.setItem(STORAGE_KEY, code);
  }

  watch(locale, (code) => {
    persist(code as SupportedLocale);
  });

  return {
    restore,
    persist,
  };
}
