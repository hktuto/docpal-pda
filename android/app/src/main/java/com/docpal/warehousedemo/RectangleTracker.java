package com.docpal.warehousedemo;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import org.opencv.core.Rect;

public class RectangleTracker {

  private static final long TRACK_TIMEOUT_MILLIS = 1000L;
  private static final double MIN_IOU = 0.3;

  public static class TrackedRect {
    public final int id;
    public RectangleDetector.RectResult rect;
    public long lastSeenMillis;

    public TrackedRect(int id, RectangleDetector.RectResult rect, long lastSeenMillis) {
      this.id = id;
      this.rect = rect;
      this.lastSeenMillis = lastSeenMillis;
    }
  }

  private int nextId = 1;
  private final List<TrackedRect> trackedRects = new ArrayList<>();

  public List<TrackedRect> update(List<RectangleDetector.RectResult> detections) {
    long now = System.currentTimeMillis();

    List<RectangleDetector.RectResult> unmatchedDetections = new ArrayList<>(detections);
    boolean[] matched = new boolean[trackedRects.size()];

    List<Match> candidates = new ArrayList<>();
    for (int d = 0; d < unmatchedDetections.size(); d++) {
      for (int t = 0; t < trackedRects.size(); t++) {
        double iou = computeIoU(unmatchedDetections.get(d).boundingBox, trackedRects.get(t).rect.boundingBox);
        if (iou >= MIN_IOU) {
          candidates.add(new Match(d, t, iou));
        }
      }
    }
    Collections.sort(candidates, Comparator.comparingDouble((Match m) -> m.iou).reversed());

    for (Match candidate : candidates) {
      if (matched[candidate.trackedIndex]) {
        continue;
      }
      if (candidate.detectionIndex < 0 || candidate.detectionIndex >= unmatchedDetections.size()) {
        continue;
      }
      RectangleDetector.RectResult detection = unmatchedDetections.get(candidate.detectionIndex);
      if (detection == null) {
        continue;
      }

      TrackedRect tracked = trackedRects.get(candidate.trackedIndex);
      tracked.rect = detection;
      tracked.lastSeenMillis = now;
      matched[candidate.trackedIndex] = true;
      unmatchedDetections.set(candidate.detectionIndex, null);
    }

    for (RectangleDetector.RectResult detection : unmatchedDetections) {
      if (detection != null) {
        trackedRects.add(new TrackedRect(nextId++, detection, now));
      }
    }

    List<TrackedRect> result = new ArrayList<>();
    for (int i = trackedRects.size() - 1; i >= 0; i--) {
      TrackedRect tracked = trackedRects.get(i);
      if (now - tracked.lastSeenMillis > TRACK_TIMEOUT_MILLIS) {
        trackedRects.remove(i);
      } else {
        result.add(tracked);
      }
    }

    return result;
  }

  public void clear() {
    trackedRects.clear();
  }

  private static double computeIoU(Rect a, Rect b) {
    int left = Math.max(a.x, b.x);
    int top = Math.max(a.y, b.y);
    int right = Math.min(a.x + a.width, b.x + b.width);
    int bottom = Math.min(a.y + a.height, b.y + b.height);

    if (right <= left || bottom <= top) {
      return 0.0;
    }

    double intersection = (right - left) * (double) (bottom - top);
    double areaA = a.width * (double) a.height;
    double areaB = b.width * (double) b.height;
    double union = areaA + areaB - intersection;

    return union > 0 ? intersection / union : 0.0;
  }

  private static class Match {
    final int detectionIndex;
    final int trackedIndex;
    final double iou;

    Match(int detectionIndex, int trackedIndex, double iou) {
      this.detectionIndex = detectionIndex;
      this.trackedIndex = trackedIndex;
      this.iou = iou;
    }
  }
}
