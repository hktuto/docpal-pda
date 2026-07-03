# Camera Stabilization, Full-Frame OCR, and Barcode Scanning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize rectangle detection, add a full-frame OCR option, and return both text and barcodes from the native Android scan flow.

**Architecture:** Introduce `RectangleTracker` to keep rectangles alive across frames using IoU matching and a 1-second timeout. Add `OcrBarcodeProcessor` to run ML Kit Text Recognition and Barcode Scanning in parallel and return text plus a JSON array of barcodes. Wire both into `RectangleCameraActivity`, `RectanglePickerActivity`, `RectangleOcrHelper`, and the Capacitor plugin.

**Tech Stack:** Android native, Java, CameraX, OpenCV, ML Kit Text Recognition, ML Kit Barcode Scanning, Capacitor.

---

## File structure

- **Modify:** `android/app/build.gradle`
- **Create:** `android/app/src/main/java/com/docpal/warehousedemo/RectangleTracker.java`
- **Create:** `android/app/src/main/java/com/docpal/warehousedemo/OcrBarcodeProcessor.java`
- **Modify:** `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java`
- **Modify:** `android/app/src/main/java/com/docpal/warehousedemo/RectangleOcrHelper.java`
- **Modify:** `android/app/src/main/java/com/docpal/warehousedemo/RectanglePickerActivity.java`
- **Modify:** `android/app/src/main/java/com/docpal/warehousedemo/RectangleDetectionPlugin.java`
- **Modify:** `android/app/src/main/res/layout/activity_rectangle_picker.xml`
- **Modify:** `android/app/src/main/res/values/strings.xml`
- **Modify:** `composables/useRectangleDetection.ts`

---

### Task 1: Add ML Kit Barcode Scanning dependency

**Files:**
- Modify: `android/app/build.gradle`

- [ ] **Step 1: Add barcode scanning dependency**

In `android/app/build.gradle`, add this line after the existing MLKit text recognition dependency:

```gradle
    implementation 'com.google.mlkit:barcode-scanning:17.3.0'
```

The dependencies block should look like:

```gradle
dependencies {
    implementation fileTree(include: ['*.jar'], dir: 'libs')
    implementation "androidx.appcompat:appcompat:$androidxAppCompatVersion"
    implementation "androidx.coordinatorlayout:coordinatorlayout:$androidxCoordinatorLayoutVersion"
    implementation "androidx.core:core-splashscreen:$coreSplashScreenVersion"
    implementation project(':capacitor-android')
    testImplementation "junit:junit:$junitVersion"
    androidTestImplementation "androidx.test.ext:junit:$androidxJunitVersion"
    androidTestImplementation "androidx.test.espresso:espresso-core:$androidxEspressoCoreVersion"
    implementation project(':capacitor-cordova-android-plugins')
    implementation 'com.google.mlkit:text-recognition:16.0.1'
    implementation 'com.google.mlkit:barcode-scanning:17.3.0'
    implementation 'org.opencv:opencv:4.13.0'
    implementation 'androidx.camera:camera-core:1.3.4'
    implementation 'androidx.camera:camera-camera2:1.3.4'
    implementation 'androidx.camera:camera-lifecycle:1.3.4'
    implementation 'androidx.camera:camera-view:1.3.4'
}
```

- [ ] **Step 2: Sync and verify compilation**

Run:

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:compileDebugJavaWithJavac
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
git add android/app/build.gradle
git commit -m "build: add mlkit barcode scanning dependency"
```

---

### Task 2: Create RectangleTracker

**Files:**
- Create: `android/app/src/main/java/com/docpal/warehousedemo/RectangleTracker.java`

- [ ] **Step 1: Create the tracker class**

Create `android/app/src/main/java/com/docpal/warehousedemo/RectangleTracker.java` with the following content:

```java
package com.docpal.warehousedemo;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import org.opencv.core.Rect;

public class RectangleTracker {

  private static final long TRACK_TIMEOUT_MILLIS = 1000L;
  private static final double MIN_IOU = 0.3;

  public static class TrackedRect {
    public final int id;
    public RectangleDetector.RectResult rect;
    public long lastSeenMillis;

    public TrackedRect(int id, RectangleDetector.RectResult rect, long lastSeenMillis) {
      this.id = id;
      this.rect = rect;
      this.lastSeenMillis = lastSeenMillis;
    }
  }

  private int nextId = 1;
  private final List<TrackedRect> trackedRects = new ArrayList<>();

