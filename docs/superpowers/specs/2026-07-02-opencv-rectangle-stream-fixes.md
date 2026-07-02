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

## 4. Cropped image mirrored and rotated 90° counter-clockwise

### Problem
After capturing or picking a rectangle, the cropped image returned to the web layer was horizontally flipped and rotated 90° counter-clockwise.

### Root cause
`RectangleCropper.orderPoints(...)` used `x - y` to distinguish the remaining two corners after sum-based selection. In Android image coordinates (origin top-left, y increasing downward) the correct discriminator is `y - x`:

- `top-right` has the **smallest** `y - x`.
- `bottom-left` has the **largest** `y - x`.

Using `x - y` reversed those two corners. The resulting perspective transform mapped the rectangle's top edge to its left edge and its left edge to its top edge, producing the mirror + rotation symptom.

### Fix
In `RectangleCropper.java`:

```java
// top-right has the smallest (y - x), bottom-left the largest.
java.util.Arrays.sort(sorted, (a, b) -> Double.compare(a.y - a.x, b.y - b.x));
Point topRight = sorted[0];
Point bottomLeft = sorted[3];
```

Also added a unit test (`RectangleCropperOrderPointsTest`) covering axis-aligned and rotated rectangles.

### Result
The perspective crop now maps the detected corners to the correct output corners, so the returned crop is upright and not mirrored.

---

## 5. Cropped image colors are wrong and picker cancel locks the camera

### Problem
- After the orientation fix, the cropped image had swapped colors (e.g., blue text appeared yellow/orange).
- The shutter → picker → select-rectangle flow looked correct, but direct tap-to-crop still had wrong colors.
- After tapping **Capture** and then cancelling the picker, the camera activity would no longer respond to capture or rectangle taps.

### Root cause
**Colors:** The camera capture path decoded the JPEG through Android `BitmapFactory` + `Utils.bitmapToMat`, which produces a 4-channel Mat whose exact channel layout depends on OpenCV/Android internals. The picker path loaded the saved file with `Imgcodecs.imread`, which always returns BGR. Combining those two sources with OpenCV's BGR-biased `imwrite`/`imencode` produced inconsistent red/blue channel handling: one path flipped once, the other flipped twice.

**Lock-up:** `processShutterCapture` launched `RectanglePickerActivity` but only `Activity.RESULT_OK` was handled in `onActivityResult`. When the user cancelled, `captureMode` stayed `SHUTTER` and the capture button stayed disabled, so the UI became unresponsive.

### Fix
**Color:** Switched the whole capture pipeline to grayscale, which removes the red/blue ambiguity entirely:

- `decodeCapturedImage` now decodes the JPEG with `Imgcodecs.imdecode(..., IMREAD_GRAYSCALE)` and rotates the grayscale Mat directly.
- The existing YUV path already returns a grayscale Y-plane Mat.
- Removed `bitmapToMatRotated` and the unreliable Bitmap → Mat color conversion.
- `RectangleCropper.toRgbForEncoding` still handles grayscale (and BGR/RGBA if used elsewhere).

**Lock-up:** In `RectangleCameraActivity.onActivityResult`, reset capture state when the picker returns `RESULT_CANCELED`.

### Result
- Both tap-to-crop and shutter → picker → select-rectangle produce grayscale crops with no color-channel surprises.
- Debug images and picker previews are also grayscale.
- Cancelling the picker returns the user to a responsive camera view.

---

## Files changed

- `nuxt.config.ts`
- `composables/useRectangleDetection.ts`
- `pages/opencv-rectangle-demo.vue`
- `AGENTS.md`
- `README.md`
- `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java`
- `android/app/src/main/java/com/docpal/warehousedemo/RectanglePickerActivity.java`
- `android/app/src/main/java/com/docpal/warehousedemo/RectangleCropper.java`
- `android/app/src/main/java/com/docpal/warehousedemo/RectangleDetectionPlugin.java`
- `android/app/src/test/java/com/docpal/warehousedemo/RectangleCropperOrderPointsTest.java`

## Verification

```bash
# Dev server
pnpm dev
# Open the URL and confirm the page loads instead of showing a white screen.

# Unit tests (run from the android directory)
cd android
./gradlew :app:testDebugUnitTest --tests com.docpal.warehousedemo.RectangleCropperOrderPointsTest

# Android build + install
./gradlew :app:assembleDebug :app:installDebug
```

On device:
1. Navigate to **OpenCV Rectangle Stream**.
2. Tap **Start camera stream** — preview should appear.
3. Tap a rectangle — captured crop displays upright, not mirrored, and with correct colors.
4. Tap shutter, pick a rectangle — captured crop displays upright, not mirrored, and with correct colors.
5. Tap shutter, then **Cancel** in the picker — camera returns to live preview and capture/rectangle taps work again.
6. Repeat captures — app should not crash or reload.
