import { describe, it, expect } from 'vitest';
import { extractMultiItemRows, extractPickingScanDrafts, parseAndIdentify } from '../utils/parseOcrScan';

describe('parseAndIdentify', () => {
  it('matches a part number from a barcode value', () => {
    const result = parseAndIdentify(
      {
        text: 'some noisy text',
        barcodes: [{ value: 'RK73B1JTTD181G', format: 'CODE_128' }],
      },
      ['RK73B1JTTD181G', 'S-1206B18-M3T1U']
    );

    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe('RK73B1JTTD181G');
    expect(result.options.itemIds).toContain('RK73B1JTTD181G');
  });

  it('strips supplier prefixes like KOA+ from barcode values', () => {
    const result = parseAndIdentify(
      {
        text: '',
        barcodes: [{ value: 'KOA+RK73B1JTTD181G', format: 'CODE_128' }],
      },
      ['RK73B1JTTD181G']
    );

    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe('RK73B1JTTD181G');
  });

  it('matches a part number from OCR text', () => {
    const result = parseAndIdentify(
      {
        text: '(P)CUSTOMER P/N: RK73B1JTTD181G\n(Q)QUANTITY: 5000',
        barcodes: [],
      },
      ['RK73B1JTTD181G']
    );

    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe('RK73B1JTTD181G');
  });

  it('joins a part number split by spaces in OCR text', () => {
    const result = parseAndIdentify(
      {
        text: '(P)CUSTOMER P/N: KOA+RK73H1ETTP 1001F',
        barcodes: [],
      },
      ['RK73H1ETTP1001F']
    );

    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe('RK73H1ETTP1001F');
  });

  it('matches OCR text with common digit/letter substitution errors', () => {
    const result = parseAndIdentify(
      {
        text: 'TYPE: S-12O6B18-M3T1U', // O instead of 0
        barcodes: [],
      },
      ['S-1206B18-M3T1U']
    );

    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe('S-1206B18-M3T1U');
  });

  it('returns matched=false when no part number is found', () => {
    const result = parseAndIdentify(
      {
        text: 'RANDOM TEXT WITHOUT ANY MATCHING ID',
        barcodes: [{ value: 'NOTAMATCH', format: 'CODE_128' }],
      },
      ['RK73B1JTTD181G']
    );

    expect(result.matched).toBe(false);
    expect(result.parsed.itemId).toBeNull();
  });

  it('extracts quantity candidates from labels and barcodes', () => {
    const result = parseAndIdentify(
      {
        text: 'QTY: 5000\n5000 pcs',
        barcodes: [{ value: 'Q5000', format: 'CODE_128' }],
      },
      ['RK73B1JTTD181G']
    );

    expect(result.options.qtys).toContain(5000);
  });

  it('extracts COO candidates including full country names', () => {
    const result = parseAndIdentify(
      {
        text: 'Made in Slovenia',
        barcodes: [],
      },
      ['ZMY200B']
    );

    expect(result.options.coos.map((c) => c.toUpperCase())).toContain('SI');
    expect(result.options.coos.map((c) => c.toUpperCase())).toContain('SLOVENIA');
  });

  it('extracts date code candidates from labeled and bare values', () => {
    const result = parseAndIdentify(
      {
        text: 'DATE CODE: 2544\n201910',
        barcodes: [],
      },
      ['RK73B1JTTD181G']
    );

    expect(result.options.dateCodes).toContain('2544');
    expect(result.options.dateCodes).toContain('201910');
  });

  it('extracts lot code candidates from LOT and TRACE CODE labels', () => {
    const result = parseAndIdentify(
      {
        text: 'LOT: VTCJ9X17324-0134\n(1T)TRACE CODE: 9827T377-1',
        barcodes: [],
      },
      ['S-1206B18-M3T1U']
    );

    expect(result.options.lotCodes).toContain('VTCJ9X17324-0134');
    expect(result.options.lotCodes).toContain('9827T377-1');
  });

  it('ranks multiple target matches', () => {
    const result = parseAndIdentify(
      {
        text: 'TYPE: S-1206B18-M3T1U',
        barcodes: [],
      },
      ['S-1206B18-M3T1U', 'RK73B1JTTD181G']
    );

    expect(result.options.itemIds[0]).toBe('S-1206B18-M3T1U');
  });

  it('accepts a single target string', () => {
    const result = parseAndIdentify(
      {
        text: 'RK73B1JTTD181G',
        barcodes: [],
      },
      'RK73B1JTTD181G'
    );

    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe('RK73B1JTTD181G');
  });

  it('parses a GS1-style composite barcode', () => {
    const result = parseAndIdentify(
      {
        text: '',
        barcodes: [{ value: '(P)RK73B1JTTD181G(Q)5000(D)2544', format: 'DATA_MATRIX' }],
      },
      ['RK73B1JTTD181G']
    );

    expect(result.matched).toBe(true);
    expect(result.options.qtys).toContain(5000);
    expect(result.options.dateCodes).toContain('2544');
  });

  it('extracts COO from a labeled code', () => {
    const result = parseAndIdentify(
      {
        text: 'COO: JP',
        barcodes: [],
      },
      ['S-1206B18-M3T1U']
    );

    expect(result.options.coos).toContain('JP');
    expect(result.parsed.coo).toBe('JP');
  });

  it('extracts COW from text', () => {
    const result = parseAndIdentify(
      {
        text: 'COW: W1-2024A',
        barcodes: [],
      },
      ['RK73B1JTTD181G']
    );

    expect(result.options.cows).toContain('W1-2024A');
    expect(result.parsed.cow).toBe('W1-2024A');
  });

  it('returns empty options when no fields are present', () => {
    const result = parseAndIdentify(
      {
        text: '',
        barcodes: [],
      },
      ['RK73B1JTTD181G']
    );

    expect(result.matched).toBe(false);
    expect(result.options.itemIds).toEqual([]);
    expect(result.options.qtys).toEqual([]);
    expect(result.raw.text).toBe('');
  });

  it('extracts unlabeled qty, date, and lot from a minimal label', () => {
    const result = parseAndIdentify(
      {
        text: 'ZMY200B\n5000\n2025-10-29\nS12235\nMade in Slovenia',
        barcodes: [],
      },
      ['ZMY200B', 'RK73B1JTTD181G']
    );

    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe('ZMY200B');
    expect(result.options.qtys).toContain(5000);
    expect(result.options.dateCodes).toContain('2025-10-29');
    expect(result.options.lotCodes).toContain('S12235');
    expect(result.options.coos.map((c) => c.toUpperCase())).toContain('SI');
  });
});

