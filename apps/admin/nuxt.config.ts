// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  ssr: false,
  devtools: { enabled: false },
  compatibilityDate: "2024-06-30",
  experimental: {
    appManifest: false,
  },
  app: {
    head: {
      title: "Warehouse Admin",
      link: [
        { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
        { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32x32.png" },
        { rel: "icon", type: "image/png", sizes: "16x16", href: "/favicon-16x16.png" },
        { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      ],
    },
  },
  css: ["~/assets/main.css"],
  // i18n comes from the shared layer (locales + LanguageSwitcher + persistence).
  extends: ["../../layers/i18n"],
  $development: {
    hooks: {
      // Same Nuxt 3.21 + Vite 7 ssr:false dev-server workaround as apps/web:
      // keep the client rollup input as a plain absolute string.
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
  runtimeConfig: {
    public: {
      apiBaseUrl: "http://localhost:3002", // override with NUXT_PUBLIC_API_BASE_URL
      // Print service base URL; empty = derive from apiBaseUrl host on port 9003.
      printBaseUrl: "http://192.168.5.116:9003", // override with NUXT_PUBLIC_PRINT_BASE_URL
    },
  },
});
