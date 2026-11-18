package com.docpal.warehousedemo;

import android.content.Context;
import android.graphics.Rect;
import android.media.Image;
import android.os.SystemClock;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.core.content.ContextCompat;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Streaming analyzer for label-scan mode (spec 2026-11-18-streaming-label-scan-design):
 * runs ML Kit barcode scanning every tick and text recognition on every
 * {@code ocrEvery}th tick over the live CameraX analysis stream, feeds each
 * tick's best candidate to a {@link StreamingLabelGate}, and reports the
 * first candidate that stays stable long enough to auto-fire a full-res
 * capture.
 *
 * <p>ML Kit tasks are awaited on the analysis executor, so all gate state
 * stays on that single thread — no cross-thread synchronization. Frames
 * arriving while a previous tick is still running are dropped (the activity
 * already binds {@code STRATEGY_KEEP_ONLY_LATEST}, this is belt and braces).
 *
 * <p>The barcode/text recognizer clients are held for the activity lifetime —
 * unlike the one-shot {@link OcrBarcodeProcessor}, recreating clients per
 * frame would dominate the budget in a stream.
 */
public class StreamingLabelAnalyzer implements ImageAnalysis.Analyzer {

  public interface Listener {

    /** Upright analysis-frame size; mirrors the manual mode's streamWidth/Height. */
    void onAnalysisSize(int width, int height);

    /** Best candidate of the latest tick, or null when nothing decoded. */
    void onCandidateTick(StreamingLabelGate.Candidate candidate);

    /** Stability gate passed — reported exactly once per analyzer lifetime. */
    void onStableCandidate(StreamingLabelGate.Candidate candidate);
  }

  private static final String TAG = "StreamingLabelAnalyzer";

  private final StreamingLabelGate gate;
  private final Listener listener;
  private final Executor resultExecutor;
  private final BarcodeScanner barcodeScanner;
  private final TextRecognizer textRecognizer;

  private final AtomicBoolean fired = new AtomicBoolean(false);
  private volatile boolean paused;

  private long lastStartMs;
  private long lastLatencyMs;
  private long tickIndex;

  public StreamingLabelAnalyzer(Context context, Listener listener, StreamingLabelGate.Options options) {
    this.gate = new StreamingLabelGate(options);
    this.listener = listener;
    this.resultExecutor = ContextCompat.getMainExecutor(context);
    this.barcodeScanner = BarcodeScanning.getClient();
    this.textRecognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
  }

  /** While paused, incoming frames are closed immediately (capture in flight). */
  public void setPaused(boolean paused) {
    this.paused = paused;
  }

  /** Clears the gate streak and un-pauses after a failed capture or on resume. */
  public void resume() {
    gate.reset();
    paused = false;
  }

  public void close() {
    try {
      barcodeScanner.close();
    } catch (Exception e) {
      Log.e(TAG, "Failed to close barcode scanner", e);
    }
    try {
      textRecognizer.close();
    } catch (Exception e) {
      Log.e(TAG, "Failed to close text recognizer", e);
    }
  }

  @Override
  public void analyze(@NonNull ImageProxy imageProxy) {
    long nowMs = SystemClock.elapsedRealtime();
    if (paused || fired.get()) {
      imageProxy.close();
      return;
    }
    if (!gate.shouldAnalyze(nowMs, lastStartMs, lastLatencyMs)) {
      imageProxy.close();
      return;
    }

    Image mediaImage = imageProxy.getImage();
    if (mediaImage == null) {
      imageProxy.close();
      return;
    }

    int rotationDegrees = imageProxy.getImageInfo().getRotationDegrees();
    int frameWidth = (rotationDegrees == 90 || rotationDegrees == 270)
      ? imageProxy.getHeight()
      : imageProxy.getWidth();
    int frameHeight = (rotationDegrees == 90 || rotationDegrees == 270)
      ? imageProxy.getWidth()
      : imageProxy.getHeight();

    long startMs = SystemClock.elapsedRealtime();
    tickIndex++;
    boolean runOcr = tickIndex % gateOptionsOcrEvery() == 0;

    StreamingLabelGate.Candidate candidate = null;
    try {
      InputImage inputImage = InputImage.fromMediaImage(mediaImage, rotationDegrees);

      List<Barcode> barcodes = Tasks.await(barcodeScanner.process(inputImage));
      candidate = barcodeCandidate(barcodes);

      if (candidate == null && runOcr) {
        Text visionText = Tasks.await(textRecognizer.process(inputImage));
        candidate = ocrCandidate(visionText);
      }

      gate.onTick(candidate, frameWidth, frameHeight);
      StreamingLabelGate.Candidate tickCandidate = candidate;
      resultExecutor.execute(() -> {
        listener.onAnalysisSize(frameWidth, frameHeight);
        listener.onCandidateTick(tickCandidate);
      });

      StreamingLabelGate.Candidate stable = gate.fireCandidate();
      if (stable != null && fired.compareAndSet(false, true)) {
        resultExecutor.execute(() -> listener.onStableCandidate(stable));
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      Log.e(TAG, "Analysis interrupted", e);
    } catch (Exception e) {
      Log.e(TAG, "Analysis failed", e);
    } finally {
      lastLatencyMs = SystemClock.elapsedRealtime() - startMs;
      lastStartMs = startMs;
      imageProxy.close();
    }
  }

  private int gateOptionsOcrEvery() {
    return gate.options().ocrEvery;
  }

  /** Largest decoded barcode wins; null when nothing decoded. */
  private static StreamingLabelGate.Candidate barcodeCandidate(List<Barcode> barcodes) {
    Barcode best = null;
    long bestArea = -1;
    for (Barcode barcode : barcodes) {
      String value = barcode.getRawValue();
      if (value == null || value.isEmpty()) {
        continue;
      }
      Rect box = barcode.getBoundingBox();
      long area = box != null ? (long) box.width() * box.height() : 0;
      if (area > bestArea) {
        bestArea = area;
        best = barcode;
      }
    }
    if (best == null) {
      return null;
    }
    Rect box = best.getBoundingBox();
    String value = best.getRawValue();
    return new StreamingLabelGate.Candidate(
      StreamingLabelGate.signatureFor(value, true),
      value,
      true,
      String.valueOf(best.getFormat()),
      box.left,
      box.top,
      box.right,
      box.bottom
    );
  }

  /** Full OCR text (same content the manual path returns) with the union box of its blocks. */
  private static StreamingLabelGate.Candidate ocrCandidate(Text visionText) {
    String text = visionText.getText();
    if (text == null || text.trim().isEmpty()) {
      return null;
    }
    int left = Integer.MAX_VALUE;
    int top = Integer.MAX_VALUE;
    int right = Integer.MIN_VALUE;
    int bottom = Integer.MIN_VALUE;
    for (Text.TextBlock block : visionText.getTextBlocks()) {
      Rect box = block.getBoundingBox();
      if (box == null) {
        continue;
      }
      left = Math.min(left, box.left);
      top = Math.min(top, box.top);
      right = Math.max(right, box.right);
      bottom = Math.max(bottom, box.bottom);
    }
    if (left == Integer.MAX_VALUE) {
      return null;
    }
    return new StreamingLabelGate.Candidate(
      StreamingLabelGate.signatureFor(text, false),
      text,
      false,
      left,
      top,
      right,
      bottom
    );
  }
}
