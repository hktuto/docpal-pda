import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseCustomLabelCsv } from "~/utils/customLabelCsv";

// The real upload example committed for the custom-print-label handoff
// (docs/dev-guide-zh/flows/custom-print-label.md §0.1).
const FIXTURE = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../docs/custom-print-label-example/20261023_PC1.csv"
);

describe("parseCustomLabelCsv", () => {
  it("parses the real upload example: BOM stripped, every row, no errors", () => {
    const res = parseCustomLabelCsv(readFileSync(FIXTURE, "utf8"));
    expect(res.errors).toEqual([]);
    expect(res.header[0]).toBe("掃描時間");
    expect(res.header).toContain("單號");
    expect(res.rows).toHaveLength(178);
    expect(res.rows[0]).toMatchObject({
      單號: "HK2610-0450",
      物料號: "KOA+SG73P2ATTD 4701F",
      數量: "25000",
      LOTNO: "1907Q031",
      DATECODE: "20260907",
    });
    // The raw scanned label string (quoted commas would break a naive split)
    // stays one field.
    expect(res.rows[0]["標籤二"]).toContain(":SG73P2ATTD4701F:");
  });

  it("keeps quoted commas and escaped quotes in one field", () => {
    const res = parseCustomLabelCsv('a,b\n"x,y","he said ""hi"""\n');
    expect(res.header).toEqual(["a", "b"]);
    expect(res.rows).toEqual([{ a: "x,y", b: 'he said "hi"' }]);
  });

  it("handles CRLF and a newline inside quotes", () => {
    const res = parseCustomLabelCsv('a,b\r\n1,"line1\r\nline2"\r\n');
    expect(res.rows).toEqual([{ a: "1", b: "line1\r\nline2" }]);
  });

  it("keys rows by header name, not by index", () => {
    const res = parseCustomLabelCsv("qty,lot\n9,L1\n");
    expect(res.rows[0]).toEqual({ qty: "9", lot: "L1" });
  });

  it("drops blank lines but keeps their line numbers accurate for mismatch errors", () => {
    const res = parseCustomLabelCsv("h1,h2\n1,2\n\nbad\n3,4\n");
    expect(res.rows).toHaveLength(2);
    expect(res.errors).toEqual([{ line: 4, kind: "column_count", expected: 2, actual: 1 }]);
  });

  it("trims cells and drops the trailing empty header column", () => {
    const res = parseCustomLabelCsv("a, b, \n 1 ,2,\n");
    expect(res.header).toEqual(["a", "b"]);
    expect(res.rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("reports an empty file instead of a zero-row success", () => {
    const res = parseCustomLabelCsv("﻿");
    expect(res.header).toEqual([]);
    expect(res.rows).toEqual([]);
    expect(res.errors).toEqual([{ line: 0, kind: "empty" }]);
  });

  it("reports empty when only a header row is present", () => {
    const res = parseCustomLabelCsv("a,b\n");
    expect(res.header).toEqual(["a", "b"]);
    expect(res.rows).toEqual([]);
    expect(res.errors).toEqual([{ line: 0, kind: "empty" }]);
  });
});