describe("extractMultiItemRows", () => {
  const cartonText = [
    "WEL-D06",
    "WELTRONICS",
    "MCE",
    "C/NO.00003",
    "MADE IN JAPAN",
    "Invoice No 65878-01",
    "Carton No 00003",
    "Customer Name WEL MCE",
    "Total Q'ty 36,000",
    "Customer PO MFG Item Customer Item Quantity",
    "1180201015STD RN412ESTTE2703F50 3,000",
    "21 KOA/RN412ESTTE 2703F50 K0A/RN412ESTTE2703F50",
    "1180201509STD RN412ESTTE1R50F50 3,000",
    "11 KOA/RN412ESTTE 1R50F50 K0A/RN412ESTTE1R50F50",
    "1180201654STD SR732BTTDR365F 20,000",
    "21 KOA/SR732BTTD R365F K0A/SR732BTTDR365F",
  ].join("\n");

  const targets = [
    "RN412ESTTE2703F50",
    "RN412ESTTE1R50F50",
    "SR732BTTDR365F",
  ];

  it("extracts one row per item with the same-line quantity", () => {
    const rows = extractMultiItemRows(cartonText, targets);

    expect(rows).toHaveLength(3);
    expect(rows).toEqual([
      { partNo: "RN412ESTTE2703F50", qty: 3000 },
      { partNo: "RN412ESTTE1R50F50", qty: 3000 },
      { partNo: "SR732BTTDR365F", qty: 20000 },
    ]);
  });

  it("ignores lines without a matching target (total qty, header)", () => {
    const rows = extractMultiItemRows(
      "Total Q'ty 36,000\nCustomer Name WEL MCE",
      targets
    );

    expect(rows).toHaveLength(0);
  });

  it("leaves qty undefined when the line has no plausible quantity", () => {
    const rows = extractMultiItemRows("RN412ESTTE2703F50", targets);

    expect(rows).toEqual([{ partNo: "RN412ESTTE2703F50", qty: undefined }]);
  });
});

