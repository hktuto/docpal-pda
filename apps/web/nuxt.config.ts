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
      title: "Warehouse PDA",
      viewport: "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no",
    },
  },
  css: ["~/assets/css/main.scss"],
  // i18n config, locales, LanguageSwitcher, and locale persistence come from
  // the shared layer (also used by apps/admin).
  extends: ["../../layers/i18n"],
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
  runtimeConfig: {
    public: {
      // 127.0.0.1, not localhost: some Android ROMs (NLS-MT95) fail to resolve
      // "localhost" inside the WebView, breaking adb-reverse API access.
      apiBaseUrl: "http://127.0.0.1:3002", // override with NUXT_PUBLIC_API_BASE_URL (device builds need a LAN-reachable host)
      apiCache: "on", // set NUXT_PUBLIC_API_CACHE=off to disable the client-side GET cache entirely
      // Set NUXT_PUBLIC_SHOW_LOCAL_SERVER_HOST=1 to add a "Local (dev)"
      // (http://127.0.0.1:3002) entry to the /server backend picker in bundled
      // builds; always on under the dev server.
      showLocalServerHost: "",
    },
  },
});
