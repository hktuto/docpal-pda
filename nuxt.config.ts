import path from "path";

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  ssr: false,
  devtools: { enabled: true },
  compatibilityDate: "2024-06-30",
  experimental: {
    appManifest: false,
  },
  app: {
    head: {
      title: "Warehouse Web Demo",
      viewport: "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no",
    },
  },
  css: ["~/assets/css/main.css"],
  $development:{
    hooks: {
      // Workaround for Nuxt 3.21 + Vite 7 bug where `ssr: false` dev server
      // crashes with "No entry found in rollupOptions.input" when the client
      // input is object-form `{ entry }` instead of a string.
      // https://github.com/nuxt/nuxt/issues/35466
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
          config.build!.rollupOptions!.input = path
            .relative(process.cwd(), input.entry)
            .replace(/\\/g, "/");
        }
      },
    },
  },


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