describe("extractPickingScanDrafts", () => {
  it("keeps whole-label parsing and all fields for a single item", () => {
    const drafts = extractPickingScanDrafts(
      {
        text: [
          "PART: RK73B1JTTD181G",
          "QTY: 5000",
          "DATE CODE: 2544",
          "LOT: VTCJ9X17324-0134",
          "COO: JP",
          "COW: CN",
        ].join("\n"),
        barcodes: [],
      },
      ["RK73B1JTTD181G"]
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0].parsed).toMatchObject({
      itemId: "RK73B1JTTD181G",
      qty: 5000,
      dateCode: "2544",
      lotCode: "VTCJ9X17324-0134",
      coo: "JP",
      cow: "CN",
    });
  });

  it("parses every field from each line of a multi-item label", () => {
    const drafts = extractPickingScanDrafts(
      {
        text: [
          "RN412ESTTE2703F50 QTY: 3000 DATE CODE: 2544 LOT: LOT-A1 COO: JP COW: CN",
          "SR732BTTDR365F QTY: 20000 DATE CODE: 2610 LOT: LOT-B2 COO: MY COW: TH",
        ].join("\n"),
        barcodes: [],
      },
      ["RN412ESTTE2703F50", "SR732BTTDR365F"]
    );

    expect(drafts).toHaveLength(2);
    expect(drafts[0].parsed).toMatchObject({
      itemId: "RN412ESTTE2703F50",
      qty: 3000,
      dateCode: "2544",
      lotCode: "LOT-A1",
      coo: "JP",
      cow: "CN",
    });
    expect(drafts[1].parsed).toMatchObject({
      itemId: "SR732BTTDR365F",
      qty: 20000,
      dateCode: "2610",
      lotCode: "LOT-B2",
      coo: "MY",
      cow: "TH",
    });
  });

  it("offers whole-label fields as candidates without copying them to every row", () => {
    const drafts = extractPickingScanDrafts(
      {
        text: [
          "DATE CODE: 2544",
          "LOT: HEADERLOT1",
          "RN412ESTTE2703F50 QTY: 3000",
          "SR732BTTDR365F QTY: 20000",
        ].join("\n"),
        barcodes: [],
      },
      ["RN412ESTTE2703F50", "SR732BTTDR365F"]
    );

    expect(drafts).toHaveLength(2);
    for (const draft of drafts) {
      expect(draft.parsed.dateCode).toBeUndefined();
      expect(draft.parsed.lotCode).toBeUndefined();
      expect(draft.options.dateCodes).toContain("2544");
      expect(draft.options.lotCodes).toContain("HEADERLOT1");
    }
  });

  it("does not create an extra picking row from a substring-only match", () => {
    const drafts = extractPickingScanDrafts(
      {
        text: "PART: OTHER123 QTY: 10\nTRACE RK73B1JTTD181G",
        barcodes: [],
      },
      ["OTHER123", "181G"]
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0].parsed.itemId).toBe("OTHER123");
  });
});
