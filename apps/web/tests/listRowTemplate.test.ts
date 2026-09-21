// PDA list-row template rendering (spec
// docs/superpowers/specs/2026-09-21-pda-list-row-templates-design.md).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PDA_LIST_TEMPLATES,
  formatListRow,
  formatListRowTemplate,
  type PdaListTemplates,
} from "~/utils/listRowTemplate";

const RECEIVING_ROW = {
  displayName: "BATCH-1 · INV-1",
  batchNo: "BATCH-1",
  invoiceNos: "INV-1, INV-2",
  supplierCode: "SUP",
  supplierName: "Supplier Ltd",
  deliveryDate: "2026-09-21T00:00:00.000Z",
  dateCode: null,
  status: "pending",
};

function templates(partial: Partial<PdaListTemplates>): PdaListTemplates {
  return { ...DEFAULT_PDA_LIST_TEMPLATES, ...partial };
}

describe("formatListRowTemplate", () => {
  it("renders placeholders with literals", () => {
    expect(
      formatListRowTemplate(RECEIVING_ROW, "[supplier_name] · [delivery_date]", "receiving")
    ).toBe("Supplier Ltd · 2026-09-21");
  });

  it("empty field renders empty (no dangling separator)", () => {
    expect(formatListRowTemplate(RECEIVING_ROW, "[date_code]-[batch_no]", "receiving")).toBe("-BATCH-1");
  });

  it("unknown tokens stay literal", () => {
    expect(formatListRowTemplate(RECEIVING_ROW, "[bogus]", "receiving")).toBe("[bogus]");
  });

  it("arrays comma-join", () => {
    expect(formatListRowTemplate({ orderNos: ["A", "B"] }, "[order_nos]", "verify")).toBe("A, B");
  });

  it("invoice_no_first renders only the first invoice", () => {
    expect(formatListRowTemplate(RECEIVING_ROW, "[invoice_no_first]", "receiving")).toBe("INV-1");
    expect(formatListRowTemplate({ invoiceNos: "INV-9" }, "[invoice_no_first]", "put-away")).toBe("INV-9");
    expect(formatListRowTemplate({ invoiceNos: null }, "[invoice_no_first]", "receiving")).toBe("");
  });

  it("datetime kind renders YYYY-MM-DD HH:mm", () => {
    expect(
      formatListRowTemplate({ verifiedAt: "2026-09-21T08:30:00.000Z" }, "[verified_at]", "goods-verify")
    ).toBe("2026-09-21 08:30");
  });
});

describe("formatListRow", () => {
  it("defaults reproduce today's rows", () => {
    expect(formatListRow("receiving", "title", RECEIVING_ROW)).toBe("BATCH-1 · INV-1");
    expect(formatListRow("receiving", "meta", RECEIVING_ROW)).toBe("Supplier Ltd · 2026-09-21");
    expect(formatListRow("picking", "meta", { customerCode: "C1", poNo: "PO-9" })).toBe("C1 · PO-9");
    expect(formatListRow("verify", "meta", { orderNos: ["A"], destinationCountry: "DE" })).toBe("A · DE");
  });

  it("custom template wins when it renders non-empty", () => {
    const t = templates({ receiving: { title: "[invoice_no]", meta: "[supplier_name]" } });
    expect(formatListRow("receiving", "title", RECEIVING_ROW, t)).toBe("INV-1, INV-2");
  });

  it("all-empty title falls back to the default template, then the primary id", () => {
    const t = templates({ receiving: { title: "[date_code]", meta: "[supplier_name]" } });
    // date_code null → default [name] kicks in
    expect(formatListRow("receiving", "title", RECEIVING_ROW, t)).toBe("BATCH-1 · INV-1");
    // no displayName either → raw batch_no
    const noName = { ...RECEIVING_ROW, displayName: undefined };
    expect(formatListRow("receiving", "title", noName, t)).toBe("BATCH-1");
    // goods-verify: wcl_item_no null → part_no
    expect(formatListRow("goods-verify", "title", { wclItemNo: null, partNo: "P-1" })).toBe("P-1");
  });

  it("all-empty meta returns empty string (caller hides the line)", () => {
    expect(formatListRow("receiving", "meta", { supplierName: null, deliveryDate: null })).toBe("");
  });

  it("put-away supports [name] (receiving order displayName)", () => {
    const row = { displayName: "BATCH-1 · INV-1", batchNo: "BATCH-1", supplierName: "Supplier Ltd" };
    const t = templates({ "put-away": { title: "[name]", meta: "[supplier_name]" } });
    expect(formatListRow("put-away", "title", row, t)).toBe("BATCH-1 · INV-1");
    // no displayName (older backend) → raw batch_no fallback
    expect(formatListRow("put-away", "title", { batchNo: "BATCH-1" }, t)).toBe("BATCH-1");
  });
});
