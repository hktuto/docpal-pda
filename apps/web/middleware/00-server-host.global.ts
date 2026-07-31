/**
 * Launcher guard for bundled builds — runs before auth.global.ts
 * (alphabetical order). On the bundled origin (release APK boot) the app is
 * only a launcher: without a chosen server host (or with ?picker=1), every
 * route redirects to the /server picker. The redirect to a chosen host
 * happens earlier in plugins/serverHost.client.ts.
 */
export default defineNuxtRouteMiddleware((to) => {
  if (!isBundledOrigin() || to.path === "/server") return;

  const forcePicker = new URLSearchParams(window.location.search).has("picker");
  if (forcePicker || !getEffectiveServerHost()) {
    return navigateTo("/server");
  }
});
