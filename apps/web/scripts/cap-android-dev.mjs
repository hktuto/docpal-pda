import { networkInterfaces } from 'node:os';
import { spawnSync } from 'node:child_process';

function getLocalIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const ip = getLocalIp();
const url = `http://${ip}:3000`;

console.log(`[cap-android-dev] Using dev server: ${url}`);

const env = { ...process.env, CAPACITOR_SERVER_URL: url };

const sync = spawnSync('cap', ['sync', 'android'], { stdio: 'inherit', shell: true, env });
if (sync.status !== 0) process.exit(sync.status ?? 1);

const open = spawnSync('cap', ['open', 'android'], { stdio: 'inherit', shell: true, env });
if (open.status !== 0) process.exit(open.status ?? 1);
