// Standalone presentation build of the warehouse PDA UI.
// Runs entirely in the browser using PGlite (in-memory mock data) — no API server required.
export default defineNuxtConfig({
  ssr: false,
  devtools: { enabled: false },
  compatibilityDate: "2024-06-30",
  experimental: {
    appManifest: false,
  },
  app: {
    head: {
      title: "Warehouse PDA (Presentation)",
      viewport: "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no",
    },
  },
  css: ["~/assets/css/main.css"],
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
  $development: {
    hooks: {
      // Workaround for Nuxt 3.21 + Vite 7 bug where `ssr: false` dev server
      // crashes with "No entry found in rollupOptions.input" when the client
      // input is object-form `{ entry }` instead of a string.
      // https://github.com/nuxt/nuxt/issues/35466
      // Keep the ABSOLUTE path as a plain string: a relative input makes Vite
      // emit a normalized `/node_modules/.pnpm/...` URL that doesn't resolve
      // from the app root in the pnpm monorepo (the .pnpm store lives at the
      // workspace root), while an absolute id is served via `/_nuxt/@fs/...`.
      "vite:extendConfig": (config, { isClient }) => {
        if (!isClient || !process.argv.includes("dev")) return;
        const input = config.build?.rollupOptions?.input;
        if (
          input &&
          typeof input === "object" &&
          !Array.isArray(input) &&
          "entry" in input &&
          typeof input.entry === "string"
        ) {
          config.build!.rollupOptions!.input = input.entry;
        }
      },
    },
  },
  vite: {
    optimizeDeps: {
      // Exclude PGlite packages from optimization (they contain WASM files)
      exclude: ["@electric-sql/pglite"],
    },
  },
  runtimeConfig: {
    public: {
      warehouseAdapter: "pglite", // always use the browser mock database
      apiBaseUrl: "",             // unused in pglite mode
      seedPreset: "precalc",      // "default" (allocate on reset) | "precalc"
    },
  },
});
