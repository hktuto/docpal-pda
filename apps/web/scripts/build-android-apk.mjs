import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// Production release APK build: generates the web assets, stamps
// PRODUCTION_URL (from the root .env) into the bundled maintenance page as
// its last-resort retry URL, signs the release APK (auto-generating a
// keystore on first run), and publishes the APK plus a version.json into
// apps/backend/public/apk/ for the admin download page. The APK itself boots
// bundled and lets the user pick the environment on the /server page, so it
// is not tied to PRODUCTION_URL.
// Usage:
//   pnpm build:apk

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webDir, '../..');
const androidDir = join(webDir, 'android');
const gradleFile = join(androidDir, 'app/build.gradle');
const apkOutDir = join(repoRoot, 'apps/backend/public/apk');

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...options });
  if (result.status !== 0) {
    console.error(`\nCommand failed: ${cmd} ${args.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}

// a. PRODUCTION_URL from the root .env (schemeless host → https://).
const envFile = join(repoRoot, '.env');
let productionUrl;
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*PRODUCTION_URL\s*=\s*(.+?)\s*$/);
    if (match && !line.trimStart().startsWith('#')) {
      productionUrl = match[1];
      break;
    }
  }
}
if (!productionUrl) {
  console.error('PRODUCTION_URL is not set in the root .env — set it to the production host (e.g. mobile-wms-admin.wclsolution.com).');
  process.exit(1);
}
const webUrl = /^https?:\/\//.test(productionUrl) ? productionUrl : `https://${productionUrl}`;
console.log(`Production fallback URL (maintenance page): ${webUrl}`);

// b. The web dev server pollutes .nuxt/dist/client with dev URLs — refuse to
// generate while it is running.
try {
  await fetch('http://127.0.0.1:3000', { signal: AbortSignal.timeout(1500) });
  console.error('The web dev server is running on :3000 — stop it before running this build (it pollutes .nuxt/dist/client with dev URLs).');
  process.exit(1);
} catch {
  // Connection refused / timeout: no dev server, good to go.
}

// c. Static web export.
run('pnpm', ['--filter', '@warehouse/web', 'generate'], { cwd: repoRoot });

// c2. The maintenance page is bundled into the APK and cannot read
// capacitor.config at runtime — stamp the production URL in as its default
// retry target (the source file keeps the dev default http://localhost:3000).
const maintenanceFile = join(webDir, '.output/public/maintenance.html');
const maintenanceMarker = "var DEFAULT_URL = 'http://localhost:3000';";
const maintenance = readFileSync(maintenanceFile, 'utf8');
if (!maintenance.includes(maintenanceMarker)) {
  console.error(`Default-URL marker not found in ${maintenanceFile} — update the marker or the page.`);
  process.exit(1);
}
writeFileSync(maintenanceFile, maintenance.replace(maintenanceMarker, `var DEFAULT_URL = '${webUrl}';`));
console.log(`Maintenance page default URL: ${webUrl}`);

// d. Auto-increment versionCode so Android treats the new APK as an update.
const gradle = readFileSync(gradleFile, 'utf8');
const codeMatch = gradle.match(/versionCode (\d+)/);
const nameMatch = gradle.match(/versionName "([^"]+)"/);
if (!codeMatch) {
  console.error(`versionCode not found in ${gradleFile}`);
  process.exit(1);
}
const versionCode = Number(codeMatch[1]) + 1;
const versionName = nameMatch ? nameMatch[1] : '1.0';
writeFileSync(gradleFile, gradle.replace(/versionCode \d+/, `versionCode ${versionCode}`));
console.log(`Version: ${versionName} (versionCode ${versionCode})`);

// e. Signing: generate a keystore + keystore.properties on first run. Keep
// both — Android only installs an update when the signature matches.
const keystorePropsPath = join(androidDir, 'keystore.properties');
if (!existsSync(keystorePropsPath)) {
  const storePassword = randomBytes(16).toString('hex');
  const keyPassword = randomBytes(16).toString('hex');
  const jbrKeytool = 'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\keytool.exe';
  const keytool = process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool')
    : existsSync(jbrKeytool)
      ? jbrKeytool
      : 'keytool';
  run(keytool, [
    '-genkeypair', '-v',
    '-storetype', 'JKS',
    '-keystore', join(androidDir, 'app/warehouse-release.keystore'),
    '-alias', 'warehouse',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10950',
    '-storepass', storePassword, '-keypass', keyPassword,
    '-dname', 'CN=Warehouse PDA, OU=IT, O=DocPal, L=Hong Kong, ST=HK, C=HK',
  ], { shell: false });
  writeFileSync(
    keystorePropsPath,
    `storeFile=warehouse-release.keystore\nstorePassword=${storePassword}\nkeyAlias=warehouse\nkeyPassword=${keyPassword}\n`,
  );
  console.log(`Generated a new release keystore at ${join(androidDir, 'app/warehouse-release.keystore')}`);
  console.log('Keep keystore.properties and the keystore safe — re-installs need the same signature.');
}

// f. Sync the generated assets into the native project as a bundled build
// (CAPACITOR_SERVER_URL=off → no server.url). The WebView boots from the
// bundled assets and the plugins/serverHost.client.ts boot redirect sends it
// to the host chosen on the /server picker page, so one APK serves every
// environment (capacitor.config.ts maps CAPACITOR_SERVER_URL → server.url).
run('cap', ['sync', 'android'], { cwd: webDir, env: { ...process.env, CAPACITOR_SERVER_URL: 'off' } });

// g. Assemble the signed release APK.
const androidStudioJbr = 'C:/Program Files/Android/Android Studio/jbr';
const javaHome = process.env.JAVA_HOME || (existsSync(androidStudioJbr) ? androidStudioJbr : undefined);
const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
run(gradlew, ['assembleRelease'], {
  cwd: androidDir,
  env: { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) },
});

// h. Publish the APK + version.json for the backend's admin download route.
const apkSource = join(androidDir, 'app/build/outputs/apk/release/app-release.apk');
if (!existsSync(apkSource)) {
  console.error(`APK not found at ${apkSource}`);
  process.exit(1);
}
mkdirSync(apkOutDir, { recursive: true });
const apkTarget = join(apkOutDir, 'warehouse-pda.apk');
copyFileSync(apkSource, apkTarget);
writeFileSync(
  join(apkOutDir, 'version.json'),
  JSON.stringify(
    { versionName, versionCode, webUrl, builtAt: new Date().toISOString(), fileName: 'warehouse-pda.apk' },
    null,
    2,
  ) + '\n',
);
console.log(`\nPublished ${apkTarget} — version ${versionName} (${versionCode}), WebView URL ${webUrl}`);
