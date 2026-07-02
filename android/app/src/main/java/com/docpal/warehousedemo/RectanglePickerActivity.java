package com.docpal.warehousedemo;

import android.app.Activity;
import androidx.activity.ComponentActivity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.MotionEvent;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;
import androidx.annotation.Nullable;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.io.File;
import java.io.IOException;
import java.util.List;
import org.opencv.core.Mat;
import org.opencv.core.Point;
import org.opencv.imgcodecs.Imgcodecs;

public class RectanglePickerActivity extends ComponentActivity {

  public static final String EXTRA_IMAGE_PATH = "imagePath";
  public static final String EXTRA_WIDTH = "width";
  public static final String EXTRA_HEIGHT = "height";
  public static final String EXTRA_RECTANGLES_JSON = "rectanglesJson";
  public static final String EXTRA_IS_LABEL_SCAN = "isLabelScan";

  private static final String TAG = "RectanglePicker";
  private static final int JPEG_QUALITY = 95;
  private static final int DISPLAY_MAX_DIMENSION = 2048;
  private static final String CROP_FILE_PREFIX = "rectangle_picker_crop_";

  private ImageView imageView;
  private RectangleOverlayView overlayView;
  private TextView helpText;
  private Button cancelButton;

  private Bitmap displayBitmap;
  private String imagePath;
  private int imageWidth;
  private int imageHeight;
  private List<RectangleDetector.RectResult> rectangles;
  private boolean isLabelScan = false;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    setContentView(R.layout.activity_rectangle_picker);

    imageView = findViewById(R.id.imageView);
    overlayView = findViewById(R.id.overlayView);
    helpText = findViewById(R.id.helpText);
    cancelButton = findViewById(R.id.cancelButton);

    cancelButton.setOnClickListener(v -> {
      setResult(Activity.RESULT_CANCELED);
      finish();
    });

    overlayView.setOnTouchListener((v, event) -> {
      if (event.getAction() == MotionEvent.ACTION_DOWN) {
        return onOverlayTouched(event.getX(), event.getY());
      }
      return false;
    });

    Intent intent = getIntent();
    imagePath = intent.getStringExtra(EXTRA_IMAGE_PATH);
    imageWidth = intent.getIntExtra(EXTRA_WIDTH, 0);
    imageHeight = intent.getIntExtra(EXTRA_HEIGHT, 0);
    String rectanglesJson = intent.getStringExtra(EXTRA_RECTANGLES_JSON);
    isLabelScan = intent.getBooleanExtra(EXTRA_IS_LABEL_SCAN, false);

    if (imagePath == null || imageWidth == 0 || imageHeight == 0) {
      Toast.makeText(this, "Invalid capture data", Toast.LENGTH_SHORT).show();
      setResult(Activity.RESULT_CANCELED);
      finish();
      return;
    }

    rectangles = RectangleResultJson.fromJson(rectanglesJson);
    displayBitmap = loadSampledBitmap(imagePath, DISPLAY_MAX_DIMENSION);
    if (displayBitmap == null) {
      Toast.makeText(this, "Failed to decode image", Toast.LENGTH_SHORT).show();
      setResult(Activity.RESULT_CANCELED);
      finish();
      return;
    }

    imageView.setImageBitmap(displayBitmap);
    overlayView.setImageSize(imageWidth, imageHeight);
    overlayView.setRectangles(rectangles);

    if (rectangles.isEmpty()) {
      helpText.setText("No rectangles found");
    }
  }

  private boolean onOverlayTouched(float x, float y) {
    Point imagePoint = overlayView.mapTouchToImage(x, y);
    if (imagePoint == null) {
      return false;
    }

    for (RectangleDetector.RectResult rect : rectangles) {
      if (RectangleCropper.isPointInPolygon(imagePoint.x, imagePoint.y, rect.points)) {
        captureRect(rect);
        return true;
      }
    }
    return false;
  }

  private void captureRect(RectangleDetector.RectResult rect) {
    Mat sourceMat = Imgcodecs.imread(imagePath);
    if (sourceMat.empty()) {
      Toast.makeText(this, "Failed to load full image", Toast.LENGTH_SHORT).show();
      finish();
      return;
    }

    try {
      File cropFile = RectangleCropper.cropToFile(sourceMat, rect, JPEG_QUALITY, getCacheDir(), CROP_FILE_PREFIX);
      String selectedRectJson = RectangleResultJson.toJsonObject(rect).toString();
      String rectanglesJson = RectangleResultJson.toJson(rectangles);

      if (isLabelScan) {
        runOcrAndFinish(cropFile.getAbsolutePath(), rect.boundingBox.width, rect.boundingBox.height, rectanglesJson, selectedRectJson);
      } else {
        finishWithResult(cropFile.getAbsolutePath(), rect.boundingBox.width, rect.boundingBox.height, rectanglesJson, selectedRectJson);
      }
    } catch (IOException e) {
      Toast.makeText(this, "Failed to save crop: " + e.getMessage(), Toast.LENGTH_SHORT).show();
      finish();
    } finally {
      sourceMat.release();
    }
  }

  private void finishWithResult(
      String imagePath,
      int width,
      int height,
      @Nullable String rectanglesJson,
      @Nullable String selectedRectJson) {
    finishWithResult(imagePath, width, height, rectanglesJson, selectedRectJson, "");
  }

  private void finishWithResult(
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
    setResult(Activity.RESULT_OK, resultIntent);
    finish();
  }

  private void runOcrAndFinish(String imagePath, int width, int height, String rectanglesJson, String selectedRectJson) {
    try {
      InputImage inputImage = InputImage.fromFilePath(this, Uri.fromFile(new File(imagePath)));
      TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
      recognizer.process(inputImage)
        .addOnSuccessListener(visionText -> {
          String text = visionText.getText();
          Log.d(TAG, "OCR text: " + text);
          finishWithResult(imagePath, width, height, rectanglesJson, selectedRectJson, text);
        })
        .addOnFailureListener(e -> {
          Log.e(TAG, "OCR failed", e);
          finishWithResult(imagePath, width, height, rectanglesJson, selectedRectJson, "");
        });
    } catch (IOException e) {
      Log.e(TAG, "Failed to load image for OCR", e);
      finishWithResult(imagePath, width, height, rectanglesJson, selectedRectJson, "");
    }
  }

  @Override
  protected void onDestroy() {
    super.onDestroy();
    if (displayBitmap != null && !displayBitmap.isRecycled()) {
      displayBitmap.recycle();
    }
  }

  @Nullable
  private static Bitmap loadSampledBitmap(String path, int maxDimension) {
    try {
      BitmapFactory.Options options = new BitmapFactory.Options();
      options.inJustDecodeBounds = true;
      BitmapFactory.decodeFile(path, options);

      int sampleSize = 1;
      while (Math.max(options.outWidth, options.outHeight) / (sampleSize * 2) > maxDimension) {
        sampleSize *= 2;
      }

      options.inSampleSize = sampleSize;
      options.inJustDecodeBounds = false;
      return BitmapFactory.decodeFile(path, options);
    } catch (Exception e) {
      return null;
    }
  }
}