  public List<TrackedRect> update(List<RectangleDetector.RectResult> detections) {
    long now = System.currentTimeMillis();

    List<RectangleDetector.RectResult> unmatchedDetections = new ArrayList<>(detections);
    boolean[] matched = new boolean[trackedRects.size()];

    // Build all candidate matches sorted by IoU descending.
    List<Match> candidates = new ArrayList<>();
    for (int d = 0; d < unmatchedDetections.size(); d++) {
      for (int t = 0; t < trackedRects.size(); t++) {
        double iou = computeIoU(unmatchedDetections.get(d).boundingBox, trackedRects.get(t).rect.boundingBox);
        if (iou >= MIN_IOU) {
          candidates.add(new Match(d, t, iou));
        }
      }
    }
    Collections.sort(candidates, Comparator.comparingDouble((Match m) -> m.iou).reversed());

    for (Match candidate : candidates) {
      if (matched[candidate.trackedIndex]) {
        continue;
      }
      if (candidate.detectionIndex < 0 || candidate.detectionIndex >= unmatchedDetections.size()) {
        continue;
      }
      RectangleDetector.RectResult detection = unmatchedDetections.get(candidate.detectionIndex);
      if (detection == null) {
        continue;
      }

      TrackedRect tracked = trackedRects.get(candidate.trackedIndex);
      tracked.rect = detection;
      tracked.lastSeenMillis = now;
      matched[candidate.trackedIndex] = true;
      unmatchedDetections.set(candidate.detectionIndex, null);
    }

    // Add brand-new detections.
    for (RectangleDetector.RectResult detection : unmatchedDetections) {
      if (detection != null) {
        trackedRects.add(new TrackedRect(nextId++, detection, now));
      }
    }

    // Remove expired tracked rects.
    List<TrackedRect> result = new ArrayList<>();
    for (int i = trackedRects.size() - 1; i >= 0; i--) {
      TrackedRect tracked = trackedRects.get(i);
      if (now - tracked.lastSeenMillis > TRACK_TIMEOUT_MILLIS) {
        trackedRects.remove(i);
      } else {
        result.add(tracked);
      }
    }

    return result;
  }

  public void clear() {
    trackedRects.clear();
  }

  private static double computeIoU(Rect a, Rect b) {
    int left = Math.max(a.x, b.x);
    int top = Math.max(a.y, b.y);
    int right = Math.min(a.x + a.width, b.x + b.width);
    int bottom = Math.min(a.y + a.height, b.y + b.height);

    if (right <= left || bottom <= top) {
      return 0.0;
    }

    double intersection = (right - left) * (double) (bottom - top);
    double areaA = a.width * (double) a.height;
    double areaB = b.width * (double) b.height;
    double union = areaA + areaB - intersection;

    return union > 0 ? intersection / union : 0.0;
  }

  private static class Match {
    final int detectionIndex;
    final int trackedIndex;
    final double iou;

    Match(int detectionIndex, int trackedIndex, double iou) {
      this.detectionIndex = detectionIndex;
      this.trackedIndex = trackedIndex;
      this.iou = iou;
    }
  }
}
```

- [ ] **Step 2: Verify the file compiles**

Run:

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:compileDebugJavaWithJavac
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/com/docpal/warehousedemo/RectangleTracker.java
git commit -m "feat(camera): add rectangle tracker with iou matching and timeout"
```

---

### Task 3: Integrate tracker into camera activity

**Files:**
- Modify: `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java`

- [ ] **Step 1: Add tracker field and update detection result handling**

Add a field near the other state fields:

```java
private RectangleTracker rectangleTracker;
```

Initialize it in `onCreate` after `ocrHelper = new RectangleOcrHelper();`:

```java
rectangleTracker = new RectangleTracker();
```

Find the `onDetectionResult` method and change it from:

```java
private void onDetectionResult(DetectionResult result) {
  streamWidth = result.width;
  streamHeight = result.height;

  overlayView.setImageSize(result.width, result.height);
  overlayView.setRectangles(result.rectangles);
}
```

to:

```java
private void onDetectionResult(DetectionResult result) {
  streamWidth = result.width;
  streamHeight = result.height;

  List<RectangleTracker.TrackedRect> tracked = rectangleTracker.update(result.rectangles);
  List<RectangleDetector.RectResult> rects = new ArrayList<>(tracked.size());
  for (RectangleTracker.TrackedRect t : tracked) {
    rects.add(t.rect);
  }

  overlayView.setImageSize(result.width, result.height);
  overlayView.setRectangles(rects);
}
```

- [ ] **Step 2: Update tap-to-capture to use tracked rectangles**

