import type { CapacitorConfig } from '@capacitor/cli';

// CAPACITOR_SERVER_URL is set by scripts/cap-android-dev.mjs for live reload:
// the WebView loads the dev server over LAN instead of bundled assets.
const serverUrl = process.env.CAPACITOR_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'com.docpal.warehousedemo',
  appName: 'Warehouse PDA',
  webDir: '.output/public',
  server: {
    // http scheme so LAN http:// API calls are not blocked as mixed content
    // (default https://localhost origin would also miss the API CORS allowlist).
    androidScheme: 'http',
    ...(serverUrl ? { url: serverUrl, cleartext: true } : {}),
  },
};

export default config;
