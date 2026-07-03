# Camera Flashlight Toggle + UI Refresh

## Purpose

Improve the native Android camera screen used by `RectangleDetectionPlugin` so the operator can turn the flashlight on/off and the controls look like a standard camera app instead of plain text buttons.

## Scope

- Modify `RectangleCameraActivity.java` and its layout `activity_rectangle_camera.xml`.
- No changes to the web side, the Capacitor plugin interface, or the OCR/rectangle detection logic.
- Applies to both camera modes (`default` and `label_scan`).

## Requirements

1. Add a flashlight toggle button on the camera screen.
2. Flashlight defaults to **on** the first time the camera opens in an app session.
3. Remember the last toggled state for the remainder of the current app process (activity recreation included).
4. Restyle the bottom controls to a camera-app layout:
   - Left: circular close/cancel button with an X icon.
   - Center: large circular shutter button.
   - Right: circular flash toggle button with on/off icons.
5. Hide or disable the flash button if the device has no flash unit.
6. Keep existing capture behavior: shutter captures full frame, tap-to-rectangle still works via `RectangleOverlayView`.

## Design

### State management

Use a single `private static boolean sTorchOn = true;` field in `RectangleCameraActivity`.

- Static lifetime matches the "current app session" requirement: it survives activity recreation but resets when the Android process is killed.
- Updating the toggle writes to this field and to CameraX via `camera.getCameraControl().enableTorch(sTorchOn)`.

### Camera bind

`bindCamera(...)` currently ignores the `Camera` returned by `cameraProvider.bindToLifecycle(...)`. Capture that `Camera` instance in a field so we can:

- Apply the current torch state on bind: `camera.getCameraControl().enableTorch(sTorchOn)`.
- Check `camera.getCameraInfo().hasFlashUnit()` to decide flash button visibility.
- Toggle torch state later without rebinding.

### Layout

Replace the two plain `Button` views with three circular `ImageButton` (or `MaterialButton`) controls inside a bottom-aligned `FrameLayout` or `LinearLayout`:

- `cancelButton` — secondary circular button, close/X icon, bottom-left area.
- `captureButton` — primary large circular button, white ring + solid center, bottom-center.
- `flashButton` — secondary circular button, flash-on / flash-off icon, bottom-right area.

All controls float over the preview with transparent backgrounds, using circular dark translucent backgrounds so they remain visible over bright/dark scenes.

### Icons

Use built-in Android vector drawables if available, otherwise add simple drawable resources:

- `ic_close.xml` or `baseline_close_24`
- `ic_flash_on.xml` / `ic_flash_off.xml`
- Shutter button can be a `shape` drawable with a white ring and a smaller solid circle centered inside.

### Error handling / edge cases

- If `hasFlashUnit()` is false, hide `flashButton` so the user cannot attempt to toggle a missing flashlight.
- If enabling torch fails (rare), log the error and show a short Toast.

## Files changed

- `android/app/src/main/res/layout/activity_rectangle_camera.xml`
- `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java`
- Possibly new drawable resources under `android/app/src/main/res/drawable/`

## Testing

1. Open the camera from the web demo.
2. Verify the flashlight turns on by default.
3. Tap the flash button — icon changes and flashlight turns off.
4. Close the camera and reopen it — flashlight should still be off.
5. Kill the app process and reopen the camera — flashlight should be on again.
6. Verify the shutter button still captures and the cancel button still closes the camera.
7. On a device without a flash unit, verify the flash button is hidden.
