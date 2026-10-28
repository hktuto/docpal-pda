import { describe, it, expect } from 'vitest';
import { decodeKoaDateCode, decodeKoaQty, extractMultiItemRows, extractPickingScanDrafts, parseAndIdentify, parseQrCapture } from '../utils/parseOcrScan';

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

describe("decodeKoaDateCode", () => {
  // Mirrors apps/backend/src/db/scanParse.ts decodeKoaDateCode with the
  // DEFAULT_KOA_PERIODS rows (three forward cycles, counter 10→99 per
  // 90-month cycle); always pass an explicit referenceDate.
  const REF_2026_10 = new Date(Date.UTC(2026, 9, 16));
  const REF_2026_08 = new Date(Date.UTC(2026, 7, 15));

  it("decodes month counter + day to WWYY via the default periods (10 = 2025-12 in the latest cycle)", () => {
    expect(decodeKoaDateCode("1625H713", undefined, REF_2026_08)).toBe("2626"); // counter 16 → 2026-06, day 25 → week 26
    expect(decodeKoaDateCode("1723L789", undefined, REF_2026_08)).toBe("3026"); // counter 17 → 2026-07, day 23 → week 30
    expect(decodeKoaDateCode("1114T232", undefined, REF_2026_08)).toBe("0326"); // counter 11 → 2026-01, day 14 → week 3
    expect(decodeKoaDateCode("19077387", undefined, REF_2026_10)).toBe("3726"); // counter 19 → 2026-09, day 07 → week 37
  });

  it("resolves a counter covered by several cycles to the latest candidate not in the future", () => {
    // counter 54 candidates 2014-08 / 2022-02 / 2029-08 → 2022-02-20 (Sunday) → week 07 of 2022
    expect(decodeKoaDateCode("5420Q156", undefined, REF_2026_10)).toBe("0722");
    // same counter, day 21 (Monday) → week 08 of 2022
    expect(decodeKoaDateCode("5421Q156", undefined, REF_2026_10)).toBe("0822");
    // same counter with a reference date past 2029-08 → 2029-08-01 → week 31 of 2029
    expect(decodeKoaDateCode("5401", undefined, new Date(Date.UTC(2030, 0, 1)))).toBe("3129");
    // counter 99 candidates 2018-05 / 2025-11 / 2033-05 → 2025-11-15 (Saturday) → week 46 of 2025
    expect(decodeKoaDateCode("9915", undefined, REF_2026_08)).toBe("4625");
    // counter 70 candidates 2015-12 / 2023-06 / 2030-12 → 2023-06-12 → week 24 of 2023
    expect(decodeKoaDateCode("7012", undefined, REF_2026_08)).toBe("2423");
  });

  it("rejects undecodable values", () => {
    expect(decodeKoaDateCode("L2601A", undefined, REF_2026_08)).toBeUndefined(); // no leading digits
    expect(decodeKoaDateCode("123", undefined, REF_2026_08)).toBeUndefined(); // fewer than 4 digits
    expect(decodeKoaDateCode("1700X", undefined, REF_2026_08)).toBeUndefined(); // day 00
    expect(decodeKoaDateCode("1732X", undefined, REF_2026_08)).toBeUndefined(); // day 32
    expect(decodeKoaDateCode("2352", undefined, REF_2026_08)).toBeUndefined(); // day 52
    expect(decodeKoaDateCode("0023X", undefined, REF_2026_08)).toBeUndefined(); // counter 00 — outside 10..99
    expect(decodeKoaDateCode("0523X", undefined, REF_2026_08)).toBeUndefined(); // counter 05 — outside 10..99
    expect(decodeKoaDateCode("5429", undefined, REF_2026_10)).toBeUndefined(); // day 29 > 28 days in 2022-02
  });

  it("falls back to the built-in defaults when the periods list is empty", () => {
    // GET /date-code-periods returns [] on a DB seeded before the table
    // existed — that must behave like omitting the argument, not like "no
    // period covers this counter" (which silently dropped the date code).
    expect(decodeKoaDateCode("18042421", [], REF_2026_10)).toBe("3226"); // counter 18 → 2026-08, day 04 → ISO week 32
    expect(decodeKoaDateCode("1907H686", [], REF_2026_10)).toBe("3726"); // counter 19 → 2026-09, day 07 → ISO week 37
  });

  it("emits the configured label format (yyww config gets the YYWW pair swap)", () => {
    // Decode output is label format by contract (spec 2026-10-22) — under a
    // "yyww" flow config the canonical YYWW must be pair-swapped from the
    // default WWYY rendering, not hardcoded WWYY.
    expect(decodeKoaDateCode("1907H686", undefined, REF_2026_10, "yyww")).toBe("2637"); // week 37 of 2026
    expect(decodeKoaDateCode("1907H686", undefined, REF_2026_10, "wwyy")).toBe("3726");
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

  it("emits decoded KOA date codes in the configured label format", () => {
    const koaCounterTemplate = {
      ...koaTemplate,
      qrcodeDateCodeEncoding: "koa_month_counter" as const,
    };
    const raw = ":RK73H1ETTP4752F::253:M:1907H686:S601:KOA*RK73H1ETTP 4752F";
    // Default wwyy: WWYY output.
    expect(
      parseQrCapture(raw, { supplierTemplates: [koaCounterTemplate], dateCodeFormat: "wwyy" }).parsed.dateCode
    ).toBe("3726"); // counter 19 → 2026-09, day 07 → ISO week 37
    // yyww flow config: pair-swapped label format.
    expect(
      parseQrCapture(raw, { supplierTemplates: [koaCounterTemplate], dateCodeFormat: "yyww" }).parsed.dateCode
    ).toBe("2637");
  });

  it("returns no match when QR value does not fit any template", () => {
    const result = parseQrCapture("SOME-RANDOM-STRING", {
      supplierTemplates: [koaTemplate],
      targets: ["RK73H2ATTD2403F"],
    });
    expect(result.matched).toBe(false);
  });

  it("captures the WCL item no from the template's wclItemNo group", () => {
    const koaWclTemplate = {
      code: "32",
      qrcodeTemplate:
        "^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]*):(?<serialNo>[^:]+):(?<wclItemNo>[^:]+)(?::[^:]*)*:?$",
      qrcodeQtyEncoding: "koa_zeros" as const,
      qrcodeDateCodeEncoding: "koa_month_counter" as const,
      brands: ["KOA"],
    };
    const result = parseQrCapture(
      ":SR732ERTTDR200F::153:K:19077387:S002:KOA/SR732ERTTDR200F:13FSJ564:01",
      { supplierTemplates: [koaWclTemplate] }
    );
    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe("SR732ERTTDR200F");
    expect(result.parsed.qty).toBe(15000); // "153" → 15 × 10^3
    expect(result.parsed.dateCode).toBe("3726"); // "19077387" → counter 19 → 2026-09, day 07 → 2026-09-07 → ISO week 37
    expect(result.parsed.lotCode).toBe("19077387");
    expect(result.parsed.wclItemNo).toBe("KOA/SR732ERTTDR200F");
  });

  it("derives the WCL item no from a single-brand profile when the template has no wclItemNo group (ABLIC $ reel)", () => {
    const ablicTemplate = {
      code: "84915",
      qrcodeTemplate: String.raw`^1\$[^$]+\$(?<qty>\d+)\$(?<lotCode>[^$]+)\$(?<itemId>[^$]+)\$(?<dateCode>\d{6})\$(?<serialNo>[^$]+?)\s*$`,
      qrcodeQtyEncoding: null,
      qrcodeDateCodeEncoding: "yyyymm_midmonth" as const,
      brands: ["ABLIC"],
    };
    const result = parseQrCapture(
      "1$S-812C33AMC-C2NT2U$3000$VM5F6XA0033-0308$S-812C33AMC-C2NT2U$202606$66VM1953007          ",
      { supplierTemplates: [ablicTemplate] }
    );
    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe("S-812C33AMC-C2NT2U");
    expect(result.parsed.qty).toBe(3000);
    expect(result.parsed.lotCode).toBe("VM5F6XA0033-0308");
    // yyyymm_midmonth: "202606" → 2026-06-15 → ISO week 25 → WWYY "2526"
    expect(result.parsed.dateCode).toBe("2526");
    expect(result.parsed.serialNo).toBe("66VM1953007");
    // ABLIC parts are stored as wcl_item_no "ABLIC/<mpn>"; the label prints
    // no WCL item no, so the single-brand profile derives it.
    expect(result.parsed.wclItemNo).toBe("ABLIC/S-812C33AMC-C2NT2U");
  });

  it("does not derive a WCL item no for multi-brand or brand-less profiles", () => {
    const makeTemplate = (brands?: string[]) => ({
      code: "X",
      qrcodeTemplate: String.raw`^1\$[^$]+\$(?<qty>\d+)\$(?<lotCode>[^$]+)\$(?<itemId>[^$]+)\$(?<dateCode>\d{6})\$(?<serialNo>[^$]+?)\s*$`,
      qrcodeQtyEncoding: null,
      brands,
    });
    const raw = "1$S-812C33AMC-C2NT2U$3000$VM5F6XA0033-0308$S-812C33AMC-C2NT2U$202606$66VM1953007";
    expect(parseQrCapture(raw, { supplierTemplates: [makeTemplate(undefined)] }).parsed.wclItemNo).toBeUndefined();
    expect(parseQrCapture(raw, { supplierTemplates: [makeTemplate(["COPAL", "NIDEC"])] }).parsed.wclItemNo).toBeUndefined();
  });

  it("matches KOA label with empty lotCode segment", () => {
    const koaWclTemplate = {
      code: "32",
      qrcodeTemplate:
        "^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]*):(?<serialNo>[^:]+):(?<wclItemNo>[^:]+)(?::[^:]*)*:?$",
      qrcodeQtyEncoding: "koa_zeros" as const,
      qrcodeDateCodeEncoding: "koa_month_counter" as const,
      brands: ["KOA"],
    };
    const result = parseQrCapture(
      ":RK73H1ETTP1001F::54:X::S606:KOA+RK73H1ETTP 1001F",
      { supplierTemplates: [koaWclTemplate] }
    );
    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe("RK73H1ETTP1001F");
    expect(result.parsed.qty).toBe(50000); // "54" → 5 × 10^4
    expect(result.parsed.lotCode).toBeUndefined(); // empty segment → undefined
    expect(result.parsed.dateCode).toBeUndefined();
    expect(result.parsed.serialNo).toBe("S606");
    expect(result.parsed.wclItemNo).toBe("KOA+RK73H1ETTP 1001F");
  });

  it("parses the NCC drawing, full lot, and YMMDD date code without backtracking", () => {
    const nccTemplate = {
      code: "23",
      qrcodeTemplate: "^(?=.{28}$|.{32}$)(?<itemId>\\d{6}(?=.{22}$)|\\d{10}(?=.{22}$))(?:(?<=^.{10})\\d{3})?(?<lotCode>\\d{13}(?=.{9}$)|\\d{7}(?=.{12}$))(?:\\d{2}(?=.{10}$))?(?<qty>\\d{5,6})(?<serialNo>\\d{4})$",
      qrcodeQtyEncoding: null,
      qrcodeDateCodeEncoding: "ncc_lot_ymmdd" as const,
      brands: ["NCC"],
    };
    const raw = "5928846030912801026002000460";
    const result = parseQrCapture(raw, {
      supplierTemplates: [nccTemplate],
      contextBrands: ["NCC"],
      dateCodeFormat: "yyww",
    });

    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe("592884");
    expect(result.parsed.qty).toBe(200);
    expect(result.parsed.lotCode).toBe("60309-0128010-26");
    expect(result.parsed.dateCode).toBe("2611"); // 2026-03-09 → ISO week 11
    expect(result.parsed.serialNo).toBe("0460");
    expect(parseQrCapture(raw, { supplierTemplates: [nccTemplate] }).parsed.dateCode).toBe("1126");
  });

  it("parses an iC-Haus JSON Versandetikett QR (key-order independent)", () => {
    const ichausTemplate = {
      code: "20",
      qrcodeTemplate:
        '^\\{(?=.*"CANR"\\s*:\\s*"(?<wclItemNo>[^"]+)")(?=.*"IANR"\\s*:\\s*"(?<itemId>[^"]+)")(?=.*"Q"\\s*:\\s*"(?<qty>\\d+)")(?=.*"DC"\\s*:\\s*"(?<dateCode>\\d{4})")(?=.*"COO"\\s*:\\s*"(?<coo>[^"]+)")(?=.*"LTS"\\s*:\\s*"(?<serialNo>[^"]+)")(?=.*"AC"\\s*:\\s*"(?<lotCode>[^"]+)").*\\}$',
      qrcodeQtyEncoding: null,
      qrcodeDateCodeEncoding: "yyww" as const,
      brands: ["ICHAUS"],
    };
    const result = parseQrCapture(
      '{"type":"Versandetikett","version":"1","AC":"IRZ4248_6","VI":"<keine>","DC":"2337","Q":"10","ID":"50788","VID":"1","C":"WELTM","CANR":"ICHAUS/IC-RZ4248 OQFN38-7X5","IANR":"iC-RZ4248 oQFN38-7x5","CONR":"339084940.3","COO":"DE","LTS":"20260929-4"}',
      { supplierTemplates: [ichausTemplate] }
    );
    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe("IC-RZ4248OQFN38-7X5"); // IANR, space-collapsed
    expect(result.parsed.qty).toBe(10);
    expect(result.parsed.dateCode).toBe("3723"); // DC "2337" is YYWW → WWYY "3723"
    expect(result.parsed.coo).toBe("DE");
    expect(result.parsed.wclItemNo).toBe("ICHAUS/IC-RZ4248 OQFN38-7X5"); // = parts.wcl_item_no
    expect(result.parsed.serialNo).toBe("20260929-4"); // LTS — put-away duplicate check
    expect(result.parsed.lotCode).toBe("IRZ4248_6"); // AC = lot code
  });

  it("parses a TE datamatrix with yywwd encoding (5-digit DC, day dropped)", () => {
    const teTemplate = {
      code: "15915",
      qrcodeTemplate:
        "^\\[\\)>[\\x1d\\x1e\\xA0]?06[\\x1d\\xA0]LT(?<serialNo>[^\\x1d\\xA0\\x1e\\x04]+)[\\x1d\\xA0]PN(?<itemId>[^\\x1d\\xA0\\x1e\\x04]+)[\\x1d\\xA0]RV[^\\x1d\\xA0]*[\\x1d\\xA0]QT(?<qty>\\d+)[\\x1d\\xA0]PO[^\\x1d\\xA0]*[\\x1d\\xA0]BT(?<lotCode>[^\\x1d\\xA0\\x1e\\x04]+)[\\x1d\\xA0]BX[^\\x1d\\xA0]+[\\x1d\\xA0]DC(?<dateCode>[^\\x1d\\xA0\\x1e\\x04]+)[\\x1e\\x04]*$",
      qrcodeQtyEncoding: null,
      qrcodeDateCodeEncoding: "yywwd" as const,
      brands: ["TE"],
    };
    const raw =
      "[)>\x1e06\x1dLT3S550200578934\x1dPN1376348-1\x1dRVF\x1dQT5000\x1dPO200234935045\x1dBT26374N\x1dBX1\x1dDC26374\x1e\x04";
    const result = parseQrCapture(raw, { supplierTemplates: [teTemplate], contextBrands: ["TE"] });
    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe("1376348-1");
    expect(result.parsed.qty).toBe(5000);
    expect(result.parsed.dateCode).toBe("3726"); // DC "26374" → wk37/2026, day dropped, WWYY
    expect(result.parsed.lotCode).toBe("26374N");
    expect(result.parsed.serialNo).toBe("3S550200578934");
    // yyww flow config: pair-swapped label format
    expect(
      parseQrCapture(raw, { supplierTemplates: [teTemplate], contextBrands: ["TE"], dateCodeFormat: "yyww" }).parsed.dateCode
    ).toBe("2637");
  });

  it("prefers brand-matching templates when contextBrands is given", () => {
    const genericTemplate = {
      code: "GENERIC",
      qrcodeTemplate: "^(?<itemId>.+)$",
      qrcodeQtyEncoding: null,
    };
    const brandTemplate = {
      code: "32",
      qrcodeTemplate: "^ID:(?<itemId>[A-Z0-9]+)$",
      qrcodeQtyEncoding: null,
      brands: ["KOA"],
    };

    // generic is listed first and would win without brand context
    const withoutBrands = parseQrCapture("ID:RK73B1JTTD181G", {
      supplierTemplates: [genericTemplate, brandTemplate],
    });
    expect(withoutBrands.parsed.itemId).toBe("ID:RK73B1JTTD181G");

    const withBrands = parseQrCapture("ID:RK73B1JTTD181G", {
      supplierTemplates: [genericTemplate, brandTemplate],
      contextBrands: ["KOA"],
    });
    expect(withBrands.parsed.itemId).toBe("RK73B1JTTD181G");
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
