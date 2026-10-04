package com.docpal.warehousedemo;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.os.Bundle;
import android.util.Log;
import android.view.MotionEvent;
import android.view.Surface;
import android.widget.ImageButton;
import android.widget.Toast;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.opencv.android.OpenCVLoader;
import org.opencv.core.Core;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.MatOfByte;
import org.opencv.core.Point;
import org.opencv.core.Size;
import org.opencv.imgcodecs.Imgcodecs;
import org.opencv.imgproc.Imgproc;

public class RectangleCameraActivity extends ComponentActivity {

  public static final String EXTRA_MODE = "mode";
  public static final String MODE_DEFAULT = "default";
  public static final String MODE_LABEL_SCAN = "label_scan";

  private static final String TAG = "RectangleCamera";
  private static final int PICKER_REQUEST_CODE = 1001;
  private static final int JPEG_QUALITY = 92;
  private static final int DETECTION_MAX_DIMENSION = 1280;
  private static final String CAPTURE_FILE_PREFIX = "rectangle_capture_";

  private PreviewView previewView;
  private RectangleOverlayView overlayView;
  private ImageButton cancelButton;
  private ImageButton captureButton;
  private ImageButton flashButton;
  private ExecutorService analysisExecutor;

  private static boolean sTorchOn = true;
  private Camera camera;

  private ImageCapture imageCapture;
  private volatile int streamWidth = 0;
  private volatile int streamHeight = 0;
  private RectangleOcrHelper ocrHelper;
  private RectangleTracker rectangleTracker;
  private volatile List<RectangleTracker.TrackedRect> currentTrackedRects = new ArrayList<>();

  private enum CaptureMode {
    NONE,
    SHUTTER,
    TAP_RECT,
  }

  private volatile CaptureMode captureMode = CaptureMode.NONE;
  private volatile RectangleDetector.RectResult pendingTapRect = null;
  private boolean isLabelScan = false;
  private ActivityResultLauncher<String> requestPermissionLauncher;

  static {
    OpenCVLoader.initDebug();
  }

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    setContentView(R.layout.activity_rectangle_camera);

    String mode = getIntent().getStringExtra(EXTRA_MODE);
    if (mode == null) mode = MODE_DEFAULT;
    isLabelScan = MODE_LABEL_SCAN.equals(mode);

    previewView = findViewById(R.id.previewView);
    overlayView = findViewById(R.id.overlayView);
    cancelButton = findViewById(R.id.cancelButton);
    captureButton = findViewById(R.id.captureButton);
    flashButton = findViewById(R.id.flashButton);

    cancelButton.setOnClickListener(v -> finish());
    captureButton.setOnClickListener(v -> onShutterClicked());
    flashButton.setOnClickListener(v -> toggleTorch());

    overlayView.setOnTouchListener((v, event) -> {
      if (event.getAction() == MotionEvent.ACTION_DOWN) {
        return onOverlayTouched(event.getX(), event.getY());
      }
      return false;
    });

