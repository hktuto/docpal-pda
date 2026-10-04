package com.docpal.warehousedemo;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.opencv.core.Point;
import org.opencv.core.Rect;

/**
 * Serialises and deserialises rectangle detection results as JSON so they can
 * be passed between activities via Intent extras.
 */
public class RectangleResultJson {

  public static String toJson(List<RectangleDetector.RectResult> rectangles) {
    JSONArray array = new JSONArray();
    for (RectangleDetector.RectResult r : rectangles) {
      array.put(toJsonObject(r));
    }
    return array.toString();
  }

  public static JSONObject toJsonObject(RectangleDetector.RectResult rect) {
    JSONObject obj = new JSONObject();
    try {
      JSONArray pointsJson = new JSONArray();
      for (Point p : rect.points) {
        JSONObject pt = new JSONObject();
        pt.put("x", Math.round(p.x));
        pt.put("y", Math.round(p.y));
        pointsJson.put(pt);
      }
      obj.put("points", pointsJson);

      JSONObject box = new JSONObject();
      box.put("left", rect.boundingBox.x);
      box.put("top", rect.boundingBox.y);
      box.put("right", rect.boundingBox.x + rect.boundingBox.width);
      box.put("bottom", rect.boundingBox.y + rect.boundingBox.height);
      obj.put("boundingBox", box);

      obj.put("score", rect.score);
    } catch (JSONException e) {
      // ignore
    }
    return obj;
  }

  public static List<RectangleDetector.RectResult> fromJson(String json) {
    List<RectangleDetector.RectResult> list = new ArrayList<>();
    if (json == null || json.isEmpty()) {
      return list;
    }
    try {
      JSONArray array = new JSONArray(json);
      for (int i = 0; i < array.length(); i++) {
        list.add(fromJsonObject(array.getJSONObject(i)));
      }
    } catch (JSONException e) {
      // ignore
    }
    return list;
  }

  public static RectangleDetector.RectResult fromJsonObject(JSONObject obj) {
    try {
      JSONArray pointsJson = obj.getJSONArray("points");
      Point[] points = new Point[pointsJson.length()];
      int minX = Integer.MAX_VALUE;
      int minY = Integer.MAX_VALUE;
      int maxX = Integer.MIN_VALUE;
      int maxY = Integer.MIN_VALUE;

      for (int i = 0; i < points.length; i++) {
        JSONObject pt = pointsJson.getJSONObject(i);
        int x = pt.getInt("x");
        int y = pt.getInt("y");
        points[i] = new Point(x, y);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }

      Rect boundingBox = new Rect(minX, minY, maxX - minX, maxY - minY);
      double score = obj.optDouble("score", 0);
      return new RectangleDetector.RectResult(points, boundingBox, score);
    } catch (JSONException e) {
      return null;
    }
  }
}
