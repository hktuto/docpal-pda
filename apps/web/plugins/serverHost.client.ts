/**
 * Boot redirect for bundled builds. The release APK boots from the bundled
 * assets (origin http://localhost); this plugin hard-redirects the WebView to
 * the host chosen on the /server picker page before the app renders. When no
 * host is chosen yet (or ?picker=1 asks for the picker), routing to /server
 * is left to middleware/00-server-host.global.ts. No-op everywhere else
 * (browser dev, live reload, remote-served app), so the dev workflow in
 * capacitor.config.ts is untouched.
 */
export default defineNuxtPlugin(() => {
  if (!isBundledOrigin()) return;

  const forcePicker = new URLSearchParams(window.location.search).has("picker");
  const savedHost = getEffectiveServerHost();
  if (forcePicker || !savedHost) return;

  window.location.replace(savedHost);
});
