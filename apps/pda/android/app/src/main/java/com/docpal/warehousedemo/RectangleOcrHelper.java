package com.docpal.warehousedemo;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import androidx.annotation.Nullable;
import com.google.mlkit.vision.common.InputImage;
import java.io.File;
import java.io.IOException;
import java.lang.ref.WeakReference;

public class RectangleOcrHelper {

  private static final String TAG = "RectangleOcrHelper";

  @Nullable
  private OcrBarcodeProcessor activeProcessor;

  public void runOcrAndFinish(
      Activity activity,
      String imagePath,
      int width,
      int height,
      @Nullable String rectanglesJson,
      @Nullable String selectedRectJson) {
    runOcrAndFinish(activity, imagePath, width, height, rectanglesJson, selectedRectJson, null, null);
  }

  /**
   * As {@link #runOcrAndFinish(Activity, String, int, int, String, String)}
   * with stream-decoded fallbacks: when the hi-res ML Kit pass returns empty
   * text or no barcodes, the streaming analyzer's earlier decode is used so a
   * usable result is never thrown away (spec 2026-11-18-streaming-label-scan).
   */
  public void runOcrAndFinish(
      Activity activity,
      String imagePath,
      int width,
      int height,
      @Nullable String rectanglesJson,
      @Nullable String selectedRectJson,
      @Nullable String fallbackText,
      @Nullable String fallbackBarcodesJson) {
    if (activity.isFinishing() || activity.isDestroyed()) {
      return;
    }

    // Cancel any in-flight processor before starting a new one.
    cancel();

    try {
      InputImage inputImage = InputImage.fromFilePath(activity, Uri.fromFile(new File(imagePath)));
      OcrBarcodeProcessor processor = new OcrBarcodeProcessor();
      synchronized (this) {
        activeProcessor = processor;
      }

      WeakReference<Activity> activityRef = new WeakReference<>(activity);
      processor.process(inputImage, (text, barcodesJson) -> {
        synchronized (RectangleOcrHelper.this) {
          if (activeProcessor == processor) {
            activeProcessor = null;
          }
        }
        Activity currentActivity = activityRef.get();
        if (currentActivity == null || currentActivity.isFinishing() || currentActivity.isDestroyed()) {
          return;
        }
        String finalText = text != null && !text.isEmpty() ? text : (fallbackText != null ? fallbackText : "");
        String finalBarcodes = barcodesJson != null && !barcodesJson.equals("[]")
          ? barcodesJson
          : (fallbackBarcodesJson != null ? fallbackBarcodesJson : "[]");
        finishWithResult(currentActivity, imagePath, width, height, rectanglesJson, selectedRectJson, finalText, finalBarcodes);
      });
    } catch (IOException e) {
      Log.e(TAG, "Failed to load image for OCR", e);
      finishWithResult(
        activity,
        imagePath,
        width,
        height,
        rectanglesJson,
        selectedRectJson,
        fallbackText != null ? fallbackText : "",
        fallbackBarcodesJson != null ? fallbackBarcodesJson : "[]"
      );
    }
  }

  public void cancel() {
    OcrBarcodeProcessor processor;
    synchronized (this) {
      processor = activeProcessor;
      activeProcessor = null;
    }
    if (processor != null) {
      processor.cancel();
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
