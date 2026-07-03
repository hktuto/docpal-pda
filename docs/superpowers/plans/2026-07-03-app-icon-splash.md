# App icon and splash screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate DocPal-branded Android launcher icons and splash screens from the existing `assets/logo.png` and `assets/logoWithName.png`, using `@capacitor/assets`.

**Architecture:** A small Node script uses `sharp` to produce the exact source files `@capacitor/assets` expects (`resources/icon-only.png`, `resources/icon-foreground.png`, `resources/icon-background.png`, `resources/splash.png`). Then `@capacitor/assets` generates the full Android resource tree.

**Tech Stack:** Node.js, `sharp`, `@capacitor/assets`, Capacitor Android project.

---

## File map

| File | Change |
|------|--------|
| `package.json` | Add dev dependencies `@capacitor/assets` and `sharp`; add helper scripts. |
| `scripts/generate-native-assets.mjs` | New script: prepares source PNGs in `resources/` from the two logo files and the teal background. |
| `resources/icon-only.png` | Generated full icon (logo on teal background), 1024×1024. |
| `resources/icon-foreground.png` | Generated adaptive-icon foreground (logo), 1024×1024. |
| `resources/icon-background.png` | Generated adaptive-icon background (solid teal), 1024×1024. |
| `resources/splash.png` | Generated splash screen, 2732×2732, logoWithName centered on teal. |
| `android/app/src/main/res/mipmap-*` | Regenerated launcher icons. |
| `android/app/src/main/res/mipmap-anydpi-v26/*` | Regenerated adaptive-icon XMLs. |
| `android/app/src/main/res/drawable*` | Regenerated splash screens for all densities and orientations. |

---

### Task 1: Add dependencies and helper scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dev dependencies**

Run:

```bash
pnpm add -D @capacitor/assets sharp
```

Expected: both packages install without errors.

- [ ] **Step 2: Add helper scripts**

Add to `package.json` inside `"scripts"`:

```json
    "assets:prepare": "node scripts/generate-native-assets.mjs",
    "assets:generate": "npx capacitor-assets generate --android --assetPath resources",
    "assets:android": "pnpm assets:prepare && pnpm assets:generate"
```

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
pnpm install
pnpm nuxt prepare
```

---

### Task 2: Write the asset-preparation script

**Files:**
- Create: `scripts/generate-native-assets.mjs`
- Create (generated): `resources/icon-only.png`, `resources/icon-foreground.png`, `resources/icon-background.png`, `resources/splash.png`

- [ ] **Step 1: Create the script**

```javascript
import { mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const sourceDir = join(root, "assets");
const outDir = join(root, "resources");

const TEAL = { r: 0, g: 191, b: 165, alpha: 1 };
const ICON_SIZE = 1024;
const SPLASH_SIZE = 2732;

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function solidBackground(width, height) {
  return sharp({
    create: { width, height, channels: 4, background: TEAL },
  }).png();
}

async function main() {
  await ensureDir(outDir);

  // Adaptive icon background: solid teal square
  await solidBackground(ICON_SIZE, ICON_SIZE).toFile(
    join(outDir, "icon-background.png")
  );

  // Adaptive icon foreground: logo scaled to fit, transparent background
  await sharp(join(sourceDir, "logo.png"))
    .resize(ICON_SIZE, ICON_SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(join(outDir, "icon-foreground.png"));

  // Legacy / iOS-style icon: logo centered on teal background
  const logoBuffer = await sharp(join(sourceDir, "logo.png"))
    .resize(ICON_SIZE, ICON_SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  await solidBackground(ICON_SIZE, ICON_SIZE)
    .composite([{ input: logoBuffer, gravity: "center" }])
    .toFile(join(outDir, "icon-only.png"));

  // Splash screen: logoWithName centered on teal background
  const logoWithNameMeta = await sharp(join(sourceDir, "logoWithName.png")).metadata();
  const maxSplashLogoWidth = Math.round(SPLASH_SIZE * 0.7);
  const scale = Math.min(1, maxSplashLogoWidth / (logoWithNameMeta.width ?? 1));
  const splashLogoWidth = Math.round((logoWithNameMeta.width ?? 1) * scale);
  const splashLogoHeight = Math.round((logoWithNameMeta.height ?? 1) * scale);

  const splashLogoBuffer = await sharp(join(sourceDir, "logoWithName.png"))
    .resize(splashLogoWidth, splashLogoHeight, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: SPLASH_SIZE,
      height: SPLASH_SIZE,
      channels: 4,
      background: TEAL,
    },
  })
    .composite([{ input: splashLogoBuffer, gravity: "center" }])
    .png()
    .toFile(join(outDir, "splash.png"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the script**

Run:

```bash
pnpm assets:prepare
```

Expected: `resources/` is created with the four PNG files. No errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/generate-native-assets.mjs resources/
git commit -m "build(assets): add native asset preparation script and source images"
```

---

### Task 3: Generate Android resources

**Files:**
- Modify: `android/app/src/main/res/*` (regenerated)

- [ ] **Step 1: Generate Android icons and splash screens**

Run:

```bash
pnpm assets:generate
```

Which runs:

```bash
npx capacitor-assets generate --android --assetPath resources
```

Expected: the command completes and updates files under `android/app/src/main/res/`.

- [ ] **Step 2: Verify expected outputs exist**

Check that the following files exist and have recent timestamps:

```bash
ls -la android/app/src/main/res/mipmap-*/ic_launcher*.png
ls -la android/app/src/main/res/mipmap-anydpi-v26/ic_launcher*.xml
ls -la android/app/src/main/res/drawable*/splash.png
```

Expected: all listed files exist.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/res
git commit -m "feat(android): generate DocPal launcher icons and splash screens"
```

---

### Task 4: Build verification

- [ ] **Step 1: Type check and static build**

Run:

```bash
pnpm nuxt prepare
pnpm generate
```

Expected: both complete without errors.

- [ ] **Step 2: Sync native project**

Run:

```bash
npx cap sync android
```

Expected: sync completes without errors.

- [ ] **Step 3: Android unit tests**

Run:

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:testDebugUnitTest
```

Expected: tests pass.

- [ ] **Step 4: Install debug APK (optional, manual)**

If a device is connected:

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:installDebug
```

Then verify on the device:
- Launcher icon shows the DocPal mark.
- Splash screen shows the DocPal logo with name on a teal background.

---

## Plan self-review

- **Spec coverage:**
  - App icon from `assets/logo.png` → Task 2 creates icon-only/foreground/background.
  - Splash screen from `assets/logoWithName.png` on teal → Task 2 creates splash.png.
  - Android-only generation → Task 3 uses `--android`.
  - Background color `#00bfa5` → used in Task 2 script.
- **Placeholder scan:** No TBD/TODO; all commands and code are exact.
- **Type consistency:** Script uses ESM `.mjs`; `sharp` and `@capacitor/assets` are dev dependencies.
