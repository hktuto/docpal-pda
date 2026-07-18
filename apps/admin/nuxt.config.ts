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
    },
  },
  css: ["~/assets/main.css"],
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
    },
  },
});
