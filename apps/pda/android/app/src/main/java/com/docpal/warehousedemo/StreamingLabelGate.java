package com.docpal.warehousedemo;

/**
 * Stability/prominence gate for the streaming label-scan analyzer
 * (spec 2026-11-18-streaming-label-scan-design).
 *
 * <p>The analyzer reports at most one candidate per tick (a barcode when any
 * decoded, otherwise the concatenated OCR text), and the gate decides when a
 * candidate is trustworthy enough to auto-fire a full-resolution capture:
 *
 * <ul>
 *   <li>the same signature must persist for {@code stableFrames} consecutive
 *       ticks (blurs and panning across a shelf reset the streak);
 *   <li>the candidate box must be prominent — large enough and centred
 *       enough that the operator is clearly pointing at that label;
 *   <li>OCR candidates must look label-ish (long enough + contain a digit).
 *       Barcode candidates bypass the text sanity check.
 * </ul>
 *
 * <p>Pure Java (no Android/OpenCV deps) so the policy is unit-testable.
 * Not thread-safe — the analyzer serializes all access on its single
 * analysis executor.
 */
public class StreamingLabelGate {

  /** A decoded candidate from one analysis tick, in stream-frame coordinates. */
  public static class Candidate {

    public final String signature;
    public final String value;
    public final boolean isBarcode;
    /** ML Kit barcode format as its int string (matches OcrBarcodeProcessor JSON); null for OCR. */
    public final String barcodeFormat;
    public final int left;
    public final int top;
    public final int right;
    public final int bottom;

    public Candidate(
        String signature,
        String value,
        boolean isBarcode,
        int left,
        int top,
        int right,
        int bottom) {
      this(signature, value, isBarcode, null, left, top, right, bottom);
    }

    public Candidate(
        String signature,
        String value,
        boolean isBarcode,
        String barcodeFormat,
        int left,
        int top,
        int right,
        int bottom) {
      this.signature = signature;
      this.value = value;
      this.isBarcode = isBarcode;
      this.barcodeFormat = barcodeFormat;
      this.left = left;
      this.top = top;
      this.right = right;
      this.bottom = bottom;
    }

    public int width() {
      return Math.max(0, right - left);
    }

    public int height() {
      return Math.max(0, bottom - top);
    }

    public long area() {
      return (long) width() * (long) height();
    }
  }

  public static class Options {

    /** Consecutive same-signature ticks required before auto-fire. */
    public int stableFrames = 2;
    /** Minimum candidate area as a fraction of the frame. */
    public double minAreaRatio = 0.08;
    /** Candidate centre must be within this fraction of the frame centre. */
    public double centerMarginRatio = 0.25;
    /** OCR candidates need at least this many characters. */
    public int minOcrLen = 6;
    /** Adaptive analysis-interval clamp (ms). */
    public long minIntervalMs = 100;
    public long maxIntervalMs = 300;
    /** Run OCR on every Nth analysis tick (barcode runs every tick). */
    public int ocrEvery = 3;
  }

  private final Options options;

  private String lastSignature;
  private int streak;
  private Candidate pending;

  public StreamingLabelGate(Options options) {
    this.options = options;
  }

  public Options options() {
    return options;
  }

  /** Clears all streak state (e.g. after a failed capture or on resume). */
  public void reset() {
    lastSignature = null;
    streak = 0;
    pending = null;
  }

  /**
   * Adaptive cadence: target ~0.75x the last measured latency, clamped to
   * [{@code minIntervalMs}, {@code maxIntervalMs}]. A zero {@code lastStartMs}
   * means "never analyzed" — always take the first frame.
   */
  public boolean shouldAnalyze(long nowMs, long lastStartMs, long lastLatencyMs) {
    if (lastStartMs == 0) {
      return true;
    }
    long interval = options.maxIntervalMs;
    if (lastLatencyMs > 0) {
      interval = (lastLatencyMs * 3) / 4;
    }
    interval = Math.max(options.minIntervalMs, Math.min(options.maxIntervalMs, interval));
    return nowMs - lastStartMs >= interval;
  }

  /**
   * Feeds one analysis tick. {@code candidate} may be null (nothing decoded
   * this tick). Frame dimensions are used for the prominence checks.
   */
  public void onTick(Candidate candidate, int frameWidth, int frameHeight) {
    if (candidate == null || frameWidth <= 0 || frameHeight <= 0) {
      onNoCandidate();
      return;
    }
    if (!isProminent(candidate, frameWidth, frameHeight) || !passesSanity(candidate)) {
      onNoCandidate();
      return;
    }
    if (candidate.signature.equals(lastSignature)) {
      streak++;
    } else {
      streak = 1;
      lastSignature = candidate.signature;
    }
    pending = candidate;
  }

  /** A tick that decoded nothing usable — breaks any streak. */
  public void onNoCandidate() {
    lastSignature = null;
    streak = 0;
    pending = null;
  }

  /**
   * Non-null once the current candidate has been stable for
   * {@code stableFrames} consecutive ticks. Callers must latch: the gate
   * keeps reporting the candidate until the streak breaks.
   */
  public Candidate fireCandidate() {
    if (pending != null && streak >= options.stableFrames) {
      return pending;
    }
    return null;
  }

  public int currentStreak() {
    return streak;
  }

  private boolean isProminent(Candidate candidate, int frameWidth, int frameHeight) {
    long frameArea = (long) frameWidth * (long) frameHeight;
    if (frameArea <= 0 || candidate.area() < (long) (options.minAreaRatio * frameArea)) {
      return false;
    }
    double marginX = frameWidth * options.centerMarginRatio;
    double marginY = frameHeight * options.centerMarginRatio;
    double centerX = (candidate.left + candidate.right) / 2.0;
    double centerY = (candidate.top + candidate.bottom) / 2.0;
    return centerX >= marginX
      && centerX <= frameWidth - marginX
      && centerY >= marginY
      && centerY <= frameHeight - marginY;
  }

  private boolean passesSanity(Candidate candidate) {
    if (candidate.value == null || candidate.value.isEmpty()) {
      return false;
    }
    if (candidate.isBarcode) {
      return true;
    }
    return plausibleLabelText(candidate.value, options.minOcrLen);
  }

  /**
   * OCR text must be long enough and contain at least one digit — a light
   * sanity check only; the authoritative field parse happens on the web side.
   */
  public static boolean plausibleLabelText(String text, int minOcrLen) {
    if (text == null || text.length() < minOcrLen) {
      return false;
    }
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      if (c >= '0' && c <= '9') {
        return true;
      }
    }
    return false;
  }

  /**
   * Tick signature: barcodes compare by exact raw value; OCR compares by an
   * uppercase alphanumeric skeleton so frame noise (case, spaces, punctuation)
   * does not reset the streak.
   */
  public static String signatureFor(String value, boolean isBarcode) {
    if (value == null) {
      return "";
    }
    if (isBarcode) {
      return value.trim();
    }
    StringBuilder sb = new StringBuilder(value.length());
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (c >= '0' && c <= '9') {
        sb.append(c);
      } else if (c >= 'A' && c <= 'Z') {
        sb.append(c);
      } else if (c >= 'a' && c <= 'z') {
        sb.append(Character.toUpperCase(c));
      }
    }
    return sb.toString();
  }
}
