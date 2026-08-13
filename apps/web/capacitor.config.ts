import type { CapacitorConfig } from '@capacitor/cli';

// Dev default: the WebView loads http://127.0.0.1:3103, which `adb reverse`
// tunnels to the dev machine's web dev server (see package.json
// "cap:android:proxy" — also tunnels :3002 for the backend API, so the
// default apiBaseUrl http://127.0.0.1:3002 works on-device too).
// 127.0.0.1, not localhost: some Android ROMs (NLS-MT95) fail to resolve
// "localhost" inside the WebView at all.
// Override with CAPACITOR_SERVER_URL. Production APKs (scripts/build-android-apk.mjs)
// pass the fixed web host here — the WebView loads the hosted app so web
// content updates with every deploy, and the Capacitor bridge (injected for
// exactly this origin) keeps the native plugins (hardware scanning) working.
// The WebView must never navigate to another origin: that outruns the bridge.
const envUrl = process.env.CAPACITOR_SERVER_URL;
const serverUrl = envUrl === 'off' ? undefined : (envUrl ?? 'http://127.0.0.1:3103');

const config: CapacitorConfig = {
  appId: 'com.docpal.warehousedemo',
  appName: 'Warehouse PDA',
  webDir: '.output/public',
  server: {
    // http scheme so LAN http:// API calls are not blocked as mixed content.
    androidScheme: 'http',
    ...(serverUrl ? { url: serverUrl, cleartext: true } : {}),
    // Bundled page shown when the WebView cannot load the app (web host down);
    // public/maintenance.html retries the configured app URL on a button press.
    errorPath: 'maintenance.html',
  },
};

export default config;
