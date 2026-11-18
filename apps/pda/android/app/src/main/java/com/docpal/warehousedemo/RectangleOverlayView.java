package com.docpal.warehousedemo;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.util.AttributeSet;
import android.view.View;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.opencv.core.Point;

/**
 * Draws detected rectangle polygons on top of the camera preview.
 * Coordinates are mapped from the analysis frame size to the view size
 * using FIT_CENTER letterboxing.
 */
public class RectangleOverlayView extends View {

  private final Paint paint;
  private final Paint highlightPaint;
  private final List<RectangleDetector.RectResult> rectangles = new ArrayList<>();
  private int imageWidth = 0;
  private int imageHeight = 0;
  private android.graphics.Rect highlightBox = null;

  public RectangleOverlayView(Context context) {
    this(context, null);
  }

  public RectangleOverlayView(Context context, AttributeSet attrs) {
    super(context, attrs);
    paint = new Paint();
    paint.setStyle(Paint.Style.STROKE);
    paint.setStrokeWidth(6f);
    paint.setColor(0xFF16A34A);
    paint.setAntiAlias(true);

    highlightPaint = new Paint();
    highlightPaint.setStyle(Paint.Style.STROKE);
    highlightPaint.setStrokeWidth(8f);
    highlightPaint.setColor(0xFFF59E0B);
    highlightPaint.setAntiAlias(true);
  }

  /** Highlights the current streaming-scan candidate box (image coordinates), or clears it. */
  public synchronized void setHighlightRect(StreamingLabelGate.Candidate candidate) {
    if (candidate == null) {
      highlightBox = null;
    } else {
      highlightBox = new android.graphics.Rect(
        candidate.left,
        candidate.top,
        candidate.right,
        candidate.bottom
      );
    }
    invalidate();
  }

  public synchronized void clearHighlightRect() {
    setHighlightRect(null);
  }

  public synchronized void setImageSize(int width, int height) {
    this.imageWidth = width;
    this.imageHeight = height;
  }

  public synchronized int getImageWidth() {
    return imageWidth;
  }

  public synchronized int getImageHeight() {
    return imageHeight;
  }

  public synchronized void setRectangles(List<RectangleDetector.RectResult> rectangles) {
    this.rectangles.clear();
    if (rectangles != null) {
      this.rectangles.addAll(rectangles);
    }
    invalidate();
  }

  public synchronized List<RectangleDetector.RectResult> getRectangles() {
    return Collections.unmodifiableList(new ArrayList<>(rectangles));
  }

  /**
   * Maps a touch coordinate to the corresponding image coordinate assuming
   * FIT_CENTER letterboxing. Returns null if the image size is not set.
   */
  public synchronized Point mapTouchToImage(float touchX, float touchY) {
    if (imageWidth == 0 || imageHeight == 0) {
      return null;
    }

    float viewW = getWidth();
    float viewH = getHeight();
    float scale = Math.min(viewW / imageWidth, viewH / imageHeight);
    float offsetX = (viewW - imageWidth * scale) / 2f;
    float offsetY = (viewH - imageHeight * scale) / 2f;

    return new Point(
      (touchX - offsetX) / scale,
      (touchY - offsetY) / scale
    );
  }

  @Override
  protected synchronized void onDraw(Canvas canvas) {
    super.onDraw(canvas);
    if (imageWidth == 0 || imageHeight == 0) {
      return;
    }

    float viewW = getWidth();
    float viewH = getHeight();
    float scale = Math.min(viewW / imageWidth, viewH / imageHeight);
    float offsetX = (viewW - imageWidth * scale) / 2f;
    float offsetY = (viewH - imageHeight * scale) / 2f;

    if (highlightBox != null) {
      canvas.drawRect(
        offsetX + highlightBox.left * scale,
        offsetY + highlightBox.top * scale,
        offsetX + highlightBox.right * scale,
        offsetY + highlightBox.bottom * scale,
        highlightPaint
      );
    }

    if (rectangles.isEmpty()) {
      return;
    }

    for (RectangleDetector.RectResult rect : rectangles) {
      Point[] pts = rect.points;
      if (pts == null || pts.length < 3) {
        continue;
      }

      Path path = new Path();
      path.moveTo(offsetX + (float) pts[0].x * scale, offsetY + (float) pts[0].y * scale);
      for (int i = 1; i < pts.length; i++) {
        path.lineTo(offsetX + (float) pts[i].x * scale, offsetY + (float) pts[i].y * scale);
      }
      path.close();
      canvas.drawPath(path, paint);
    }
  }
}
