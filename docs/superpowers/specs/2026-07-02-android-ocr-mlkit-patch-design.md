# Android OCR ML Kit Patch

> **Status:** Archived. The Pantrist plugin and Camera OCR demo page were removed in favor of the native `RectangleCameraActivity` + ML Kit text recognition flow. This patch is no longer needed.

## Context

The demo uses `@pantrist/capacitor-plugin-ml-kit-text-recognition` to run on-device text recognition from photos taken with `@capacitor/camera`. On Android, the plugin's default dependency is the **dynamic/unbundled** ML Kit text-recognition module, which is downloaded and executed by Google Play Services at runtime.

## Problem

On some Android devices the dynamic ML Kit module cannot be loaded. The JS error surfaced in the app is:

```text
Unable process image!
```

The underlying native exception logged by the plugin is:

```text
com.google.mlkit.common.MlKitException: Failed to load deprecated vision dynamite module.
Caused by: com.google.android.gms.dynamite.DynamiteModule$LoadingException:
  No acceptable module com.google.android.gms.vision.dynamite found.
  Local version is 0 and remote version is 0.
```

This happens even when Google Play Services itself is present and other native apps can use ML Kit, because the Pantrist plugin specifically relies on the Play Services-hosted vision model being available on that device/account.

## Solution

Patch the Pantrist plugin to use the **bundled/static** ML Kit text-recognition library instead of the dynamic Play Services one. The bundled library ships the OCR model inside the APK, so recognition works immediately after install with no runtime download.

### Dependency change

In `node_modules/@pantrist/capacitor-plugin-ml-kit-text-recognition/android/build.gradle`:

```diff
-    mlkitTextRecognitionVersion = project.hasProperty('mlkitTextRecognitionVersion') ? rootProject.ext.mlkitTextRecognitionVersion : '19.0.1'
+    mlkitTextRecognitionVersion = project.hasProperty('mlkitTextRecognitionVersion') ? rootProject.ext.mlkitTextRecognitionVersion : '16.0.1'
```

```diff
-    implementation "com.google.android.gms:play-services-mlkit-text-recognition:$mlkitTextRecognitionVersion"
+    implementation "com.google.mlkit:text-recognition:$mlkitTextRecognitionVersion"
```

The Kotlin plugin code itself does not need to change — it already imports `com.google.mlkit.vision.text.TextRecognition` and `TextRecognizerOptions.DEFAULT_OPTIONS`, which are API-compatible with both the dynamic and bundled artifacts.

### Debug logging (optional)

To make future OCR issues easier to diagnose, the patch also adds a small amount of native logging:

```kotlin
import android.util.Log

Log.d("MLKitOCR", "Decoded bitmap: ${decodedByte.width}x${decodedByte.height}")
Log.e("MLKitOCR", "Unable process image", e)
```

These lines are not required for the fix, but they reveal the real native exception instead of swallowing it behind the generic JS error message.

## Patch file

The change is persisted as a pnpm patch so it survives `pnpm install`:

```text
patches/@pantrist__capacitor-plugin-ml-kit-text-recognition@8.0.0.patch
```

pnpm applies this patch automatically during `postinstall`.

## Trade-offs

| Aspect | Before (dynamic) | After (bundled) |
|---|---|---|
| APK size | Smaller | Larger by roughly the OCR model size (~few MB) |
| First-use latency | May need to download model from Play Services | Works offline immediately |
| Device compatibility | Fails on devices without the Play Services vision module | Works on any Android device that meets `minSdkVersion` |
| Model updates | Automatic via Play Services | Requires updating the dependency and releasing a new APK |

For a demo/proof-of-concept, the bundled option is the better default because it removes a runtime dependency on a specific Play Services module being present.

## How to rebuild after the patch

1. Ensure the patch is applied (pnpm does this automatically on `pnpm install`).
2. Sync Capacitor:

   ```bash
   pnpm cap sync android
   ```

3. In Android Studio:
   - **File → Sync Project with Gradle Files**
   - **Build → Clean Project**
   - **Build → Rebuild Project**
   - Run the app again.

## Verification

1. Open the **Camera OCR Demo** page in the app.
2. Tap **Open camera OCR** and take a photo of a printed label.
3. Expected result: the captured image appears as a preview and recognized text is shown.

If it still fails, filter Logcat for `MLKitOCR` and look for the native exception or bitmap dimensions.
