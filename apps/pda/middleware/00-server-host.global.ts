import { Capacitor } from "@capacitor/core";

/**
 * Backend-picker guard for the native app — runs before auth.global.ts
 * (alphabetical order). Until a backend is chosen on the /server picker (or
 * ?picker=1 asks for it), every route redirects there. The chosen API base
 * URL is applied by getApiBaseUrl() (utils/serverHost.ts). Skipped in the
 * browser and under the dev server, where the runtime-config apiBaseUrl
 * default is used directly.
 */
export default defineNuxtRouteMiddleware((to) => {
  if (import.meta.dev || !Capacitor.isNativePlatform() || to.path === "/server") return;

  const forcePicker = new URLSearchParams(window.location.search).has("picker");
  if (forcePicker || !getSavedServerHost()) {
    return navigateTo("/server");
  }
});
