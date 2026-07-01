// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  ssr: false,
  devtools: { enabled: true },
  compatibilityDate: "2024-06-30",
  app: {
    head: {
      title: "Warehouse Web Demo",
      viewport: "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no",
    },
  },
  css: ["~/assets/css/main.css"],
  vite: {
    optimizeDeps: {
      // Exclude PGlite packages from optimization (they contain WASM files)
      exclude: [
        '@electric-sql/pglite',
        '@electric-sql/pglite/live',
      ],

    }
  }
});
