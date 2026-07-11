package com.docpal.warehousepda.scanner;
import com.docpal.warehousepda.R;

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
        finishWithResult(currentActivity, imagePath, width, height, rectanglesJson, selectedRectJson, text, barcodesJson);
      });
    } catch (IOException e) {
      Log.e(TAG, "Failed to load image for OCR", e);
      finishWithResult(activity, imagePath, width, height, rectanglesJson, selectedRectJson, "", "[]");
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
