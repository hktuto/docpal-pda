// Shared app-update layer for apps/pda and apps/admin.
// The <AppUpdate /> component (toast when a new build is available) and the
// app-manifest polling config both live here; extending apps only need
// `extends` and to mount <AppUpdate /> in app.vue.
export default defineNuxtConfig({
  experimental: {
    appManifest: true,
    checkOutdatedBuildInterval: 60_000,
  },
});
