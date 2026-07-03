# App icon and splash screen

## Goal

Replace the default Capacitor launcher icon and splash screens with DocPal-branded assets for the Android build.

## Scope

- Android only (iOS platform is not configured).
- Update launcher icons.
- Update splash screens.

## Source assets

| File | Purpose | Notes |
|------|---------|-------|
| `assets/logo.png` | Launcher icon | 319×319 px square mark. Will be upscaled by the generator. |
| `assets/logoWithName.png` | Splash screen | 1288×313 px wide logo with text. |

## Design

- **Background color:** `#00bfa5` (app primary teal) for both the Android adaptive-icon background and the splash-screen background.
- **App icon:** `assets/logo.png` centered on the teal background. Generate:
  - `mipmap-mdpi/ic_launcher.png` / `ic_launcher_round.png` / `ic_launcher_foreground.png`
  - `mipmap-hdpi/...`
  - `mipmap-xhdpi/...`
  - `mipmap-xxhdpi/...`
  - `mipmap-xxxhdpi/...`
  - `mipmap-anydpi-v26/ic_launcher.xml` / `ic_launcher_round.xml`
  - `drawable/ic_launcher_background.xml`
  - `values/ic_launcher_background.xml`
- **Splash screen:** `assets/logoWithName.png` centered on the teal background. Generate:
  - `drawable/splash.png`
  - `drawable-land-hdpi/mdpi/xhdpi/xxhdpi/xxxhdpi/splash.png`
  - `drawable-port-hdpi/mdpi/xhdpi/xxhdpi/xxxhdpi/splash.png`
- **Layout:** Logo centered with enough safe margin so no content is clipped on smaller screens.

## Tooling

Use the official `@capacitor/assets` package. It is the standard Capacitor workflow and makes updates easy when the source files change.

## Files to modify / create

- Install dev dependency: `@capacitor/assets`
- Source files remain as-is: `assets/logo.png`, `assets/logoWithName.png`
- Generated files under `android/app/src/main/res/` will be overwritten.
- May update `capacitor.config.ts` if required by the tool (usually not needed for Android assets).

## Testing

1. `pnpm nuxt prepare` — no type errors.
2. `pnpm generate` — builds successfully.
3. `npx cap sync android` — syncs web assets.
4. Build debug APK and install on device:
   ```bash
   cd android
   export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
   export PATH="$JAVA_HOME/bin:$PATH"
   ./gradlew :app:installDebug
   ```
5. Verify:
   - Launcher icon shows the DocPal mark.
   - Splash screen shows the DocPal logo with name on teal background.
   - No default Capacitor icon remains.

## Open questions / deferred

- iOS assets are out of scope.
- No animated splash or dark-mode variant.
