package com.docpal.warehousedemo;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import androidx.annotation.Nullable;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.io.File;
import java.io.IOException;

public class RectangleOcrHelper {

  private static final String TAG = "RectangleOcrHelper";

  @Nullable
  private TextRecognizer activeRecognizer;

  public void runOcrAndFinish(
      Activity activity,
      String imagePath,
      int width,
      int height,
      @Nullable String rectanglesJson,
      @Nullable String selectedRectJson) {
    try {
      InputImage inputImage = InputImage.fromFilePath(activity, Uri.fromFile(new File(imagePath)));
      TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
      synchronized (this) {
        activeRecognizer = recognizer;
      }
      recognizer
        .process(inputImage)
        .addOnSuccessListener(visionText -> {
          String text = visionText.getText();
          Log.d(TAG, "OCR text: " + text);
          closeActiveRecognizer();
          finishWithResult(activity, imagePath, width, height, rectanglesJson, selectedRectJson, text);
        })
        .addOnFailureListener(e -> {
          Log.e(TAG, "OCR failed", e);
          closeActiveRecognizer();
          finishWithResult(activity, imagePath, width, height, rectanglesJson, selectedRectJson, "");
        });
    } catch (IOException e) {
      Log.e(TAG, "Failed to load image for OCR", e);
      finishWithResult(activity, imagePath, width, height, rectanglesJson, selectedRectJson, "");
    }
  }

  public void cancel() {
    closeActiveRecognizer();
  }

  private synchronized void closeActiveRecognizer() {
    if (activeRecognizer != null) {
      try {
        activeRecognizer.close();
      } catch (Exception e) {
        Log.e(TAG, "Failed to close TextRecognizer", e);
      }
      activeRecognizer = null;
    }
  }

  public static void finishWithResult(
      Activity activity,
      String imagePath,
      int width,
      int height,
      @Nullable String rectanglesJson,
      @Nullable String selectedRectJson) {
    finishWithResult(activity, imagePath, width, height, rectanglesJson, selectedRectJson, "");
  }

  public static void finishWithResult(
      Activity activity,
      String imagePath,
      int width,
      int height,
      @Nullable String rectanglesJson,
      @Nullable String selectedRectJson,
      @Nullable String text) {
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
    activity.setResult(Activity.RESULT_OK, resultIntent);
    activity.finish();
  }
}
