package com.docpal.warehousedemo;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import android.util.Log;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;
import org.opencv.android.OpenCVLoader;
import org.opencv.android.Utils;
import org.opencv.core.Mat;
import org.opencv.core.Point;
import org.opencv.core.Rect;
import org.opencv.core.Size;
import org.opencv.imgproc.Imgproc;

@CapacitorPlugin(name = "RectangleDetection")
public class RectangleDetectionPlugin extends Plugin {

  private static final String TAG = "RectangleDetection";
  private static final int MAX_PROCESSING_DIMENSION = 1280;

  static {
    if (!OpenCVLoader.initDebug()) {
      Log.e(TAG, "OpenCV initialization failed");
    }
  }

  @PluginMethod
  public void detectRectangles(PluginCall call) {
    String base64Image = call.getString("base64Image");
    if (base64Image == null || base64Image.isEmpty()) {
      call.reject("base64Image must be provided");
      return;
    }

    try {
      byte[] imageBytes = Base64.decode(base64Image, Base64.DEFAULT);
      Bitmap originalBitmap = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.length);
      if (originalBitmap == null) {
        call.reject("Unable to decode image");
        return;
      }

      int originalWidth = originalBitmap.getWidth();
      int originalHeight = originalBitmap.getHeight();

      Mat originalMat = new Mat();
      Utils.bitmapToMat(originalBitmap, originalMat);

      double scale = 1.0;
      Mat processingMat = originalMat;
      int maxDim = Math.max(originalWidth, originalHeight);
      if (maxDim > MAX_PROCESSING_DIMENSION) {
        scale = (double) MAX_PROCESSING_DIMENSION / maxDim;
        int newWidth = (int) Math.round(originalWidth * scale);
        int newHeight = (int) Math.round(originalHeight * scale);
        processingMat = new Mat();
        Imgproc.resize(originalMat, processingMat, new Size(newWidth, newHeight));
        originalMat.release();
      }

      RectangleDetector.Options options = optionsFromCall(call);
      List<RectangleDetector.RectResult> rectangles = RectangleDetector.detect(processingMat, options);

      // Scale coordinates back to the original image size.
      for (RectangleDetector.RectResult r : rectangles) {
        for (Point p : r.points) {
          p.x /= scale;
          p.y /= scale;
        }
        r.boundingBox.x = (int) Math.round(r.boundingBox.x / scale);
        r.boundingBox.y = (int) Math.round(r.boundingBox.y / scale);
        r.boundingBox.width = (int) Math.round(r.boundingBox.width / scale);
        r.boundingBox.height = (int) Math.round(r.boundingBox.height / scale);
      }

      processingMat.release();

      call.resolve(rectanglesToResult(rectangles, originalWidth, originalHeight));
    } catch (Exception exception) {
      Log.e(TAG, "detectRectangles failed", exception);
      call.reject(exception.getMessage(), exception);
    }
  }

  @PluginMethod
  public void startCameraStream(PluginCall call) {
    Intent intent = new Intent(getActivity(), RectangleCameraActivity.class);
    startActivityForResult(call, intent, "streamResult");
  }

  @PluginMethod
  public void scanLabel(PluginCall call) {
    Intent intent = new Intent(getActivity(), RectangleCameraActivity.class);
    intent.putExtra(RectangleCameraActivity.EXTRA_MODE, RectangleCameraActivity.MODE_LABEL_SCAN);
    startActivityForResult(call, intent, "scanLabelResult");
  }

  @ActivityCallback
  private void streamResult(PluginCall call, ActivityResult result) {
    if (call == null) {
      return;
    }
    if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
      Intent data = result.getData();
      JSObject capture = new JSObject();
      capture.put("imagePath", data.getStringExtra("imagePath"));
      capture.put("width", data.getIntExtra("width", 0));
      capture.put("height", data.getIntExtra("height", 0));

      String rectanglesJson = data.getStringExtra("rectanglesJson");
      if (rectanglesJson != null) {
        try {
          capture.put("rectangles", new JSArray(rectanglesJson));
        } catch (Exception e) {
          capture.put("rectangles", new JSArray());
        }
      } else {
        capture.put("rectangles", new JSArray());
      }

      String selectedRectJson = data.getStringExtra("selectedRect");
      if (selectedRectJson != null) {
        try {
          capture.put("selectedRect", new JSObject(selectedRectJson));
        } catch (Exception e) {
          // ignore
        }
      }

      call.resolve(capture);
    } else {
      call.reject("Cancelled");
    }
  }

  @ActivityCallback
  private void scanLabelResult(PluginCall call, ActivityResult result) {
    if (call == null) return;
    if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
      Intent data = result.getData();
      JSObject capture = new JSObject();
      capture.put("imagePath", data.getStringExtra("imagePath"));
      String text = data.getStringExtra("text");
      capture.put("text", text != null ? text : "");
      call.resolve(capture);
    } else {
      call.reject("Cancelled");
    }
  }

  private RectangleDetector.Options optionsFromCall(PluginCall call) {
    RectangleDetector.Options options = new RectangleDetector.Options();
    Integer maxResults = call.getInt("maxResults");
    if (maxResults != null) options.maxResults = maxResults;
    Double minAreaRatio = call.getDouble("minAreaRatio");
    if (minAreaRatio != null) options.minAreaRatio = minAreaRatio;
    Double maxAreaRatio = call.getDouble("maxAreaRatio");
    if (maxAreaRatio != null) options.maxAreaRatio = maxAreaRatio;
    Double minAspectRatio = call.getDouble("minAspectRatio");
    if (minAspectRatio != null) options.minAspectRatio = minAspectRatio;
    Double maxAspectRatio = call.getDouble("maxAspectRatio");
    if (maxAspectRatio != null) options.maxAspectRatio = maxAspectRatio;
    Double approximationEpsilon = call.getDouble("approximationEpsilon");
    if (approximationEpsilon != null) options.approximationEpsilon = approximationEpsilon;
    return options;
  }

  private JSObject rectanglesToResult(
    List<RectangleDetector.RectResult> rectangles,
    int width,
    int height
  ) {
    JSArray rects = new JSArray();

    for (RectangleDetector.RectResult r : rectangles) {
      JSObject rectJson = new JSObject();

      JSArray pointsJson = new JSArray();
      for (Point p : r.points) {
        JSObject pt = new JSObject();
        pt.put("x", Math.round(p.x));
        pt.put("y", Math.round(p.y));
        pointsJson.put(pt);
      }
      rectJson.put("points", pointsJson);

      JSObject boxJson = new JSObject();
      boxJson.put("left", r.boundingBox.x);
      boxJson.put("top", r.boundingBox.y);
      boxJson.put("right", r.boundingBox.x + r.boundingBox.width);
      boxJson.put("bottom", r.boundingBox.y + r.boundingBox.height);
      rectJson.put("boundingBox", boxJson);

      rectJson.put("score", r.score);
      rects.put(rectJson);
    }

    JSObject result = new JSObject();
    result.put("rectangles", rects);
    result.put("width", width);
    result.put("height", height);
    return result;
  }
}
