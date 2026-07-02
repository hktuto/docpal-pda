package com.docpal.warehousedemo;

import android.net.Uri;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.objects.DetectedObject;
import com.google.mlkit.vision.objects.ObjectDetection;
import com.google.mlkit.vision.objects.ObjectDetector;
import com.google.mlkit.vision.objects.defaults.ObjectDetectorOptions;
import java.util.List;

@CapacitorPlugin(name = "ObjectDetection")
public class ObjectDetectionPlugin extends Plugin {

    @PluginMethod
    public void detectObjects(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("path must be provided");
            return;
        }

        double confidenceThresholdDouble = call.getDouble("confidence", 0.5);
        float confidenceThreshold = (float) confidenceThresholdDouble;
        boolean enableMultiple = call.getBoolean("enableMultipleObjects", true);
        boolean enableClassification = call.getBoolean("enableClassification", true);

        try {
            InputImage image = InputImage.fromFilePath(getContext(), Uri.parse(path));

            ObjectDetectorOptions.Builder builder = new ObjectDetectorOptions.Builder()
                .setDetectorMode(ObjectDetectorOptions.SINGLE_IMAGE_MODE);

            if (enableMultiple) {
                builder.enableMultipleObjects();
            }

            if (enableClassification) {
                builder.enableClassification();
            }

            ObjectDetector detector = ObjectDetection.getClient(builder.build());

            detector
                .process(image)
                .addOnSuccessListener(detectedObjects -> {
                    detector.close();
                    call.resolve(objectsToResult(detectedObjects, confidenceThreshold));
                })
                .addOnFailureListener(exception -> {
                    detector.close();
                    call.reject(exception.getMessage(), exception);
                });
        } catch (Exception exception) {
            call.reject(exception.getMessage(), exception);
        }
    }

    private JSObject objectsToResult(List<DetectedObject> detectedObjects, float confidenceThreshold) {
        JSArray objectsArray = new JSArray();

        for (DetectedObject object : detectedObjects) {
            JSObject objectJson = new JSObject();

            Integer trackingId = object.getTrackingId();
            if (trackingId != null) {
                objectJson.put("trackingId", trackingId);
            }

            android.graphics.Rect box = object.getBoundingBox();
            JSObject boxJson = new JSObject();
            boxJson.put("left", box.left);
            boxJson.put("top", box.top);
            boxJson.put("right", box.right);
            boxJson.put("bottom", box.bottom);
            objectJson.put("boundingBox", boxJson);

            JSArray labelsArray = new JSArray();
            for (DetectedObject.Label label : object.getLabels()) {
                if (label.getConfidence() >= confidenceThreshold) {
                    JSObject labelJson = new JSObject();
                    labelJson.put("text", label.getText());
                    labelJson.put("confidence", label.getConfidence());
                    labelJson.put("index", label.getIndex());
                    labelsArray.put(labelJson);
                }
            }
            objectJson.put("labels", labelsArray);

            objectsArray.put(objectJson);
        }

        JSObject result = new JSObject();
        result.put("objects", objectsArray);
        return result;
    }
}
