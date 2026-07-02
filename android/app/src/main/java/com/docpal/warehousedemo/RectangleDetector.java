package com.docpal.warehousedemo;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.opencv.core.Mat;
import org.opencv.core.MatOfPoint;
import org.opencv.core.MatOfPoint2f;
import org.opencv.core.Point;
import org.opencv.core.Rect;
import org.opencv.core.Size;
import org.opencv.imgproc.Imgproc;

/**
 * Shared OpenCV rectangle detection logic used by both the still-image plugin
 * and the live camera stream activity.
 */
public class RectangleDetector {

  public static class RectResult {
    public final Point[] points;
    public final Rect boundingBox;
    public final double score;

    public RectResult(Point[] points, Rect boundingBox, double score) {
      this.points = points;
      this.boundingBox = boundingBox;
      this.score = score;
    }
  }

  public static class Options {
    public int maxResults = 10;
    public double minAreaRatio = 0.005;
    public double maxAreaRatio = 0.95;
    public double minAspectRatio = 0.25;
    public double maxAspectRatio = 4.0;
    public double approximationEpsilon = 0.02;
  }

  public static List<RectResult> detect(Mat gray, Options options) {
    Mat blurred = new Mat();
    Imgproc.GaussianBlur(gray, blurred, new Size(5, 5), 0);

    Mat edges = new Mat();
    Imgproc.Canny(blurred, edges, 50, 150);

    List<MatOfPoint> contours = new ArrayList<>();
    Mat hierarchy = new Mat();
    Imgproc.findContours(edges, contours, hierarchy, Imgproc.RETR_EXTERNAL, Imgproc.CHAIN_APPROX_SIMPLE);

    double imageArea = gray.width() * gray.height();
    List<RectResult> result = new ArrayList<>();

    for (MatOfPoint contour : contours) {
      double area = Imgproc.contourArea(contour);
      if (area < imageArea * options.minAreaRatio || area > imageArea * options.maxAreaRatio) {
        continue;
      }

      MatOfPoint2f contour2f = new MatOfPoint2f(contour.toArray());
      double arcLength = Imgproc.arcLength(contour2f, true);
      MatOfPoint2f approx = new MatOfPoint2f();
      Imgproc.approxPolyDP(contour2f, approx, options.approximationEpsilon * arcLength, true);

      if (approx.total() == 4) {
        MatOfPoint approxPoints = new MatOfPoint(approx.toArray());
        if (Imgproc.isContourConvex(approxPoints)) {
          Point[] points = approx.toArray();
          Rect boundingBox = Imgproc.boundingRect(approxPoints);
          double boxArea = boundingBox.width * (double) boundingBox.height;
          if (boxArea <= 0) {
            continue;
          }

          double aspectRatio = boundingBox.width / (double) boundingBox.height;
          if (aspectRatio < options.minAspectRatio || aspectRatio > options.maxAspectRatio) {
            continue;
          }

          double rectangularity = area / boxArea;
          double areaScore = Math.min(1.0, area / (imageArea * 0.25));
          double score = rectangularity * 0.6 + areaScore * 0.4;

          result.add(new RectResult(points, boundingBox, score));
        }
      }

      contour2f.release();
      approx.release();
    }

    blurred.release();
    edges.release();
    hierarchy.release();

    Collections.sort(result, (a, b) -> Double.compare(b.score, a.score));

    if (result.size() > options.maxResults) {
      return result.subList(0, options.maxResults);
    }
    return result;
  }
}
