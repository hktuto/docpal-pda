import { spawnSync } from 'node:child_process';

// Bundled (production-style) Android build: CAPACITOR_SERVER_URL=off makes
// capacitor.config.ts omit server.url, so the WebView loads the assets in
// webDir (.output/public) instead of the dev server. Run `nuxt generate`
// first. Point the app at your hosted backend by building with
// NUXT_PUBLIC_API_BASE_URL set, e.g.:
//   NUXT_PUBLIC_API_BASE_URL=http://wms.internal:3002 pnpm cap:android
const env = { ...process.env, CAPACITOR_SERVER_URL: 'off' };

const sync = spawnSync('cap', ['sync', 'android'], { stdio: 'inherit', shell: true, env });
if (sync.status !== 0) process.exit(sync.status ?? 1);

const open = spawnSync('cap', ['open', 'android'], { stdio: 'inherit', shell: true, env });
if (open.status !== 0) process.exit(open.status ?? 1);