Change `onOverlayTouched` from iterating `overlayView.getRectangles()` (which returns the displayed rects) to using the tracked list. To keep it simple, store the most recent tracked list in a field.

Add a field:

```java
private volatile List<RectangleTracker.TrackedRect> currentTrackedRects = new ArrayList<>();
```

Update `onDetectionResult` to store it:

```java
private void onDetectionResult(DetectionResult result) {
  streamWidth = result.width;
  streamHeight = result.height;

  List<RectangleTracker.TrackedRect> tracked = rectangleTracker.update(result.rectangles);
  currentTrackedRects = tracked;

  List<RectangleDetector.RectResult> rects = new ArrayList<>(tracked.size());
  for (RectangleTracker.TrackedRect t : tracked) {
    rects.add(t.rect);
  }

  overlayView.setImageSize(result.width, result.height);
  overlayView.setRectangles(rects);
}
```

Then update the loop in `onOverlayTouched`:

```java
for (RectangleTracker.TrackedRect tracked : currentTrackedRects) {
  if (RectangleCropper.isPointInPolygon(imagePoint.x, imagePoint.y, tracked.rect.points)) {
    captureMode = CaptureMode.TAP_RECT;
    pendingTapRect = tracked.rect;
    takePicture();
    return true;
  }
}
```

- [ ] **Step 3: Clear tracker on destroy**

In `onDestroy`, after existing cleanup, add:

```java
if (rectangleTracker != null) {
  rectangleTracker.clear();
}
```

- [ ] **Step 4: Verify compilation**

Run:

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:compileDebugJavaWithJavac
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java
git commit -m "feat(camera): integrate rectangle tracker into live preview"
```

---

### Task 4: Create OcrBarcodeProcessor

**Files:**
- Create: `android/app/src/main/java/com/docpal/warehousedemo/OcrBarcodeProcessor.java`

- [ ] **Step 1: Create the processor class**

Create `android/app/src/main/java/com/docpal/warehousedemo/OcrBarcodeProcessor.java`:

```java
package com.docpal.warehousedemo;

import android.util.Log;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class OcrBarcodeProcessor {

  private static final String TAG = "OcrBarcodeProcessor";

  public interface ResultListener {
    void onResult(String text, String barcodesJson);
  }

  public void process(InputImage image, ResultListener listener) {
    TextRecognizer textRecognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
    BarcodeScanner barcodeScanner = BarcodeScanning.getClient();

    final String[] textResult = { "" };
    final String[] barcodeResult = { "[]" };
    final boolean[] textDone = { false };
    final boolean[] barcodeDone = { false };

    Runnable maybeFinish = () -> {
      if (textDone[0] && barcodeDone[0]) {
        close(textRecognizer, barcodeScanner);
        listener.onResult(textResult[0], barcodeResult[0]);
      }
    };

    textRecognizer.process(image)
      .addOnSuccessListener(visionText -> {
        textResult[0] = visionText.getText();
        textDone[0] = true;
        maybeFinish.run();
      })
      .addOnFailureListener(e -> {
        Log.e(TAG, "Text recognition failed", e);
        textDone[0] = true;
        maybeFinish.run();
      });

    barcodeScanner.process(image)
      .addOnSuccessListener(barcodes -> {
        barcodeResult[0] = barcodesToJson(barcodes);
        barcodeDone[0] = true;
        maybeFinish.run();
      })
      .addOnFailureListener(e -> {
        Log.e(TAG, "Barcode scanning failed", e);
        barcodeDone[0] = true;
        maybeFinish.run();
      });
  }

  private static String barcodesToJson(List<Barcode> barcodes) {
    JSONArray array = new JSONArray();
    for (Barcode barcode : barcodes) {
      try {
        JSONObject obj = new JSONObject();
        String value = barcode.getRawValue();
        obj.put("value", value != null ? value : "");
        obj.put("format", barcode.getFormat());
        array.put(obj);
      } catch (JSONException e) {
        // ignore individual barcode serialization errors
      }
    }
    return array.toString();
  }

  private static void close(TextRecognizer textRecognizer, BarcodeScanner barcodeScanner) {
    try {
      textRecognizer.close();
    } catch (Exception e) {
      Log.e(TAG, "Failed to close text recognizer", e);
    }
    try {
      barcodeScanner.close();
    } catch (Exception e) {
      Log.e(TAG, "Failed to close barcode scanner", e);
    }
  }
}
```

- [ ] **Step 2: Verify compilation**

Run:

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:compileDebugJavaWithJavac
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/com/docpal/warehousedemo/OcrBarcodeProcessor.java
git commit -m "feat(camera): add combined OCR and barcode processor"
```

