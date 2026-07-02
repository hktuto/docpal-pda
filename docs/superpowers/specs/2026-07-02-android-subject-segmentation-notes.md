# Android Subject Segmentation Notes

## Plugin

`@capacitor-mlkit/subject-segmentation@8.1.0`

## Demo page

`pages/subject-segmentation-demo.vue`

It takes a photo with `@capacitor/camera`, passes the file path to `SubjectSegmentation.processImage()`, and displays the original and segmented images.

## Method-name patch

The plugin's TypeScript API exposes `isGoogleSubjectSegmentationModuleAvailable()`, but the Android native method is named `isSubjectSegmentationScannerModuleAvailable()`. Because Capacitor matches the JavaScript call name to the native method name, calling the TypeScript method on Android originally produced:

```text
isGoogleSubjectSegmentationModuleAvailable() is not implemented on android
```

A pnpm patch renames the native method to match the TypeScript API:

```text
patches/@capacitor-mlkit__subject-segmentation@8.1.0.patch
```

## Device limitation

Subject segmentation relies on the Google Play Services **ModuleInstall API** to download the `subject_segment` ML Kit model at runtime. On some devices this API is not available:

```text
com.google.android.gms.common.api.ApiException: 17:
  API: ModuleInstall.API is not available on this device.
  Connection failed with: ConnectionResult{statusCode=SERVICE_INVALID, ...}
```

When this happens, neither `isGoogleSubjectSegmentationModuleAvailable()` nor `installGoogleSubjectSegmentationModule()` can succeed. Unlike text recognition, ML Kit does not provide a bundled/static artifact for subject segmentation, so there is no equivalent patch to embed the model in the APK.

### Workaround

Test subject segmentation on a different Android device that has a fully functional Google Play Services module installer, or on an emulator with Google Play Services.

## Files

- `pages/subject-segmentation-demo.vue` — demo UI.
- `patches/@capacitor-mlkit__subject-segmentation@8.1.0.patch` — method-name fix.
