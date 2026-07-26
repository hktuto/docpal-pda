// Shared i18n layer for apps/web and apps/admin.
// Locale files, vueI18n options, the LanguageSwitcher component, and the
// locale-persistence plugin all live here; extending apps only need `extends`.
// https://i18n.nuxtjs.org/docs/guide/layers
export default defineNuxtConfig({
  modules: ["@nuxtjs/i18n"],
  i18n: {
    restructureDir: "",
    strategy: "no_prefix",
    defaultLocale: "zh-HK",
    locales: [
      { code: "en-US", name: "English", file: "en-US.ts" },
      { code: "zh-CN", name: "简体中文", file: "zh-CN.ts" },
      { code: "zh-HK", name: "繁體中文（香港）", file: "zh-HK.ts" },
    ],
    langDir: "i18n/locales/",
    detectBrowserLanguage: false,
    vueI18n: "./i18n/config.ts",
  },
});
