package com.docpal.warehousedemo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class StreamingLabelGateTest {

  private static final int FRAME_W = 640;
  private static final int FRAME_H = 480;

  private static StreamingLabelGate gate() {
    return new StreamingLabelGate(new StreamingLabelGate.Options());
  }

  private static StreamingLabelGate.ScanRule rule(String name, String... keywords) {
    return new StreamingLabelGate.ScanRule(name, keywords);
  }

  private static StreamingLabelGate gateWithRules(StreamingLabelGate.ScanRule... rules) {
    StreamingLabelGate.Options options = new StreamingLabelGate.Options();
    options.rules = rules;
    return new StreamingLabelGate(options);
  }

  /** Centred box occupying 25% of the frame — well past every threshold. */
  private static StreamingLabelGate.Candidate candidate(
      String signature, String value, boolean isBarcode) {
    return new StreamingLabelGate.Candidate(
      signature, value, isBarcode, 240, 160, 400, 320);
  }

  private static StreamingLabelGate.Candidate barcode(String value) {
    return candidate(StreamingLabelGate.signatureFor(value, true), value, true);
  }

  private static StreamingLabelGate.Candidate ocr(String text) {
    return candidate(StreamingLabelGate.signatureFor(text, false), text, false);
  }

  @Test
  public void ruleFiresImmediatelyWhenAllKeywordsPresentEvenOffCenter() {
    StreamingLabelGate gate = gateWithRules(rule("reel", "KOA", "1000PCS"));
    // Large box hard against the left edge — fails the centre check, but the
    // rule confirm path waives it.
    StreamingLabelGate.Candidate edgeKoa =
      new StreamingLabelGate.Candidate("X", "KOA PN12345 1000PCS", false, 0, 160, 200, 340);
    gate.onTick(edgeKoa, FRAME_W, FRAME_H);
    StreamingLabelGate.Candidate fired = gate.fireCandidate();
    assertNotNull(fired);
    assertEquals(1, gate.currentStreak());
    assertEquals("reel", gate.matchedRuleName());
  }

  @Test
  public void ruleDoesNotFireWhenOneKeywordMissing() {
    StreamingLabelGate gate = gateWithRules(rule("reel", "KOA", "1000PCS"));
    StreamingLabelGate.Candidate missingQty =
      candidate(StreamingLabelGate.signatureFor("KOA PN12345", false), "KOA PN12345", false);
    gate.onTick(missingQty, FRAME_W, FRAME_H);
    // Rule must not confirm without all its keywords…
    assertNull(gate.matchedRuleName());
    // …but the centred candidate still fires through the normal streak path.
    gate.onTick(missingQty, FRAME_W, FRAME_H);
    assertNotNull(gate.fireCandidate());
    assertNull(gate.matchedRuleName());
  }

  @Test
  public void ruleMatchingIsCaseInsensitive() {
    StreamingLabelGate gate = gateWithRules(rule("reel", "koa", "1000pcs"));
    gate.onTick(ocr("KOA Speer 1000PCS reel"), FRAME_W, FRAME_H);
    assertNotNull(gate.fireCandidate());
    assertEquals("reel", gate.matchedRuleName());
  }

  @Test
  public void anyRuleCanConfirmAndReportsItsName() {
    StreamingLabelGate gate = gateWithRules(
      rule("reel", "KOA", "1000PCS"),
      rule("box", "KOA", "QTY")
    );
    // "box" rule hit (KOA + QTY), "reel" not (no 1000PCS).
    gate.onTick(ocr("KOA box QTY 500"), FRAME_W, FRAME_H);
    assertNotNull(gate.fireCandidate());
    assertEquals("box", gate.matchedRuleName());
  }

  @Test
  public void ruleRequiresMinimumArea() {
    StreamingLabelGate gate = gateWithRules(rule("reel", "KOA"));
    StreamingLabelGate.Candidate tinyKoa =
      new StreamingLabelGate.Candidate("X", "KOA A1 1000PCS", false, 300, 220, 330, 245);
    gate.onTick(tinyKoa, FRAME_W, FRAME_H);
    assertNull(gate.fireCandidate());
  }

  @Test
  public void candidateWithoutRuleStillNeedsStreak() {
    StreamingLabelGate gate = gateWithRules(rule("reel", "KOA", "1000PCS"));
    gate.onTick(ocr("MURATA PN12345 QTY 5000"), FRAME_W, FRAME_H);
    assertNull(gate.fireCandidate());
    gate.onTick(ocr("MURATA PN12345 QTY 5000"), FRAME_W, FRAME_H);
    assertNotNull(gate.fireCandidate());
    // Normal path — no rule involved.
    assertNull(gate.matchedRuleName());
  }

  @Test
  public void noRulesKeepCenterRequirement() {
    StreamingLabelGate gate = gate(); // no rules configured
    StreamingLabelGate.Candidate edgeKoa =
      new StreamingLabelGate.Candidate("X", "KOA PN12345", false, 0, 160, 200, 340);
    gate.onTick(edgeKoa, FRAME_W, FRAME_H);
    gate.onTick(edgeKoa, FRAME_W, FRAME_H);
    assertNull(gate.fireCandidate());
  }

  @Test
  public void blankRulesAndKeywordsAreIgnored() {
    StreamingLabelGate.Options options = new StreamingLabelGate.Options();
    options.rules = new StreamingLabelGate.ScanRule[] {
      new StreamingLabelGate.ScanRule("blank", new String[] { "  ", null }),
    };
    StreamingLabelGate gate = new StreamingLabelGate(options);
    StreamingLabelGate.Candidate edgeKoa =
      new StreamingLabelGate.Candidate("X", "KOA PN12345", false, 0, 160, 200, 340);
    gate.onTick(edgeKoa, FRAME_W, FRAME_H);
    gate.onTick(edgeKoa, FRAME_W, FRAME_H);
    assertNull(gate.fireCandidate());
  }

  @Test
  public void firesAfterStableFrames() {
    StreamingLabelGate gate = gate();
    gate.onTick(barcode("ABC123"), FRAME_W, FRAME_H);
    assertNull(gate.fireCandidate());
    gate.onTick(barcode("ABC123"), FRAME_W, FRAME_H);
    assertNotNull(gate.fireCandidate());
  }

  @Test
  public void doesNotFireBelowStableFrames() {
    StreamingLabelGate gate = gate();
    gate.onTick(barcode("ABC123"), FRAME_W, FRAME_H);
    assertNull(gate.fireCandidate());
    assertEquals(1, gate.currentStreak());
  }

  @Test
  public void resetsWhenSignatureChanges() {
    StreamingLabelGate gate = gate();
    gate.onTick(barcode("ABC123"), FRAME_W, FRAME_H);
    gate.onTick(barcode("ABC123"), FRAME_W, FRAME_H);
    assertNotNull(gate.fireCandidate());

    gate.onTick(barcode("XYZ789"), FRAME_W, FRAME_H);
    assertNull(gate.fireCandidate());
    assertEquals(1, gate.currentStreak());

    gate.onTick(barcode("XYZ789"), FRAME_W, FRAME_H);
    assertNotNull(gate.fireCandidate());
  }

  @Test
  public void resetsOnNoCandidateGap() {
    StreamingLabelGate gate = gate();
    gate.onTick(barcode("ABC123"), FRAME_W, FRAME_H);
    gate.onNoCandidate();
    gate.onTick(barcode("ABC123"), FRAME_W, FRAME_H);
    assertNull(gate.fireCandidate());
  }

  @Test
  public void unstableTicksDoNotAdvanceStreakButKeepLatestCandidate() {
    StreamingLabelGate gate = gate();
    gate.onTick(barcode("ABC123"), FRAME_W, FRAME_H);
    gate.onNoCandidate();
    gate.onTick(barcode("ABC123"), FRAME_W, FRAME_H);
    gate.onTick(barcode("ABC123"), FRAME_W, FRAME_H);
    StreamingLabelGate.Candidate fired = gate.fireCandidate();
    assertNotNull(fired);
    assertEquals("ABC123", fired.value);
  }

  @Test
  public void rejectsBoxThatIsTooSmall() {
    StreamingLabelGate gate = gate();
    // 40x30 px = 0.4% of the frame, far below minAreaRatio 8%.
    StreamingLabelGate.Candidate tiny =
      new StreamingLabelGate.Candidate("ABC123", "ABC123", true, 300, 220, 340, 250);
    gate.onTick(tiny, FRAME_W, FRAME_H);
    gate.onTick(tiny, FRAME_W, FRAME_H);
    assertNull(gate.fireCandidate());
    assertEquals(0, gate.currentStreak());
  }

  @Test
  public void rejectsOffCenterBox() {
    StreamingLabelGate gate = gate();
    // Large enough, but hard against the left edge — centre outside the
    // central 50% band.
    StreamingLabelGate.Candidate edge =
      new StreamingLabelGate.Candidate("ABC123", "ABC123", true, 0, 160, 160, 320);
    gate.onTick(edge, FRAME_W, FRAME_H);
    gate.onTick(edge, FRAME_W, FRAME_H);
    assertNull(gate.fireCandidate());
  }

  @Test
  public void ocrCandidateNeedsPlausibleText() {
    StreamingLabelGate gate = gate();
    StreamingLabelGate.Candidate noDigit =
      candidate(StreamingLabelGate.signatureFor("abcdefgh", false), "abcdefgh", false);
    gate.onTick(noDigit, FRAME_W, FRAME_H);
    gate.onTick(noDigit, FRAME_W, FRAME_H);
    assertNull(gate.fireCandidate());

    StreamingLabelGate.Candidate shortText =
      candidate(StreamingLabelGate.signatureFor("A1", false), "A1", false);
    gate.onTick(shortText, FRAME_W, FRAME_H);
    gate.onTick(shortText, FRAME_W, FRAME_H);
    assertNull(gate.fireCandidate());
  }

  @Test
  public void ocrCandidateFiresWhenPlausible() {
    StreamingLabelGate gate = gate();
    gate.onTick(ocr("PN 12345 QTY 100"), FRAME_W, FRAME_H);
    gate.onTick(ocr("PN 12345 QTY 100"), FRAME_W, FRAME_H);
    StreamingLabelGate.Candidate fired = gate.fireCandidate();
    assertNotNull(fired);
    assertFalse(fired.isBarcode);
  }

  @Test
  public void barcodeCandidateBypassesTextSanity() {
    StreamingLabelGate gate = gate();
    // Short, digit-free barcode values are still perfectly decodable.
    StreamingLabelGate.Candidate tinyValue = barcode("AB");
    gate.onTick(tinyValue, FRAME_W, FRAME_H);
    gate.onTick(tinyValue, FRAME_W, FRAME_H);
    assertNotNull(gate.fireCandidate());
  }

  @Test
  public void signatureNormalizationIgnoresCaseSpaceAndPunctuation() {
    String a = StreamingLabelGate.signatureFor("PN 12345-X", false);
    String b = StreamingLabelGate.signatureFor("pn12345 x", false);
    assertEquals(a, b);

    String barcode = StreamingLabelGate.signatureFor("  ABC  ", true);
    assertEquals("ABC", barcode);
  }

  @Test
  public void plausibleLabelTextChecksLengthAndDigit() {
    assertTrue(StreamingLabelGate.plausibleLabelText("ABC123", 6));
    assertFalse(StreamingLabelGate.plausibleLabelText("ABC123", 7));
    assertFalse(StreamingLabelGate.plausibleLabelText("abcdefg", 6));
    assertFalse(StreamingLabelGate.plausibleLabelText(null, 6));
  }

  @Test
  public void shouldAnalyzeClampsToIntervalRange() {
    StreamingLabelGate.Options options = new StreamingLabelGate.Options();
    StreamingLabelGate gate = new StreamingLabelGate(options);

    // First frame always analyzed.
    assertTrue(gate.shouldAnalyze(1000, 0, 0));

    // Fast device (40ms latency) → floor at minIntervalMs.
    assertFalse(gate.shouldAnalyze(1050, 1000, 40));
    assertTrue(gate.shouldAnalyze(1100, 1000, 40));

    // Slow device (1000ms latency) → ceiling at maxIntervalMs.
    assertFalse(gate.shouldAnalyze(1200, 1000, 1000));
    assertTrue(gate.shouldAnalyze(1300, 1000, 1000));

    // Mid-range (160ms latency) → 0.75x = 120ms.
    assertFalse(gate.shouldAnalyze(1110, 1000, 160));
    assertTrue(gate.shouldAnalyze(1121, 1000, 160));
  }
}
