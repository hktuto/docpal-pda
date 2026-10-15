import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// Production release APK build: generates the web assets, points the WebView
// at the one fixed web host via capacitor server.url — the Capacitor bridge is
// injected for exactly that origin, so hardware scanning and the other native
// plugins keep working while web content still updates with every deploy.
// The /server picker inside the app only chooses which BACKEND the app
// calls; it never navigates the WebView. The app URL is also stamped into
// the bundled maintenance page as its retry target, the APK is signed (keystore
// auto-generated on first run), and the APK plus a version.json are published
// into apps/backend/public/apk/ for the admin download page.
//
// Multi-region: set APK_REGION (hk|sz|gz|sh|bj) to select the target region.
// The region determines the backend domain, app name, and output file name.
// Output: warehouse-pda-{region}.apk + version-{region}.json
//
// Usage:
//   pnpm build:apk                          # builds the default region (hk)
//   APK_REGION=gz pnpm build:apk            # builds the GZ region
//   APK_REGION=sz APK_WEB_URL=https://custom:9000 pnpm build:apk  # override URL

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webDir, '../..');
const androidDir = join(webDir, 'android');
const gradleFile = join(androidDir, 'app/build.gradle');
const stringsFile = join(androidDir, 'app/src/main/res/values/strings.xml');
const apkOutDir = join(repoRoot, 'apps/backend/public/apk');
const regionsFile = join(import.meta.dirname, 'regions.json');

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...options });
  if (result.status !== 0) {
    console.error(`\nCommand failed: ${cmd} ${args.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}

// a. Resolve region config from regions.json.
const regions = JSON.parse(readFileSync(regionsFile, 'utf8'));
const region = process.env.APK_REGION || 'hk';
const regionConfig = regions[region];
if (!regionConfig) {
  console.error(`Unknown APK_REGION "${region}" — valid regions: ${Object.keys(regions).join(', ')}`);
  process.exit(1);
}
console.log(`Region: ${region.toUpperCase()} (${regionConfig.appName})`);

// b. Resolve the WebView URL. APK_WEB_URL overrides the full URL; otherwise
//    build from the region domain on port 9000.
const appUrl = process.env.APK_WEB_URL || `https://${regionConfig.domain}:9000`;
console.log(`App URL (WebView + maintenance page): ${appUrl}`);

// c. Patch the app name in capacitor.config.ts and strings.xml.
const capacitorConfigPath = join(webDir, 'capacitor.config.ts');
const capacitorConfig = readFileSync(capacitorConfigPath, 'utf8');
const patchedCapacitor = capacitorConfig.replace(
  /appName:\s*['"]([^'"]+)['"]/,
  `appName: '${regionConfig.appName}'`,
);
if (patchedCapacitor === capacitorConfig) {
  console.error(`appName not found in ${capacitorConfigPath} — cannot patch.`);
  process.exit(1);
}
writeFileSync(capacitorConfigPath, patchedCapacitor);

const stringsXml = readFileSync(stringsFile, 'utf8');
const patchedStrings = stringsXml
  .replace(/<string name="app_name">[^<]+<\/string>/, `<string name="app_name">${regionConfig.appName}</string>`)
  .replace(/<string name="title_activity_main">[^<]+<\/string>/, `<string name="title_activity_main">${regionConfig.appName}</string>`);
writeFileSync(stringsFile, patchedStrings);
console.log(`App name patched: ${regionConfig.appName}`);

// d. The web dev server pollutes .nuxt/dist/client with dev URLs — refuse to
//    generate while it is running.
try {
  await fetch('http://127.0.0.1:3104', { signal: AbortSignal.timeout(1500) });
  console.error('The web dev server is running on :3104 — stop it before running this build (it pollutes .nuxt/dist/client with dev URLs).');
  process.exit(1);
} catch {
  // Connection refused / timeout: no dev server, good to go.
}

// e. Static web export.
run('pnpm', ['--filter', '@warehouse/pda', 'generate'], { cwd: repoRoot });

// e2. The maintenance page is bundled into the APK and cannot read
// capacitor.config at runtime — stamp the app URL in as its retry target
// (the source file keeps the dev default http://localhost:3104).
const maintenanceFile = join(webDir, '.output/public/maintenance.html');
const maintenanceMarker = "var DEFAULT_URL = 'http://localhost:3104';";
const maintenance = readFileSync(maintenanceFile, 'utf8');
if (!maintenance.includes(maintenanceMarker)) {
  console.error(`Default-URL marker not found in ${maintenanceFile} — update the marker or the page.`);
  process.exit(1);
}
writeFileSync(maintenanceFile, maintenance.replace(maintenanceMarker, `var DEFAULT_URL = '${appUrl}';`));
console.log(`Maintenance page default URL: ${appUrl}`);

// f. Auto-increment versionCode so Android treats the new APK as an update.
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

// g. Signing: generate a keystore + keystore.properties on first run. Keep
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

// h. Sync the generated assets into the native project with server.url set to
// the fixed web host (CAPACITOR_SERVER_URL → server.url, capacitor.config.ts).
// The WebView boots directly from the hosted app, so the Capacitor bridge is
// injected on that origin and the native plugins (hardware scanning) work;
// the /server picker only switches the backend API base URL at runtime.
run('pnpm', ['exec', 'cap', 'sync', 'android'], { cwd: webDir, env: { ...process.env, CAPACITOR_SERVER_URL: appUrl } });

// i. Assemble the signed release APK.
const androidStudioJbr = 'C:/Program Files/Android/Android Studio/jbr';
const javaHome = process.env.JAVA_HOME || (existsSync(androidStudioJbr) ? androidStudioJbr : undefined);
const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
run(gradlew, ['assembleRelease'], {
  cwd: androidDir,
  env: { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) },
});

// j. Publish the APK + version.json for the backend's admin download route.
const apkFileName = `warehouse-pda-${region}.apk`;
const versionFileName = `version-${region}.json`;
const apkSource = join(androidDir, 'app/build/outputs/apk/release/app-release.apk');
if (!existsSync(apkSource)) {
  console.error(`APK not found at ${apkSource}`);
  process.exit(1);
}
mkdirSync(apkOutDir, { recursive: true });
const apkTarget = join(apkOutDir, apkFileName);
copyFileSync(apkSource, apkTarget);
writeFileSync(
  join(apkOutDir, versionFileName),
  JSON.stringify(
    { versionName, versionCode, webUrl: appUrl, builtAt: new Date().toISOString(), fileName: apkFileName, region },
    null,
    2,
  ) + '\n',
);
console.log(`\nPublished ${apkTarget} — version ${versionName} (${versionCode}), WebView URL ${appUrl}`);
