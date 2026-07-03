package com.docpal.warehousedemo;

import android.util.Log;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class OcrBarcodeProcessor {

  private static final String TAG = "OcrBarcodeProcessor";

  public interface ResultListener {
    void onResult(String text, String barcodesJson);
  }

  public void process(InputImage image, ResultListener listener) {
    TextRecognizer textRecognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
    BarcodeScanner barcodeScanner = BarcodeScanning.getClient();

    final String[] textResult = { "" };
    final String[] barcodeResult = { "[]" };
    final boolean[] textDone = { false };
    final boolean[] barcodeDone = { false };

    Runnable maybeFinish = () -> {
      if (textDone[0] && barcodeDone[0]) {
        close(textRecognizer, barcodeScanner);
        listener.onResult(textResult[0], barcodeResult[0]);
      }
    };

    textRecognizer.process(image)
      .addOnSuccessListener(visionText -> {
        textResult[0] = visionText.getText();
        textDone[0] = true;
        maybeFinish.run();
      })
      .addOnFailureListener(e -> {
        Log.e(TAG, "Text recognition failed", e);
        textDone[0] = true;
        maybeFinish.run();
      });

    barcodeScanner.process(image)
      .addOnSuccessListener(barcodes -> {
        barcodeResult[0] = barcodesToJson(barcodes);
        barcodeDone[0] = true;
        maybeFinish.run();
      })
      .addOnFailureListener(e -> {
        Log.e(TAG, "Barcode scanning failed", e);
        barcodeDone[0] = true;
        maybeFinish.run();
      });
  }

  private static String barcodesToJson(List<Barcode> barcodes) {
    JSONArray array = new JSONArray();
    for (Barcode barcode : barcodes) {
      try {
        JSONObject obj = new JSONObject();
        String value = barcode.getRawValue();
        obj.put("value", value != null ? value : "");
        obj.put("format", barcode.getFormat());
        array.put(obj);
      } catch (JSONException e) {
        // ignore individual barcode serialization errors
      }
    }
    return array.toString();
  }

  private static void close(TextRecognizer textRecognizer, BarcodeScanner barcodeScanner) {
    try {
      textRecognizer.close();
    } catch (Exception e) {
      Log.e(TAG, "Failed to close text recognizer", e);
    }
    try {
      barcodeScanner.close();
    } catch (Exception e) {
      Log.e(TAG, "Failed to close barcode scanner", e);
    }
  }
}