    requestPermissionLauncher = registerForActivityResult(
      new ActivityResultContracts.RequestPermission(),
      isGranted -> {
        if (isGranted) {
          initializeCamera();
        } else {
          Toast.makeText(this, "Camera permission required", Toast.LENGTH_SHORT).show();
          finish();
        }
      }
    );

    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
        != PackageManager.PERMISSION_GRANTED) {
      requestPermissionLauncher.launch(Manifest.permission.CAMERA);
    } else {
      initializeCamera();
    }
  }

  private void initializeCamera() {
    previewView.setScaleType(PreviewView.ScaleType.FIT_CENTER);
    analysisExecutor = Executors.newSingleThreadExecutor();
    ocrHelper = new RectangleOcrHelper();
    rectangleTracker = new RectangleTracker();
    startCamera();
  }

  private void onShutterClicked() {
    if (captureMode != CaptureMode.NONE || imageCapture == null) {
      return;
    }
    captureMode = CaptureMode.SHUTTER;
    captureButton.setEnabled(false);
    Toast.makeText(this, "Capturing…", Toast.LENGTH_SHORT).show();
    takePicture();
  }

  private void toggleTorch() {
    if (camera == null) {
      return;
    }
    sTorchOn = !sTorchOn;
    applyTorchState();
    updateFlashIcon();
  }

  private void applyTorchState() {
    if (camera == null) {
      return;
    }
    ListenableFuture<Void> future = camera.getCameraControl().enableTorch(sTorchOn);
    future.addListener(
      () -> {
        try {
          future.get();
        } catch (Exception e) {
          Log.e(TAG, "Failed to set torch state", e);
          runOnUiThread(() ->
            Toast
              .makeText(RectangleCameraActivity.this, "Flash error: " + e.getMessage(), Toast.LENGTH_SHORT)
              .show()
          );
        }
      },
      ContextCompat.getMainExecutor(RectangleCameraActivity.this)
    );
  }

  private void updateFlashIcon() {
    flashButton.setImageResource(sTorchOn ? R.drawable.ic_flash_on : R.drawable.ic_flash_off);
  }

  private boolean onOverlayTouched(float x, float y) {
    if (captureMode != CaptureMode.NONE || imageCapture == null) {
      return false;
    }

    Point imagePoint = overlayView.mapTouchToImage(x, y);
    if (imagePoint == null) {
      return false;
    }

    for (RectangleTracker.TrackedRect tracked : currentTrackedRects) {
      if (RectangleCropper.isPointInPolygon(imagePoint.x, imagePoint.y, tracked.rect.points)) {
        captureMode = CaptureMode.TAP_RECT;
        pendingTapRect = tracked.rect;
        takePicture();
        return true;
      }
    }
    return false;
  }

  private void takePicture() {
    imageCapture.takePicture(
      analysisExecutor,
      new ImageCapture.OnImageCapturedCallback() {
        @Override
        public void onCaptureSuccess(@NonNull ImageProxy image) {
          processCapturedImage(image);
        }

        @Override
        public void onError(@NonNull ImageCaptureException exception) {
          runOnUiThread(() -> {
            captureMode = CaptureMode.NONE;
            pendingTapRect = null;
            captureButton.setEnabled(true);
            Toast.makeText(
                RectangleCameraActivity.this,
                "Capture failed: " + exception.getMessage(),
                Toast.LENGTH_SHORT
              )
              .show();
          });
        }
      }
    );
  }

  private void processCapturedImage(ImageProxy image) {
    CaptureMode mode = captureMode;
    RectangleDetector.RectResult tapRect = pendingTapRect;

    int rotationDegrees = image.getImageInfo().getRotationDegrees();
    int captureFormat = image.getFormat();
    Mat captured = decodeCapturedImage(image);
    if (captured == null || captured.empty()) {
      runOnUiThread(() -> {
        Toast.makeText(this, "Failed to decode captured image", Toast.LENGTH_SHORT).show();
        resetCaptureState();
      });
      return;
    }

    Mat rotated;
    if (captureFormat == ImageFormat.JPEG) {
      // decodeCapturedImage already rotates the JPEG to match device orientation.
      rotated = captured;
    } else {
      rotated = rotateMat(captured, rotationDegrees);
      captured.release();
    }

    int originalWidth = rotated.width();
    int originalHeight = rotated.height();

    if (mode == CaptureMode.TAP_RECT && tapRect != null) {
      processTapCapture(rotated, originalWidth, originalHeight, tapRect);
    } else if (mode == CaptureMode.SHUTTER) {
      processShutterCapture(rotated, originalWidth, originalHeight);
    } else {
      rotated.release();
      resetCaptureState();
    }
  }

  @Nullable
  private Mat decodeCapturedImage(ImageProxy image) {
    try {
      int format = image.getFormat();
      int rotationDegrees = image.getImageInfo().getRotationDegrees();
      Log.d(
        TAG,
        "decodeCapturedImage format=" +
          format +
          " rotation=" +
          rotationDegrees +
          " size=" +
          image.getWidth() +
          "x" +
          image.getHeight()
      );

      if (format == ImageFormat.JPEG) {
        ByteBuffer buffer = image.getPlanes()[0].getBuffer();
        byte[] bytes = new byte[buffer.remaining()];
        buffer.get(bytes);

        Mat decoded = Imgcodecs.imdecode(new MatOfByte(bytes), Imgcodecs.IMREAD_GRAYSCALE);
        if (decoded == null || decoded.empty()) {
          Log.e(TAG, "Failed to decode JPEG capture");
          return null;
        }

        Mat rotated = rotateMat(decoded, rotationDegrees);
        decoded.release();
        return rotated;
      } else if (format == ImageFormat.YUV_420_888 && image.getPlanes().length >= 1) {
        ImageProxy.PlaneProxy yPlane = image.getPlanes()[0];
        Mat gray = new Mat(
          image.getHeight(),
          image.getWidth(),
          CvType.CV_8UC1,
          yPlane.getBuffer(),
          yPlane.getRowStride()
        );
        Mat copy = new Mat();
        gray.copyTo(copy);
        return copy;
      } else {
        Log.w(TAG, "Unsupported capture image format: " + format);
        return null;
      }
    } finally {
      image.close();
    }
  }

  private void processTapCapture(
      Mat rotated,
      int originalWidth,
      int originalHeight,
      RectangleDetector.RectResult tapRect) {
    try {
      double scaleX = streamWidth > 0 ? (double) originalWidth / streamWidth : 1.0;
      double scaleY = streamHeight > 0 ? (double) originalHeight / streamHeight : 1.0;

      RectangleDetector.RectResult scaledRect = RectangleCropper.scaleRect(tapRect, scaleX, scaleY);
      File cropFile = RectangleCropper.cropToFile(rotated, scaledRect, JPEG_QUALITY, getCacheDir(), CAPTURE_FILE_PREFIX + "crop_");
      String selectedRectJson = RectangleResultJson.toJsonObject(scaledRect).toString();

      runOnUiThread(() -> {
        if (isLabelScan) {
          ocrHelper.runOcrAndFinish(this, cropFile.getAbsolutePath(), originalWidth, originalHeight, null, selectedRectJson);
        } else {
          RectangleOcrHelper.finishWithResult(this, cropFile.getAbsolutePath(), originalWidth, originalHeight, null, selectedRectJson);
        }
      });
    } catch (IOException e) {
      runOnUiThread(() -> {
        Toast.makeText(this, "Failed to save crop: " + e.getMessage(), Toast.LENGTH_SHORT).show();
        resetCaptureState();
      });
    } finally {
      rotated.release();
    }
  }

  private void processShutterCapture(Mat rotated, int originalWidth, int originalHeight) {
    try {
      Mat processingMat = rotated;
      double scale = 1.0;
      int maxDim = Math.max(originalWidth, originalHeight);
      if (maxDim > DETECTION_MAX_DIMENSION) {
        scale = (double) DETECTION_MAX_DIMENSION / maxDim;
        int newWidth = (int) Math.round(originalWidth * scale);
        int newHeight = (int) Math.round(originalHeight * scale);
        processingMat = new Mat();
        Imgproc.resize(rotated, processingMat, new Size(newWidth, newHeight));
      }

      RectangleDetector.Options options = new RectangleDetector.Options();
      options.maxResults = 10;
      options.minAreaRatio = 0.005;
      options.maxAreaRatio = 0.95;
      options.minAspectRatio = 0.25;
      options.maxAspectRatio = 4.0;

      List<RectangleDetector.RectResult> detected = RectangleDetector.detect(processingMat, options);

      if (processingMat != rotated) {
        processingMat.release();
      }

      List<RectangleDetector.RectResult> scaledRects = new ArrayList<>();
      for (RectangleDetector.RectResult r : detected) {
        scaledRects.add(RectangleCropper.scaleRect(r, 1.0 / scale, 1.0 / scale));
      }

      String rectanglesJson = RectangleResultJson.toJson(scaledRects);

      File captureFile = RectangleCropper.matToFile(rotated, JPEG_QUALITY, getCacheDir(), CAPTURE_FILE_PREFIX + "full_");

      runOnUiThread(() ->
        startPicker(captureFile.getAbsolutePath(), originalWidth, originalHeight, rectanglesJson)
      );
    } catch (IOException e) {
      runOnUiThread(() -> {
        Toast.makeText(this, "Failed to save capture: " + e.getMessage(), Toast.LENGTH_SHORT).show();
        resetCaptureState();
      });
    } finally {
      rotated.release();
    }
  }

  private void resetCaptureState() {
    captureMode = CaptureMode.NONE;
    pendingTapRect = null;
    runOnUiThread(() -> captureButton.setEnabled(true));
  }

  private void startCamera() {
    ListenableFuture<ProcessCameraProvider> cameraProviderFuture =
        ProcessCameraProvider.getInstance(this);

    cameraProviderFuture.addListener(
      () -> {
        try {
          ProcessCameraProvider cameraProvider = cameraProviderFuture.get();
          bindCamera(cameraProvider);
        } catch (Exception exception) {
          Toast.makeText(
              RectangleCameraActivity.this,
              "Failed to start camera: " + exception.getMessage(),
              Toast.LENGTH_SHORT
            )
            .show();
          finish();
        }
      },
      ContextCompat.getMainExecutor(this)
    );
  }

  private void bindCamera(ProcessCameraProvider cameraProvider) {
    int rotation = previewView.getDisplay() != null
      ? previewView.getDisplay().getRotation()
      : Surface.ROTATION_0;

    Preview preview = new Preview.Builder()
      .setTargetRotation(rotation)
      .build();
    preview.setSurfaceProvider(previewView.getSurfaceProvider());

    ImageAnalysis imageAnalysis = new ImageAnalysis.Builder()
      .setTargetResolution(new android.util.Size(480, 640))
      .setTargetRotation(rotation)
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .build();

    imageAnalysis.setAnalyzer(analysisExecutor, new RectangleAnalyzer());

    imageCapture = new ImageCapture.Builder()
      .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
      .setTargetRotation(rotation)
      .build();

    CameraSelector cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA;
    camera = cameraProvider.bindToLifecycle(
      this,
      cameraSelector,
      preview,
      imageAnalysis,
      imageCapture
    );

    if (camera != null && camera.getCameraInfo().hasFlashUnit()) {
      applyTorchState();
      updateFlashIcon();
      flashButton.setVisibility(android.view.View.VISIBLE);
    } else {
      flashButton.setVisibility(android.view.View.GONE);
    }
  }

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

  private void startPicker(String imagePath, int width, int height, String rectanglesJson) {
    Intent intent = new Intent(this, RectanglePickerActivity.class);
    intent.putExtra(RectanglePickerActivity.EXTRA_IMAGE_PATH, imagePath);
    intent.putExtra(RectanglePickerActivity.EXTRA_WIDTH, width);
    intent.putExtra(RectanglePickerActivity.EXTRA_HEIGHT, height);
    intent.putExtra(RectanglePickerActivity.EXTRA_RECTANGLES_JSON, rectanglesJson);
    intent.putExtra(RectanglePickerActivity.EXTRA_IS_LABEL_SCAN, isLabelScan);
    startActivityForResult(intent, PICKER_REQUEST_CODE);
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != PICKER_REQUEST_CODE) {
      return;
    }
    if (resultCode == Activity.RESULT_OK && data != null) {
      setResult(Activity.RESULT_OK, data);
      finish();
    } else if (resultCode == Activity.RESULT_CANCELED) {
      // User cancelled the picker; release the capture lock so they can try again.
      resetCaptureState();
    }
  }

  @Override
  protected void onDestroy() {
    super.onDestroy();
    if (analysisExecutor != null) {
      analysisExecutor.shutdown();
    }
    if (ocrHelper != null) {
      ocrHelper.cancel();
    }
    if (rectangleTracker != null) {
      rectangleTracker.clear();
    }
  }

  private static class DetectionResult {
    final int width;
    final int height;
    final List<RectangleDetector.RectResult> rectangles;

    DetectionResult(int width, int height, List<RectangleDetector.RectResult> rectangles) {
      this.width = width;
      this.height = height;
      this.rectangles = rectangles;
    }
  }

  private class RectangleAnalyzer implements ImageAnalysis.Analyzer {

    private final RectangleDetector.Options options;

    RectangleAnalyzer() {
      this.options = new RectangleDetector.Options();
      this.options.maxResults = 5;
      this.options.minAreaRatio = 0.01;
      this.options.maxAreaRatio = 0.9;
      this.options.minAspectRatio = 0.3;
      this.options.maxAspectRatio = 3.0;
    }

    @Override
    public void analyze(@NonNull ImageProxy image) {
      ImageProxy.PlaneProxy yPlane = image.getPlanes()[0];
      Mat gray = new Mat(
        image.getHeight(),
        image.getWidth(),
        CvType.CV_8UC1,
        yPlane.getBuffer(),
        yPlane.getRowStride()
      );

      int rotationDegrees = image.getImageInfo().getRotationDegrees();
      Mat rotated = rotateMat(gray, rotationDegrees);
      gray.release();

      List<RectangleDetector.RectResult> rectangles = RectangleDetector.detect(rotated, options);

      DetectionResult result = new DetectionResult(
        rotated.width(),
        rotated.height(),
        rectangles
      );

      runOnUiThread(() -> onDetectionResult(result));

      rotated.release();
      image.close();
    }
  }

  private static Mat rotateMat(Mat src, int degrees) {
    Mat dst = new Mat();
    switch (degrees) {
      case 90:
        Core.transpose(src, dst);
        Core.flip(dst, dst, 1);
        break;
      case 180:
        Core.flip(src, dst, -1);
        break;
      case 270:
        Core.transpose(src, dst);
        Core.flip(dst, dst, 0);
        break;
      default:
        src.copyTo(dst);
        break;
    }
    return dst;
  }

}
