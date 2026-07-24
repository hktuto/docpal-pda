import type { CapacitorConfig } from '@capacitor/cli';

// Dev default: the WebView loads http://localhost:3000, which `adb reverse`
// tunnels to the dev machine's web dev server (see package.json
// "cap:android:proxy" — also tunnels :3002 for the backend API, so the
// default apiBaseUrl http://localhost:3002 works on-device too).
// Override with CAPACITOR_SERVER_URL; set CAPACITOR_SERVER_URL=off for
// production bundled builds (WebView loads the assets in webDir instead).
const envUrl = process.env.CAPACITOR_SERVER_URL;
const serverUrl = envUrl === 'off' ? undefined : (envUrl ?? 'http://localhost:3000');

const config: CapacitorConfig = {
  appId: 'com.docpal.warehousedemo',
  appName: 'Warehouse PDA',
  webDir: '.output/public',
  server: {
    // http scheme so LAN http:// API calls are not blocked as mixed content
    // (default https://localhost origin would also miss the API CORS allowlist).
    androidScheme: 'http',
    ...(serverUrl ? { url: serverUrl, cleartext: true } : {}),
    // Bundled page shown when the WebView cannot load the app (dev server
    // down); public/maintenance.html auto-retries and offers a server-URL
    // override that navigates the WebView to another host on the fly.
    errorPath: 'maintenance.html',
    // POC: let the maintenance-page override navigate the WebView to any
    // host (otherwise non-app origins open in the external browser).
    allowNavigation: ['*'],
  },
};

export default config;
