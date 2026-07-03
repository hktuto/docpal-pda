package com.docpal.warehousedemo;

import android.util.Log;
import androidx.annotation.Nullable;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class OcrBarcodeProcessor {

  private static final String TAG = "OcrBarcodeProcessor";

  public interface ResultListener {
    void onResult(String text, String barcodesJson);
  }

  @Nullable
  private TextRecognizer textRecognizer;
  @Nullable
  private BarcodeScanner barcodeScanner;
  private final AtomicBoolean finished = new AtomicBoolean(false);

  public void process(InputImage image, ResultListener listener) {
    if (finished.get()) {
      return;
    }

    textRecognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
    barcodeScanner = BarcodeScanning.getClient();

    final String[] textResult = { "" };
    final String[] barcodeResult = { "[]" };
    final AtomicBoolean textDone = new AtomicBoolean(false);
    final AtomicBoolean barcodeDone = new AtomicBoolean(false);

    Runnable maybeFinish = () -> {
      if (textDone.get() && barcodeDone.get() && finished.compareAndSet(false, true)) {
        close();
        listener.onResult(textResult[0], barcodeResult[0]);
      }
    };

    textRecognizer.process(image)
      .addOnSuccessListener(visionText -> {
        textResult[0] = visionText.getText();
        textDone.set(true);
        maybeFinish.run();
      })
      .addOnFailureListener(e -> {
        Log.e(TAG, "Text recognition failed", e);
        textDone.set(true);
        maybeFinish.run();
      });

    barcodeScanner.process(image)
      .addOnSuccessListener(barcodes -> {
        barcodeResult[0] = barcodesToJson(barcodes);
        barcodeDone.set(true);
        maybeFinish.run();
      })
      .addOnFailureListener(e -> {
        Log.e(TAG, "Barcode scanning failed", e);
        barcodeDone.set(true);
        maybeFinish.run();
      });
  }

  public synchronized void cancel() {
    finished.set(true);
    close();
  }

  private synchronized void close() {
    if (textRecognizer != null) {
      try {
        textRecognizer.close();
      } catch (Exception e) {
        Log.e(TAG, "Failed to close text recognizer", e);
      }
      textRecognizer = null;
    }
    if (barcodeScanner != null) {
      try {
        barcodeScanner.close();
      } catch (Exception e) {
        Log.e(TAG, "Failed to close barcode scanner", e);
      }
      barcodeScanner = null;
    }
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
}
