import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Tunnel the PDA's localhost ports back to this dev machine, so the
// Capacitor WebView can load http://localhost:3103 (web dev server) and
// call http://localhost:3002 (backend API) on-device.
// NOTE: `adb reverse` does not survive device reboots / reconnects —
// re-run this script after plugging the device back in.

function findAdb() {
  const onPath = spawnSync('adb', ['--version'], { shell: true });
  if (onPath.status === 0) return 'adb';

  const localProps = new URL('../android/local.properties', import.meta.url).pathname
    .replace(/^\/([A-Za-z]:)/, '$1'); // windows drive letter
  if (existsSync(localProps)) {
    const match = readFileSync(localProps, 'utf8').match(/^sdk\.dir=(.*)$/m);
    if (match) {
      const sdkDir = match[1].trim().replace(/\\\\/g, '/').replace(/\\:/g, ':');
      for (const exe of [join(sdkDir, 'platform-tools', 'adb.exe'), join(sdkDir, 'platform-tools', 'adb')]) {
        if (existsSync(exe)) return `"${exe}"`;
      }
    }
  }
  console.error('[cap-android-proxy] adb not found on PATH and no Android SDK in android/local.properties');
  process.exit(1);
}

const adb = findAdb();
for (const port of [3103, 3002]) {
  const res = spawnSync(adb, ['reverse', `tcp:${port}`, `tcp:${port}`], { stdio: 'inherit', shell: true });
  if (res.status !== 0) process.exit(res.status ?? 1);
}
console.log('[cap-android-proxy] adb reverse tcp:3103 + tcp:3002 active');
