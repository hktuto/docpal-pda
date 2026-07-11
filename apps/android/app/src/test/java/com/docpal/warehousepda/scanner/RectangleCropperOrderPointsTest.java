package com.docpal.warehousepda.scanner;

import static org.junit.Assert.assertEquals;

import org.junit.Test;
import org.opencv.core.Point;

public class RectangleCropperOrderPointsTest {

  @Test
  public void orderPoints_ordersAxisAlignedRectangle() {
    Point topLeft = new Point(10, 20);
    Point topRight = new Point(110, 20);
    Point bottomRight = new Point(110, 80);
    Point bottomLeft = new Point(10, 80);

    Point[] input = { topRight, bottomLeft, topLeft, bottomRight };
    Point[] ordered = RectangleCropper.orderPoints(input);

    assertEquals("top-left x", topLeft.x, ordered[0].x, 0.001);
    assertEquals("top-left y", topLeft.y, ordered[0].y, 0.001);

    assertEquals("top-right x", topRight.x, ordered[1].x, 0.001);
    assertEquals("top-right y", topRight.y, ordered[1].y, 0.001);

    assertEquals("bottom-right x", bottomRight.x, ordered[2].x, 0.001);
    assertEquals("bottom-right y", bottomRight.y, ordered[2].y, 0.001);

    assertEquals("bottom-left x", bottomLeft.x, ordered[3].x, 0.001);
    assertEquals("bottom-left y", bottomLeft.y, ordered[3].y, 0.001);
  }

  @Test
  public void orderPoints_ordersRotatedRectangle() {
    Point topLeft = new Point(50, 10);
    Point topRight = new Point(90, 40);
    Point bottomRight = new Point(60, 90);
    Point bottomLeft = new Point(20, 60);

    Point[] input = { bottomRight, topLeft, bottomLeft, topRight };
    Point[] ordered = RectangleCropper.orderPoints(input);

    assertEquals("top-left x", topLeft.x, ordered[0].x, 0.001);
    assertEquals("top-left y", topLeft.y, ordered[0].y, 0.001);

    assertEquals("top-right x", topRight.x, ordered[1].x, 0.001);
    assertEquals("top-right y", topRight.y, ordered[1].y, 0.001);

    assertEquals("bottom-right x", bottomRight.x, ordered[2].x, 0.001);
    assertEquals("bottom-right y", bottomRight.y, ordered[2].y, 0.001);

    assertEquals("bottom-left x", bottomLeft.x, ordered[3].x, 0.001);
    assertEquals("bottom-left y", bottomLeft.y, ordered[3].y, 0.001);
  }
}
