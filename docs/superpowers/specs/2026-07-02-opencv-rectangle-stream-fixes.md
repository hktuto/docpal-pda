# OpenCV Rectangle Stream — Post-Implementation Fixes

Date: 2026-07-02

## 1. White screen / broken dev server (`pnpm dev`)

### Problem
- `pnpm dev` served an HTML page whose `<script>` and `<link>` tags pointed at absolute Windows paths, e.g.:
  ```html
  <script src="/_nuxt/D:/work/docpal/warehouse-pda/node_modules/.../entry.js"></script>
  ```
- The browser could not load those URLs, so the Vue app never mounted and the page stayed blank.

### Root cause
The existing workaround for [Nuxt #35466](https://github.com/nuxt/nuxt/issues/35466) was flattening the object-form rollup input into an **absolute** string:

```ts
config.build!.rollupOptions!.input = input.entry; // input.entry is absolute on Windows
```

This avoided the `No entry found in rollupOptions.input` crash, but turned the entry URL into an absolute path that Vite’s dev server exposed verbatim.

### Fix
In `nuxt.config.ts`:

1. Move the hook into `$development` so it never runs during `nuxt generate`.
2. Convert the absolute entry path to a project-relative, forward-slash path:

```ts
import path from "path";

export default defineNuxtConfig({
  // ...
  $development: {
    hooks: {
      "vite:extendConfig": (config, { isClient }) => {
        if (!isClient || !process.argv.includes("dev")) return;
        const input = config.build?.rollupOptions?.input;
        if (
          input &&
          typeof input === "object" &&
          !Array.isArray(input) &&
          "entry" in input &&
          typeof input.entry === "string"
        ) {
          config.build!.rollupOptions!.input = path
            .relative(process.cwd(), input.entry)
            .replace(/\\/g, "/");
        }
      },
    },
  },
});
```

### Result
- `pnpm dev` now serves correct relative URLs.
- `pnpm generate` is unaffected because the hook only applies in development mode.

---

## 2. Android crash / page reload on second capture

### Problem
- Capturing a rectangle worked once, but the second capture crashed the app.
- Sometimes the web view reloaded and lost its state after returning from the picker.

### Root cause
The cropped image was passed back to the web layer as a **base64 JPEG string** inside the plugin result `Intent`. High-resolution crops easily exceed the Android binder transaction limit (~1 MB), causing a `TransactionTooLargeException` and process death.

### Fix
Return only a small file path string and save the crop to the app cache directory on the native side.

#### Native side

- `RectangleCropper.java` gained file helpers:
  - `cropToFile(...)` — perspective-crop a rectangle and save it as a JPEG.
  - `matToFile(...)` — save a full Mat as a JPEG.

- `RectangleCameraActivity.java`:
  - Tap capture: `cropToFile(...)` → return `imagePath`.
  - Shutter capture: `matToFile(...)` → full-resolution temp file → launch picker.
  - Added `decodeCapturedImage(...)` to handle both `YUV_420_888` and `JPEG` formats from `ImageCapture`.

- `RectanglePickerActivity.java`:
  - Selected crop is saved with `cropToFile(...)` and returned as `imagePath`.

- `RectangleDetectionPlugin.java`:
  - Reads `imagePath` from the result intent and passes it to the web layer.

#### Web side

- `composables/useRectangleDetection.ts`:
  - `CameraStreamCaptureResult` now exposes `imagePath: string` instead of `base64Image`.

- `pages/opencv-rectangle-demo.vue`:
  - Displays the captured image with `Capacitor.convertFileSrc(capture.imagePath)`.

### Result
- No base64 data crosses the Capacitor bridge.
- Multiple consecutive captures no longer crash.
- The web view keeps its state after the picker returns.

---

## 3. Theme crash when launching `RectangleCameraActivity`

### Problem
After the activity changes, launching the stream activity crashed with:

```
IllegalStateException: You need to use a Theme.AppCompat theme (or descendant) with this activity.
```

### Fix
Changed both `RectangleCameraActivity` and `RectanglePickerActivity` to extend `androidx.activity.ComponentActivity` instead of `AppCompatActivity`. This keeps the `LifecycleOwner` required by CameraX without enforcing an AppCompat theme.

---

## Files changed

- `nuxt.config.ts`
- `composables/useRectangleDetection.ts`
- `pages/opencv-rectangle-demo.vue`
- `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java`
- `android/app/src/main/java/com/docpal/warehousedemo/RectanglePickerActivity.java`
- `android/app/src/main/java/com/docpal/warehousedemo/RectangleCropper.java`
- `android/app/src/main/java/com/docpal/warehousedemo/RectangleDetectionPlugin.java`

## Verification

```bash
# Dev server
pnpm dev
# Open the URL and confirm the page loads instead of showing a white screen.

# Android build + install
pnpm generate
npx cap sync android
cd android
./gradlew :app:assembleDebug :app:installDebug
```

On device:
1. Navigate to **OpenCV Rectangle Stream**.
2. Tap **Start camera stream** — preview should appear.
3. Tap a rectangle — captured crop displays.
4. Tap shutter, pick a rectangle — captured crop displays.
5. Repeat captures — app should not crash or reload.
