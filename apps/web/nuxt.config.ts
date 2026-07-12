import path from "path";
import fs from "fs";

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
  hooks: {
    // Fallback workaround for `nuxt generate`: on Windows the prerendered HTML
    // can end up pointing at dev-only paths (`/@vite/client` and absolute
    // entry paths) instead of the hashed production assets. After generation we
    // rewrite every HTML file to use the real entry chunk captured during the
    // client build.
    close: async () => {
      console.log("[POST-PROCESS] Rewriting prerendered HTML...");
      const assetsPath = path.resolve(process.cwd(), ".nuxt/dist/client/entry-assets.json");
      if (!fs.existsSync(assetsPath)) return;

      const assets = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as {
        js?: string;
        css?: string;
      };
      if (!assets.js) return;

      const publicDir = path.resolve(process.cwd(), ".output/public");
      const htmlFiles: string[] = [];
      const collect = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            collect(full);
          } else if (entry.isFile() && entry.name.endsWith(".html")) {
            htmlFiles.push(full);
          }
        }
      };
      if (fs.existsSync(publicDir)) collect(publicDir);

      const entryJsPattern = /(src|href)="\/_nuxt\/[^"]*nuxt\/dist\/app\/entry\.js"/g;
      const viteClientPattern = /<script[^>]*src="\/_nuxt\/@[^"]*vite\/client"[^>]*><\/script>/g;

      for (const htmlFile of htmlFiles) {
        let html = fs.readFileSync(htmlFile, "utf-8");

        // Remove the dev-only vite client script.
        html = html.replace(viteClientPattern, "");

        // Replace any absolute/relative nuxt entry references with the hashed chunk.
        html = html.replace(entryJsPattern, `$1="/_nuxt/${assets.js}"`);

        // Ensure the entry CSS link is present.
        if (assets.css && !html.includes(`/_nuxt/${assets.css}`)) {
          html = html.replace(
            "</head>",
            `<link rel="stylesheet" href="/_nuxt/${assets.css}" crossorigin>\n</head>`
          );
        }

        fs.writeFileSync(htmlFile, html);
      }
    },
  },
  vite: {
    optimizeDeps: {
      // Exclude PGlite packages from optimization (they contain WASM files)
      exclude: ["@electric-sql/pglite"],
    },
    plugins: [
      {
        name: "capture-entry-assets",
        apply: "build",
        generateBundle(_options, bundle) {
          const assets: { js?: string; css?: string } = {};
          for (const [fileName, chunk] of Object.entries(bundle)) {
            if (chunk.type === "chunk") {
              if (
                chunk.isEntry &&
                chunk.facadeModuleId?.replace(/\\/g, "/").includes("nuxt/dist/app/entry.js")
              ) {
                assets.js = fileName.replace(/^_nuxt\//, "");
              }
            }
          }
          for (const [fileName, asset] of Object.entries(bundle)) {
            const baseName = fileName.replace(/^_nuxt\//, "");
            if (
              asset.type === "asset" &&
              baseName.startsWith("entry.") &&
              baseName.endsWith(".css")
            ) {
              assets.css = baseName;
            }
          }
          if (assets.js || assets.css) {
            const outDir = path.resolve(process.cwd(), ".nuxt/dist/client");
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(
              path.join(outDir, "entry-assets.json"),
              JSON.stringify(assets, null, 2)
            );
          }
        },
      },
    ],
  },
  runtimeConfig: {
    public: {
      warehouseAdapter: "api",    // "pglite" | "api"
      apiBaseUrl: "http://localhost:3001", // override with NUXT_PUBLIC_API_BASE_URL (device builds need a LAN-reachable host)
      seedPreset: "precalc",      // "default" (allocate on reset) | "precalc"
    },
  },
});
