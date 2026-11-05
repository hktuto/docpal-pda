import { describe, expect, it } from "vitest";
import {
  A4_LANDSCAPE_H,
  DOC_MARGIN_PX,
  paginate,
  wrapCellText,
  type PrintDocument,
} from "~/utils/documentPrint";

// Fake measurer: fixed 10 px per character — deterministic without a DOM canvas.
const measure = (t: string) => t.length * 10;

// Layout constants mirrored from documentPrint.ts (same formulas) so the
// expected page-fill counts below are explicit rather than magic numbers.
const LINE_H = Math.round(36 * 1.32); // 48
const ROW_H = LINE_H + 20; // 68 (min row height: 1 line + 2×10 padding)
const PAGE_BODY_H = A4_LANDSCAPE_H - 2 * DOC_MARGIN_PX; // 2362
const PAGE_HEADER_H = 72;
const HEADER_ROW_H = ROW_H; // short headers wrap to one line
const HEAD_BLOCK_H = Math.round(56 * 1.4) + 0 * Math.round(36 * 1.35) + 20 + 24; // head=[] → 122
const FIRST_CAP = PAGE_BODY_H - PAGE_HEADER_H - HEADER_ROW_H - HEAD_BLOCK_H; // 2100
const CONT_CAP = PAGE_BODY_H - PAGE_HEADER_H - HEADER_ROW_H; // 2222

function doc(rows: (string | number)[][], overrides: Partial<PrintDocument> = {}): PrintDocument {
  return {
    title: "Test Doc",
    ref: "REF-1",
    head: [],
    table: { columns: [{ header: "Col", weight: 1 }], rows },
    foot: [],
    ...overrides,
  };
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => [`row-${i}`]);

describe("paginate", () => {
  it("fits a 2-row document on a single page with head and foot", () => {
    const plans = paginate(doc(rows(2), { foot: ["note"] }), measure);
    expect(plans).toHaveLength(1);
    expect(plans[0].hasHead).toBe(true);
    expect(plans[0].hasFoot).toBe(true);
    expect(plans[0].rows.map((r) => r.index)).toEqual([0, 1]);
    expect(plans[0].page).toBe(1);
    expect(plans[0].pageCount).toBe(1);
  });

  it("fills greedily and splits only at row boundaries", () => {
    // 2100 / 68 = 30 rows on page 1; 2222 / 68 = 32 on continuation pages.
    const plans = paginate(doc(rows(70)), measure);
    expect(plans.map((p) => p.rows.length)).toEqual([30, 32, 8]);
    const indexes = plans.flatMap((p) => p.rows.map((r) => r.index));
    expect(indexes).toEqual(Array.from({ length: 70 }, (_, i) => i));
  });

  it("repeats the table header row on every page, head only on page 1, foot/totals only on the last", () => {
    const plans = paginate(doc(rows(70), { foot: ["f1"], table: { columns: [{ header: "Col", weight: 1 }], rows: rows(70), totals: ["T", 1] } }), measure);
    expect(plans.length).toBeGreaterThan(1);
    for (const plan of plans) expect(plan.headerRowHeight).toBe(HEADER_ROW_H);
    expect(plans.map((p) => p.hasHead)).toEqual(plans.map((_, i) => i === 0));
    expect(plans.map((p) => p.hasFoot)).toEqual(plans.map((_, i) => i === plans.length - 1));
    for (const plan of plans) expect(plan.pageCount).toBe(plans.length);
  });

  it("adds a foot-only overflow page when totals + foot no longer fit under the last rows", () => {
    // 62 rows = 30 + 32 → page 2 is exactly full (32 × 68 = 2176 of 2222);
    // foot block (totals 68 + 5 lines × 43 + 16 = 299) cannot fit → page 3.
    const foot = ["a", "b", "c", "d", "e"];
    const d = doc(rows(62), { foot });
    d.table.totals = ["Total", 1];
    const plans = paginate(d, measure);
    expect(plans).toHaveLength(3);
    expect(plans[1].hasFoot).toBe(false);
    expect(plans[2].hasFoot).toBe(true);
    expect(plans[2].rows).toEqual([]);
  });

  it("truncates a single row taller than a full page body", () => {
    const huge = "x".repeat(100_000);
    const plans = paginate(doc([[huge]]), measure);
    expect(plans).toHaveLength(1);
    const row = plans[0].rows[0];
    expect(row.truncated).toBe(true);
    expect(row.height).toBeLessThanOrEqual(FIRST_CAP);
    expect(row.maxLines).toBe(Math.floor((row.height - 20) / LINE_H));
  });

  it("keeps 300 rows across pages with no lost or duplicated rows", () => {
    const plans = paginate(doc(rows(300)), measure);
    expect(plans).toHaveLength(10); // 30 + 32 × 8 + 14
    const indexes = plans.flatMap((p) => p.rows.map((r) => r.index));
    expect(indexes).toEqual(Array.from({ length: 300 }, (_, i) => i));
    for (const [i, plan] of plans.entries()) expect(plan.page).toBe(i + 1);
  });
});

describe("wrapCellText", () => {
  it("wraps on word boundaries by measured width", () => {
    expect(wrapCellText("aa bb cc", 55, measure)).toEqual(["aa bb", "cc"]);
  });

  it("breaks words longer than the column by character (CJK-safe)", () => {
    expect(wrapCellText("abcdefgh", 30, measure)).toEqual(["abc", "def", "gh"]);
    expect(wrapCellText("收貨確認及付款通知書", 30, measure)).toEqual(["收貨確", "認及付", "款通知", "書"]);
  });

  it("keeps an empty cell as a single empty line", () => {
    expect(wrapCellText("", 30, measure)).toEqual([""]);
  });
});
