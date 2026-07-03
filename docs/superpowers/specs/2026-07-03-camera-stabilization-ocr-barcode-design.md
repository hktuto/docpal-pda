# Camera Rectangle Stabilization, Full-Frame OCR, and Barcode Scanning

## Purpose

Improve the native Android camera scan flow so that detected rectangles feel stable, users can OCR the full frame when no rectangle fits, and both rectangle crops and full frames are also scanned for barcodes/QR codes.

## Scope

- Native Android side only: `RectangleCameraActivity`, `RectanglePickerActivity`, `RectangleOcrHelper`, new helper classes, and the Capacitor plugin result shape.
- Web TypeScript interface update in `composables/useRectangleDetection.ts`.
- No changes to the rectangle detection algorithm itself.

## Requirements

1. **Rectangle stabilization**
   - Detected rectangles must not flicker between frames.
   - Match new detections to previously seen rectangles by bounding-box overlap (IoU ≥ 0.3).
   - If a tracked rectangle is not matched for more than 1000 ms, remove it.
   - If a tracked rectangle is unmatched but still within the 1000 ms window, keep drawing it on the overlay.
   - Tap-to-capture must work against the stabilized rectangles.

2. **Full-frame OCR option**
   - On the rectangle picker screen, show a "Use full image" button.
   - Tapping it runs OCR and barcode scanning on the entire captured image.
   - The result is returned through the same Capacitor plugin path as a rectangle crop, but without a `selectedRect`.

3. **Barcode/QR scanning**
   - Run ML Kit Barcode Scanning alongside ML Kit Text Recognition for every processed image (crop or full frame).
   - Return barcodes as a JSON array string: `[{"value":"...","format":"..."}, ...]`.
   - If no barcode is found, return an empty array string `"[]"`.
   - Update the Capacitor plugin result shape to include `barcodes`.

## Design

### RectangleTracker

New class `RectangleTracker` owns the temporal state.

```java
public class RectangleTracker {
  public static class TrackedRect {
    public final int id;
    public RectangleDetector.RectResult rect;
    public long lastSeenMillis;
  }

  public List<TrackedRect> update(List<RectangleDetector.RectResult> detections);
}
```

- Each `update` call computes IoU between every detection and every tracked rect.
- Matches are resolved greedily by highest IoU.
- Matched tracked rects copy the new `rect` and refresh `lastSeenMillis`.
- Unmatched detections create new tracked rects with incrementing IDs.
- Tracked rects older than `1000 ms` are removed.
- The returned list is what the overlay draws.

### OcrBarcodeProcessor

New class `OcrBarcodeProcessor` wraps ML Kit Text Recognition and Barcode Scanning.

```java
public class OcrBarcodeProcessor {
  public static class Result {
    public final String text;
    public final String barcodesJson;
  }

  public void process(
      InputImage image,
      Activity activity,
      OnResultListener listener);
}
```

- Runs both recognizers on the same `InputImage`.
- Combines both async results and calls the listener once with `text` and `barcodesJson`.
- Barcodes are serialized to JSON using `org.json.JSONArray`/`JSONObject`.

### RectangleOcrHelper changes

`runOcrAndFinish` is updated to use `OcrBarcodeProcessor` and pass `barcodesJson` to `finishWithResult`.

`finishWithResult` adds a `barcodes` extra to the result intent.

### RectangleDetectionPlugin changes

`scanLabelResult` reads the `barcodes` extra and returns it as a string in the JS object.

### Web interface changes

Update `LabelScanCapture`:

```ts
export interface LabelScanCapture {
  imagePath: string;
  text: string;
  barcodes: string; // JSON array string
}
```

### RectanglePickerActivity changes

- Add "Use full image" `Button` to `activity_rectangle_picker.xml`.
- On click, call `OcrBarcodeProcessor` with the full image file and finish.

## Files changed

- Create `android/app/src/main/java/com/docpal/warehousedemo/RectangleTracker.java`
- Create `android/app/src/main/java/com/docpal/warehousedemo/OcrBarcodeProcessor.java`
- Modify `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java`
- Modify `android/app/src/main/java/com/docpal/warehousedemo/RectanglePickerActivity.java`
- Modify `android/app/src/main/java/com/docpal/warehousedemo/RectangleOcrHelper.java`
- Modify `android/app/src/main/java/com/docpal/warehousedemo/RectangleDetectionPlugin.java`
- Modify `android/app/src/main/res/layout/activity_rectangle_picker.xml`
- Modify `android/app/src/main/res/values/strings.xml`
- Modify `composables/useRectangleDetection.ts`

## Testing

1. Point the camera at a label. Verify rectangles stop flickering and persist for ~1 sec after the label leaves the frame.
2. Tap a stabilized rectangle and verify OCR/barcode results return.
3. On the picker screen, tap "Use full image" and verify OCR/barcode results from the full frame.
4. Point at a QR code or barcode and verify the `barcodes` JSON array contains the expected value and format.
5. Verify `composables/useRectangleDetection.ts` compiles after the interface change.