---

### Task 5: Update RectangleOcrHelper to return text and barcodes

**Files:**
- Modify: `android/app/src/main/java/com/docpal/warehousedemo/RectangleOcrHelper.java`

- [ ] **Step 1: Replace text-only OCR with combined processor**

Replace the entire contents of `android/app/src/main/java/com/docpal/warehousedemo/RectangleOcrHelper.java` with:

```java
package com.docpal.warehousedemo;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import androidx.annotation.Nullable;
import com.google.mlkit.vision.common.InputImage;
import java.io.File;
import java.io.IOException;

public class RectangleOcrHelper {

  private static final String TAG = "RectangleOcrHelper";

  public void runOcrAndFinish(
      Activity activity,
      String imagePath,
      int width,
      int height,
      @Nullable String rectanglesJson,
      @Nullable String selectedRectJson) {
    if (activity.isFinishing() || activity.isDestroyed()) {
      return;
    }
    try {
      InputImage inputImage = InputImage.fromFilePath(activity, Uri.fromFile(new File(imagePath)));
      new OcrBarcodeProcessor().process(inputImage, (text, barcodesJson) -> {
        if (activity.isFinishing() || activity.isDestroyed()) {
          return;
        }
        finishWithResult(activity, imagePath, width, height, rectanglesJson, selectedRectJson, text, barcodesJson);
      });
    } catch (IOException e) {
      Log.e(TAG, "Failed to load image for OCR", e);
      finishWithResult(activity, imagePath, width, height, rectanglesJson, selectedRectJson, "", "[]");
    }
  }

  public static void finishWithResult(
      Activity activity,
      String imagePath,
      int width,
      int height,
      @Nullable String rectanglesJson,
      @Nullable String selectedRectJson) {
    finishWithResult(activity, imagePath, width, height, rectanglesJson, selectedRectJson, "", "[]");
  }

  public static void finishWithResult(
      Activity activity,
      String imagePath,
      int width,
      int height,
      @Nullable String rectanglesJson,
      @Nullable String selectedRectJson,
      String text) {
    finishWithResult(activity, imagePath, width, height, rectanglesJson, selectedRectJson, text, "[]");
  }

  public static void finishWithResult(
      Activity activity,
      String imagePath,
      int width,
      int height,
      @Nullable String rectanglesJson,
      @Nullable String selectedRectJson,
      String text,
      String barcodesJson) {
    if (activity.isFinishing() || activity.isDestroyed()) {
      return;
    }
    Intent resultIntent = new Intent();
    resultIntent.putExtra("imagePath", imagePath);
    resultIntent.putExtra("width", width);
    resultIntent.putExtra("height", height);
    if (rectanglesJson != null) {
      resultIntent.putExtra("rectanglesJson", rectanglesJson);
    }
    if (selectedRectJson != null) {
      resultIntent.putExtra("selectedRect", selectedRectJson);
    }
    resultIntent.putExtra("text", text != null ? text : "");
    resultIntent.putExtra("barcodes", barcodesJson != null ? barcodesJson : "[]");
    activity.setResult(Activity.RESULT_OK, resultIntent);
    activity.finish();
  }
}
```

- [ ] **Step 2: Verify compilation**

Run:

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:compileDebugJavaWithJavac
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/com/docpal/warehousedemo/RectangleOcrHelper.java
git commit -m "feat(camera): return text and barcodes from OCR helper"
```

---

### Task 6: Update Capacitor plugin result shape

**Files:**
- Modify: `android/app/src/main/java/com/docpal/warehousedemo/RectangleDetectionPlugin.java`
- Modify: `composables/useRectangleDetection.ts`

- [ ] **Step 1: Read barcodes extra in plugin**

In `android/app/src/main/java/com/docpal/warehousedemo/RectangleDetectionPlugin.java`, update `scanLabelResult` from:

```java
      capture.put("imagePath", data.getStringExtra("imagePath"));
      String text = data.getStringExtra("text");
      capture.put("text", text != null ? text : "");
      call.resolve(capture);
```

to:

```java
      capture.put("imagePath", data.getStringExtra("imagePath"));
      String text = data.getStringExtra("text");
      capture.put("text", text != null ? text : "");
      String barcodes = data.getStringExtra("barcodes");
      capture.put("barcodes", barcodes != null ? barcodes : "[]");
      call.resolve(capture);
