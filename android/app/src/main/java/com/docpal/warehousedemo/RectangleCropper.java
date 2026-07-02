package com.docpal.warehousedemo;

import android.util.Base64;
import java.io.File;
import java.io.IOException;
import org.opencv.core.Mat;
import org.opencv.core.MatOfByte;
import org.opencv.core.MatOfInt;
import org.opencv.core.MatOfPoint2f;
import org.opencv.core.Point;
import org.opencv.core.Rect;
import org.opencv.core.Size;
import org.opencv.imgcodecs.Imgcodecs;
import org.opencv.imgproc.Imgproc;

/**
 * Crops a detected rectangle from a source image using a perspective transform.
 * Works with both grayscale and colour Mats.
 */
public class RectangleCropper {

  public static String cropToBase64(Mat source, RectangleDetector.RectResult rect, int quality) {
    Mat cropped = crop(source, rect);
    String base64 = matToBase64(cropped, quality);
    cropped.release();
    return base64;
  }

  public static File cropToFile(
      Mat source,
      RectangleDetector.RectResult rect,
      int quality,
      File directory,
      String prefix) throws IOException {
    Mat cropped = crop(source, rect);
    Mat encoded = toRgbForEncoding(cropped);
    File file = File.createTempFile(prefix, ".jpg", directory);
    boolean ok = Imgcodecs.imwrite(file.getAbsolutePath(), encoded);
    cropped.release();
    encoded.release();
    if (!ok) {
      throw new IOException("Failed to write cropped image to " + file.getAbsolutePath());
    }
    return file;
  }

  public static Mat crop(Mat source, RectangleDetector.RectResult rect) {
    Point[] ordered = orderPoints(rect.points);

    double widthTop = distance(ordered[0], ordered[1]);
    double widthBottom = distance(ordered[2], ordered[3]);
    double maxWidth = Math.max(widthTop, widthBottom);

    double heightLeft = distance(ordered[0], ordered[3]);
    double heightRight = distance(ordered[1], ordered[2]);
    double maxHeight = Math.max(heightLeft, heightRight);

    int outputWidth = Math.max(1, (int) Math.round(maxWidth));
    int outputHeight = Math.max(1, (int) Math.round(maxHeight));

    MatOfPoint2f src = new MatOfPoint2f(
      ordered[0],
      ordered[1],
      ordered[2],
      ordered[3]
    );

    MatOfPoint2f dst = new MatOfPoint2f(
      new Point(0, 0),
      new Point(outputWidth, 0),
      new Point(outputWidth, outputHeight),
      new Point(0, outputHeight)
    );

    Mat transform = Imgproc.getPerspectiveTransform(src, dst);
    Mat output = new Mat();
    Imgproc.warpPerspective(
      source,
      output,
      transform,
      new Size(outputWidth, outputHeight)
    );

    transform.release();
    src.release();
    dst.release();
    return output;
  }

  public static RectangleDetector.RectResult scaleRect(
      RectangleDetector.RectResult rect,
      double scaleX,
      double scaleY) {
    Point[] scaled = new Point[rect.points.length];
    for (int i = 0; i < rect.points.length; i++) {
      scaled[i] = new Point(rect.points[i].x * scaleX, rect.points[i].y * scaleY);
    }

    Rect box = new Rect(
      (int) Math.round(rect.boundingBox.x * scaleX),
      (int) Math.round(rect.boundingBox.y * scaleY),
      (int) Math.round(rect.boundingBox.width * scaleX),
      (int) Math.round(rect.boundingBox.height * scaleY)
    );

    return new RectangleDetector.RectResult(scaled, box, rect.score);
  }

  /**
   * Converts a Mat to RGB before JPEG encoding.
   * OpenCV Mats from {@code Utils.bitmapToMat} are RGBA, Mats from
   * {@code Imgcodecs.imread} are BGR, and browsers/Android ImageViews expect
   * RGB JPEGs. Grayscale Mats are passed through unchanged.
   */
  public static Mat toRgbForEncoding(Mat src) {
    Mat dst = new Mat();
    switch (src.channels()) {
      case 1:
        src.copyTo(dst);
        break;
      case 3:
        Imgproc.cvtColor(src, dst, Imgproc.COLOR_BGR2RGB);
        break;
      case 4:
        Imgproc.cvtColor(src, dst, Imgproc.COLOR_RGBA2RGB);
        break;
      default:
        src.copyTo(dst);
        break;
    }
    return dst;
  }

  /**
   * Orders four points as top-left, top-right, bottom-right, bottom-left.
   */
  public static Point[] orderPoints(Point[] points) {
    Point[] sorted = new Point[4];
    System.arraycopy(points, 0, sorted, 0, 4);

    // top-left has the smallest sum, bottom-right the largest.
    java.util.Arrays.sort(sorted, (a, b) -> Double.compare(a.x + a.y, b.x + b.y));
    Point topLeft = sorted[0];
    Point bottomRight = sorted[3];

    // top-right has the smallest (y - x), bottom-left the largest.
    java.util.Arrays.sort(sorted, (a, b) -> Double.compare(a.y - a.x, b.y - b.x));
    Point topRight = sorted[0];
    Point bottomLeft = sorted[3];

    return new Point[] { topLeft, topRight, bottomRight, bottomLeft };
  }

  public static boolean isPointInPolygon(double x, double y, Point[] polygon) {
    boolean inside = false;
    int n = polygon.length;
    for (int i = 0, j = n - 1; i < n; j = i++) {
      double xi = polygon[i].x;
      double yi = polygon[i].y;
      double xj = polygon[j].x;
      double yj = polygon[j].y;

      boolean intersect =
        ((yi > y) != (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) {
        inside = !inside;
      }
    }
    return inside;
  }

  public static File matToFile(Mat mat, int quality, File directory, String prefix) throws IOException {
    File file = File.createTempFile(prefix, ".jpg", directory);
    Mat encoded = toRgbForEncoding(mat);
    boolean ok = Imgcodecs.imwrite(file.getAbsolutePath(), encoded);
    encoded.release();
    if (!ok) {
      throw new IOException("Failed to write image to " + file.getAbsolutePath());
    }
    return file;
  }

  public static String matToBase64(Mat mat, int quality) {
    Mat encoded = toRgbForEncoding(mat);
    MatOfByte buffer = new MatOfByte();
    MatOfInt params = new MatOfInt(Imgcodecs.IMWRITE_JPEG_QUALITY, quality);
    Imgcodecs.imencode(".jpg", encoded, buffer, params);
    encoded.release();
    params.release();
    byte[] bytes = buffer.toArray();
    buffer.release();
    return Base64.encodeToString(bytes, Base64.NO_WRAP);
  }

  private static double distance(Point a, Point b) {
    double dx = a.x - b.x;
    double dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}
