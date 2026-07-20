import { describe, it, expect } from 'vitest';
import { decodeKoaQty, extractMultiItemRows, parseAndIdentify, parseQrCapture } from '../utils/parseOcrScan';

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

describe("decodeKoaQty", () => {
  it("expands qty using last digit as zero count", () => {
    expect(decodeKoaQty("53")).toBe(5000);
    expect(decodeKoaQty("253")).toBe(25000);
    expect(decodeKoaQty("14")).toBe(10000);
  });

  it("returns undefined for invalid input", () => {
    expect(decodeKoaQty("")).toBeUndefined();
    expect(decodeKoaQty("abc")).toBeUndefined();
  });

  it("decodes single-digit significant values (zero trailing zeros)", () => {
    expect(decodeKoaQty("50")).toBe(5);
  });

  it("returns undefined for non-positive results", () => {
    expect(decodeKoaQty("00")).toBeUndefined();
    expect(decodeKoaQty("0")).toBeUndefined();
  });
});

describe("parseQrCapture", () => {
  const koaTemplate = {
    code: "KOA",
    qrcodeTemplate: "^:(?<itemId>[^:]+)::(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<ignore2>[^:]+):(?<fullName>.+)$",
    qrcodeQtyEncoding: "koa_zeros" as const,
  };

  it("parses KOA QR payload and expands qty", () => {
    const result = parseQrCapture(
      ":RK73H2ATTD2403F::253:M:63048349:S613:KOA*RK73H2ATTD 2403F",
      {
        supplierTemplates: [koaTemplate],
        targets: ["RK73H2ATTD2403F"],
      }
    );

    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe("RK73H2ATTD2403F");
    expect(result.parsed.qty).toBe(25000);
    expect(result.parsed.lotCode).toBe("63048349");
  });

  it("returns no match when QR value does not fit any template", () => {
    const result = parseQrCapture("SOME-RANDOM-STRING", {
      supplierTemplates: [koaTemplate],
      targets: ["RK73H2ATTD2403F"],
    });
    expect(result.matched).toBe(false);
  });

  it("falls back to generic part-number matching when no template matches", () => {
    const result = parseQrCapture("PART: RK73B1JTTD181G", {
      supplierTemplates: [koaTemplate],
      targets: ["RK73B1JTTD181G"],
    });

    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe("RK73B1JTTD181G");
  });

  it("prefers the context supplier's template when templates overlap", () => {
    const genericTemplate = {
      code: "GENERIC",
      qrcodeTemplate: "^(?<itemId>.+)$",
      qrcodeQtyEncoding: null,
    };
    const specificTemplate = {
      code: "SPECIFIC",
      qrcodeTemplate: "^ID:(?<itemId>[A-Z0-9]+)$",
      qrcodeQtyEncoding: null,
    };

    const qrValue = "ID:RK73B1JTTD181G";
    const targets = ["ID:RK73B1JTTD181G", "RK73B1JTTD181G"];

    const withoutContext = parseQrCapture(qrValue, {
      supplierTemplates: [genericTemplate, specificTemplate],
      targets,
    });
    expect(withoutContext.matched).toBe(true);
    expect(withoutContext.parsed.itemId).toBe("ID:RK73B1JTTD181G");

    const withContext = parseQrCapture(qrValue, {
      supplierTemplates: [genericTemplate, specificTemplate],
      targets,
      contextSupplierCode: "SPECIFIC",
    });
    expect(withContext.matched).toBe(true);
    expect(withContext.parsed.itemId).toBe("RK73B1JTTD181G");
  });

  it("does not throw on an invalid regex template and falls back", () => {
    const invalidTemplate = {
      code: "INVALID",
      qrcodeTemplate: "(?<itemId>[",
      qrcodeQtyEncoding: null,
    };

    expect(() =>
      parseQrCapture("ID:RK73B1JTTD181G", {
        supplierTemplates: [invalidTemplate, koaTemplate],
        targets: ["RK73B1JTTD181G"],
      })
    ).not.toThrow();

    const result = parseQrCapture(":RK73B1JTTD181G::253:M:63048349:S613:X", {
      supplierTemplates: [invalidTemplate, koaTemplate],
      targets: ["RK73B1JTTD181G"],
    });
    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe("RK73B1JTTD181G");
  });

  it("returns matched=false when parsed itemId is not in targets", () => {
    const result = parseQrCapture(
      ":RK73H2ATTD2403F::253:M:63048349:S613:KOA*RK73H2ATTD 2403F",
      {
        supplierTemplates: [koaTemplate],
        targets: ["OTHER-PART"],
      }
    );

    expect(result.matched).toBe(false);
  });

  it("matches any parsed itemId when no targets are provided", () => {
    const result = parseQrCapture(
      ":RK73H2ATTD2403F::253:M:63048349:S613:KOA*RK73H2ATTD 2403F",
      {
        supplierTemplates: [koaTemplate],
      }
    );

    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe("RK73H2ATTD2403F");
    expect(result.parsed.qty).toBe(25000);
  });

  it("falls back to parseAndIdentify when supplierTemplates is empty", () => {
    const result = parseQrCapture("RK73B1JTTD181G", {
      supplierTemplates: [],
      targets: ["RK73B1JTTD181G"],
    });

    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe("RK73B1JTTD181G");
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
