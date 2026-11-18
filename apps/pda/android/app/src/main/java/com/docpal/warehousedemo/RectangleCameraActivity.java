package com.docpal.warehousedemo;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
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
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
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
  public static final String EXTRA_KEYWORDS = "keywords";
  public static final String EXTRA_ANALYSIS_SIZE = "analysisSize";
  public static final String ANALYSIS_SIZE_HD = "hd";
  public static final String MODE_DEFAULT = "default";
  public static final String MODE_LABEL_SCAN = "label_scan";
  public static final String MODE_LABEL_SCAN_STREAM = "label_scan_stream";

  private static final String TAG = "RectangleCamera";
  private static final int PICKER_REQUEST_CODE = 1001;
  private static final int JPEG_QUALITY = 92;
  private static final int DETECTION_MAX_DIMENSION = 1280;
  private static final String CAPTURE_FILE_PREFIX = "rectangle_capture_";
  private static final long STREAM_HINT_DELAY_MS = 20_000;

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
  private boolean streamMode = false;
  private StreamingLabelAnalyzer streamAnalyzer;
  private long streamOpenMs;
  private boolean streamFirstTickLogged;
  private final Handler mainHandler = new Handler(Looper.getMainLooper());
  private ActivityResultLauncher<String> requestPermissionLauncher;

  private final StreamingLabelAnalyzer.Listener streamListener = new StreamingLabelAnalyzer.Listener() {
    @Override
    public void onAnalysisSize(int width, int height) {
      streamWidth = width;
      streamHeight = height;
      if (!streamFirstTickLogged) {
        streamFirstTickLogged = true;
        Log.i(
          TAG,
          "STREAM-TIME first frame analyzed, open→first-tick=" +
            (SystemClock.elapsedRealtime() - streamOpenMs) +
            "ms"
        );
      }
    }

    @Override
    public void onCandidateTick(StreamingLabelGate.Candidate candidate) {
      overlayView.setHighlightRect(candidate);
    }

    @Override
    public void onStableCandidate(
        StreamingLabelGate.Candidate candidate,
        String frameImagePath,
        String matchedRule,
        String tickBarcodesJson) {
      onStreamCandidate(candidate, frameImagePath, matchedRule, tickBarcodesJson);
    }
  };

  private final Runnable streamHintRunnable = () -> {
    if (streamMode && captureMode == CaptureMode.NONE) {
      Toast
        .makeText(RectangleCameraActivity.this, R.string.stream_hint_manual_fallback, Toast.LENGTH_LONG)
        .show();
    }
  };

  static {
    OpenCVLoader.initDebug();
  }

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    setContentView(R.layout.activity_rectangle_camera);

    String mode = getIntent().getStringExtra(EXTRA_MODE);
    if (mode == null) mode = MODE_DEFAULT;
    streamMode = MODE_LABEL_SCAN_STREAM.equals(mode);
    isLabelScan = MODE_LABEL_SCAN.equals(mode) || streamMode;
    if (streamMode) {
      streamOpenMs = SystemClock.elapsedRealtime();
      Log.i(TAG, "STREAM-TIME camera activity opened");
    }

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
    if (streamMode) {
      StreamingLabelGate.Options streamOptions = new StreamingLabelGate.Options();
      ArrayList<String> rulesJson = getIntent().getStringArrayListExtra(EXTRA_KEYWORDS);
      if (rulesJson != null && !rulesJson.isEmpty()) {
        streamOptions.rules = parseRules(rulesJson);
      }
      streamAnalyzer = new StreamingLabelAnalyzer(this, streamListener, streamOptions);
      mainHandler.postDelayed(streamHintRunnable, STREAM_HINT_DELAY_MS);
    }
    startCamera();
  }

  /**
   * Streaming auto-fire: the analyzer's candidate IS the confirmed decode —
   * no full-res capture, no crop, no second OCR pass. The saved analysis
   * frame is the evidence photo. Returns to JS in ~100 ms.
   */
  private void onStreamCandidate(
      StreamingLabelGate.Candidate candidate,
      String frameImagePath,
      String matchedRule,
      String tickBarcodesJson) {
    if (captureMode != CaptureMode.NONE) {
      return;
    }
    if (streamAnalyzer != null) {
      streamAnalyzer.setPaused(true);
    }
    mainHandler.removeCallbacks(streamHintRunnable);
    overlayView.clearHighlightRect();
    Log.i(
      TAG,
      "STREAM-TIME gate fired, open→fire=" +
        (SystemClock.elapsedRealtime() - streamOpenMs) +
        "ms"
    );
    String text = candidate.isBarcode ? "" : candidate.value;
    String barcodes = tickBarcodesJson != null && !tickBarcodesJson.equals("[]")
      ? tickBarcodesJson
      : (candidate.isBarcode ? singleBarcodeJson(candidate) : "[]");
    runOnUiThread(() ->
      RectangleOcrHelper.finishWithResult(
        this,
        frameImagePath != null ? frameImagePath : "",
        streamWidth,
        streamHeight,
        null,
        null,
        text,
        barcodes,
        matchedRule
      )
    );
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

  private static String singleBarcodeJson(StreamingLabelGate.Candidate candidate) {
    JSONArray array = new JSONArray();
    try {
      JSONObject obj = new JSONObject();
      obj.put("value", candidate.value);
      obj.put("format", candidate.barcodeFormat != null ? candidate.barcodeFormat : "0");
      array.put(obj);
    } catch (JSONException e) {
      // ignore — worst case the fallback is an empty list
    }
    return array.toString();
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
    if (streamAnalyzer != null) {
      streamAnalyzer.resume();
    }
    runOnUiThread(() -> captureButton.setEnabled(true));
  }

  /**
   * Each entry is a JSON object {"name":…, "keywords":[…]} from the plugin's
   * rules option; unparseable entries are skipped.
   */
  private static StreamingLabelGate.ScanRule[] parseRules(List<String> rulesJson) {
    java.util.List<StreamingLabelGate.ScanRule> rules = new java.util.ArrayList<>();
    for (String json : rulesJson) {
      try {
        JSONObject obj = new JSONObject(json);
        String name = obj.optString("name", "");
        JSONArray keywordsJson = obj.optJSONArray("keywords");
        if (keywordsJson == null) {
          continue;
        }
        java.util.List<String> keywords = new java.util.ArrayList<>();
        for (int i = 0; i < keywordsJson.length(); i++) {
          keywords.add(keywordsJson.optString(i, ""));
        }
        rules.add(
          new StreamingLabelGate.ScanRule(name, keywords.toArray(new String[0]))
        );
      } catch (JSONException e) {
        Log.w(TAG, "Skipping unparseable scan rule: " + json);
      }
    }
    return rules.toArray(new StreamingLabelGate.ScanRule[0]);
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

    boolean hd = ANALYSIS_SIZE_HD.equals(getIntent().getStringExtra(EXTRA_ANALYSIS_SIZE));
    android.util.Size analysisSize = hd ? new android.util.Size(960, 720) : new android.util.Size(480, 640);
    ImageAnalysis imageAnalysis = new ImageAnalysis.Builder()
      .setTargetResolution(analysisSize)
      .setTargetRotation(rotation)
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .build();

    imageAnalysis.setAnalyzer(
      analysisExecutor,
      streamMode ? streamAnalyzer : new RectangleAnalyzer()
    );

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
      if (isLabelScan) {
        // Torch glare off glossy supplier labels hurts OCR decoding — label
        // scans start dark; the operator can still toggle it on in dim light.
        sTorchOn = false;
      }
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
    mainHandler.removeCallbacks(streamHintRunnable);
    if (analysisExecutor != null) {
      analysisExecutor.shutdown();
    }
    if (ocrHelper != null) {
      ocrHelper.cancel();
    }
    if (streamAnalyzer != null) {
      streamAnalyzer.close();
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
