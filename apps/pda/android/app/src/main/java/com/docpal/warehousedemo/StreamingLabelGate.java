package com.docpal.warehousedemo;

import java.util.Locale;

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
 *       Barcode candidates bypass the text sanity check;
 *   <li>OR the decoded value confirms one of the caller-supplied rules
 *       (ALL of a named rule's keywords in one decode — e.g. a KOA label
 *       layout in ad-hoc put-away) — then the streak and centre checks are
 *       waived and the box only needs to be reasonably large, because the
 *       content itself is the confirmation.
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
    public int ocrEvery = 2;
    /**
     * Rule confirm (from JS scan options): a rule fires immediately when ALL
     * of its keywords appear in one decoded value — the streak requirement
     * and the centre check are waived; only a minimum-area gate stays, so
     * the camera never fires on a keyword glimpse at the frame edge. Any
     * rule can confirm (one brand may print several label layouts).
     */
    public ScanRule[] rules = new ScanRule[0];
    public double keywordMinAreaRatio = 0.05;
  }

  /** A named all-of keyword group; one label layout per rule. */
  public static class ScanRule {

    public final String name;
    public final String[] keywords;

    public ScanRule(String name, String[] keywords) {
      this.name = name;
      this.keywords = keywords;
    }
  }

  private final Options options;
  private final ScanRule[] normalizedRules;

  private String lastSignature;
  private int streak;
  private Candidate pending;
  private String matchedRuleName;
  private int lastFrameWidth;
  private int lastFrameHeight;

  public StreamingLabelGate(Options options) {
    this.options = options;
    this.normalizedRules = normalizeRules(options.rules);
  }

  /** Name of the rule that confirmed the current candidate; null otherwise. */
  public String matchedRuleName() {
    return matchedRuleName;
  }

  public Options options() {
    return options;
  }

  private static ScanRule[] normalizeRules(ScanRule[] rules) {
    if (rules == null || rules.length == 0) {
      return new ScanRule[0];
    }
    java.util.List<ScanRule> list = new java.util.ArrayList<>();
    for (ScanRule rule : rules) {
      if (rule == null) {
        continue;
      }
      java.util.List<String> keywords = new java.util.ArrayList<>();
      for (String keyword : rule.keywords) {
        if (keyword == null) {
          continue;
        }
        String normalized = keyword.trim().toLowerCase(Locale.ROOT);
        if (!normalized.isEmpty()) {
          keywords.add(normalized);
        }
      }
      if (!keywords.isEmpty()) {
        list.add(new ScanRule(rule.name, keywords.toArray(new String[0])));
      }
    }
    return list.toArray(new ScanRule[0]);
  }

  /** Clears all streak state (e.g. after a failed capture or on resume). */
  public void reset() {
    lastSignature = null;
    streak = 0;
    pending = null;
    matchedRuleName = null;
    lastFrameWidth = 0;
    lastFrameHeight = 0;
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
   *
   * <p>A candidate becomes {@code pending} when it passes sanity plus EITHER
   * the normal prominence check OR the keyword confirm gate — so a keyword
   * hit can build no streak and still be eligible for {@link #fireCandidate}.
   */
  public void onTick(Candidate candidate, int frameWidth, int frameHeight) {
    lastFrameWidth = frameWidth;
    lastFrameHeight = frameHeight;
    if (candidate == null || frameWidth <= 0 || frameHeight <= 0) {
      onNoCandidate();
      return;
    }
    if (!passesSanity(candidate)) {
      onNoCandidate();
      return;
    }
    if (!isProminent(candidate, frameWidth, frameHeight)
      && !isRuleConfirm(candidate, frameWidth, frameHeight)) {
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
    matchedRuleName = null;
  }

  /**
   * Non-null once the current candidate may auto-fire:
   * <ul>
   *   <li>normal path — stable for {@code stableFrames} consecutive ticks and
   *       prominent;</li>
   *   <li>rule path — the pending candidate confirms a rule (ALL of its
   *       keywords in one decode) and its box passes the keyword area gate
   *       (no streak, no centre check — the content itself is the
   *       confirmation). {@link #matchedRuleName()} names the rule.</li>
   * </ul>
   * Callers must latch: the gate keeps reporting the candidate until the
   * streak breaks.
   */
  public Candidate fireCandidate() {
    if (pending == null || lastFrameWidth <= 0 || lastFrameHeight <= 0) {
      return null;
    }
    if (streak >= options.stableFrames && isProminent(pending, lastFrameWidth, lastFrameHeight)) {
      return pending;
    }
    if (isRuleConfirm(pending, lastFrameWidth, lastFrameHeight)) {
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

  /**
   * Rule confirm gate: the decoded value confirms some rule (ALL of its
   * keywords present, case-insensitive) and the box is at least
   * {@code keywordMinAreaRatio} of the frame. The centre requirement is
   * waived — the matched content, not the position, is the confirmation.
   */
  private boolean isRuleConfirm(Candidate candidate, int frameWidth, int frameHeight) {
    if (normalizedRules.length == 0) {
      return false;
    }
    String matched = matchingRule(candidate.value);
    if (matched == null) {
      return false;
    }
    long frameArea = (long) frameWidth * (long) frameHeight;
    if (frameArea <= 0 || candidate.area() < (long) (options.keywordMinAreaRatio * frameArea)) {
      return false;
    }
    matchedRuleName = matched;
    return true;
  }

  /** First rule whose keywords ALL appear in the value; null when none. */
  private String matchingRule(String value) {
    if (value == null) {
      return null;
    }
    String haystack = value.toLowerCase(Locale.ROOT);
    for (ScanRule rule : normalizedRules) {
      boolean all = true;
      for (String keyword : rule.keywords) {
        if (!haystack.contains(keyword)) {
          all = false;
          break;
        }
      }
      if (all) {
        return rule.name;
      }
    }
    return null;
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