```

- [ ] **Step 2: Update TypeScript interface**

In `composables/useRectangleDetection.ts`, update:

```ts
export interface LabelScanCapture {
  imagePath: string;
  text: string;
}
```

to:

```ts
export interface LabelScanCapture {
  imagePath: string;
  text: string;
  barcodes: string;
}
```

- [ ] **Step 3: Verify TypeScript types**

Run:

```bash
pnpm nuxt prepare
```

Expected: completes without TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/docpal/warehousedemo/RectangleDetectionPlugin.java \
        composables/useRectangleDetection.ts
git commit -m "feat(camera): include barcodes in scan label result"
```

---

### Task 7: Add "Use full image" button to picker

**Files:**
- Modify: `android/app/src/main/res/layout/activity_rectangle_picker.xml`
- Modify: `android/app/src/main/res/values/strings.xml`
- Modify: `android/app/src/main/java/com/docpal/warehousedemo/RectanglePickerActivity.java`

- [ ] **Step 1: Add string resource**

In `android/app/src/main/res/values/strings.xml`, add:

```xml
<string name="camera_use_full_image">Use full image</string>
```

- [ ] **Step 2: Add button to picker layout**

Replace the bottom `Button` section of `android/app/src/main/res/layout/activity_rectangle_picker.xml` from:

```xml
    <Button
        android:id="@+id/cancelButton"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:layout_gravity="bottom|center_horizontal"
        android:layout_marginBottom="32dp"
        android:text="Cancel" />
```

to:

```xml
    <LinearLayout
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:layout_gravity="bottom|center_horizontal"
        android:layout_marginBottom="32dp"
        android:orientation="horizontal">

        <Button
            android:id="@+id/cancelButton"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginEnd="16dp"
            android:text="@string/camera_cancel" />

        <Button
            android:id="@+id/fullImageButton"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/camera_use_full_image" />

    </LinearLayout>
```

- [ ] **Step 3: Wire full-image button in picker activity**

In `android/app/src/main/java/com/docpal/warehousedemo/RectanglePickerActivity.java`, add a field:

```java
private Button fullImageButton;
```

Bind it in `onCreate`:

```java
fullImageButton = findViewById(R.id.fullImageButton);
```

Add a click listener after the cancel button listener:

```java
fullImageButton.setOnClickListener(v -> processFullImage());
```

Add the method:

```java
private void processFullImage() {
  if (isLabelScan) {
    ocrHelper.runOcrAndFinish(this, imagePath, imageWidth, imageHeight, null, null);
  } else {
    RectangleOcrHelper.finishWithResult(this, imagePath, imageWidth, imageHeight, null, null, "", "[]");
  }
}
```

- [ ] **Step 4: Verify compilation**

Run:

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:compileDebugJavaWithJavac
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/res/layout/activity_rectangle_picker.xml \
        android/app/src/main/res/values/strings.xml \
        android/app/src/main/java/com/docpal/warehousedemo/RectanglePickerActivity.java
git commit -m "feat(camera): add use full image button to picker"
```

---

### Task 8: Build and install on Android

**Files:**
- None (verification step)

- [ ] **Step 1: Install debug APK**

Because `pnpm generate` is currently blocked by an unrelated syntax error in `pages/receiving/[id].vue`, build the native APK directly (web assets do not need to change for these native-only changes):

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:installDebug
```

Expected: `BUILD SUCCESSFUL` and `Installed on 1 device.`.

- [ ] **Step 2: Manual verification**

On the Android device:

1. Open a camera scan flow.
2. Verify rectangles no longer flicker; they persist for ~1 second after leaving the frame.
3. Tap a rectangle and verify OCR text and `barcodes` JSON are returned.
4. On the picker screen, tap "Use full image" and verify OCR/barcode results from the full frame.
5. Point the camera at a QR code or barcode and verify the barcode value appears in the result.

- [ ] **Step 3: Commit any final fixes**

If fixes were needed during testing, commit them with descriptive messages.

---

## Self-review checklist

**Spec coverage:**
- Rectangle stabilization with IoU and 1-second timeout — Tasks 2 and 3.
- Full-frame OCR option — Task 7.
- Barcode/QR scanning with JSON array result — Tasks 1, 4, 5, 6.
- Plugin result shape updated — Task 6.

**Placeholder scan:** No TBDs or vague steps. Every step includes exact file paths and code.

**Type consistency:**
- `LabelScanCapture` gains `barcodes: string`.
- `RectangleOcrHelper.finishWithResult` gains a `barcodesJson` parameter.
- `RectangleDetectionPlugin` reads `barcodes` extra.
- `OcrBarcodeProcessor.ResultListener` passes `(text, barcodesJson)`.
