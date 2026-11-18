import { describe, it, expect } from 'vitest';
import { parseCnBoxQr, resolveCnBox } from '../utils/cnBoxQr';

// Real payloads from the warehouse prints (spec
// docs/superpowers/specs/2026-11-18-cn-putaway-box-qr-design.md).
const SZ_BOX_1 =
  '0;SZ-26110077;1;2;6;KOA+RK73H1ETTP 1000F;24;18;2F;14;15;2002F;14;10;JTTD 1200F;53;15;49R9F;25;9;2ATTD 5101F;53;Made In China;';
const GZ_BOX_1 = '0;GZ-26110068;1;4;6;KOA+RK73H2ATTD 8202F;…';

describe('parseCnBoxQr', () => {
  it('parses the real SZ print (box 1 of 2)', () => {
    expect(parseCnBoxQr(SZ_BOX_1)).toEqual({
      invoiceNo: 'SZ-26110077',
      boxSeq: 1,
      totalBoxes: 2,
    });
  });

  it('parses the real GZ print header and ignores the tail', () => {
    expect(parseCnBoxQr(GZ_BOX_1)).toEqual({
      invoiceNo: 'GZ-26110068',
      boxSeq: 1,
      totalBoxes: 4,
    });
  });

  it('tolerates surrounding whitespace and a missing trailing semicolon', () => {
    expect(parseCnBoxQr(`  ${SZ_BOX_1.slice(0, -1)}  `)).toEqual({
      invoiceNo: 'SZ-26110077',
      boxSeq: 1,
      totalBoxes: 2,
    });
  });

  it('rejects non-carton scans so they fall through to the item-label path', () => {
    expect(parseCnBoxQr('A-01-03-02')).toBeNull(); // shelf code
    expect(parseCnBoxQr('BOX-123')).toBeNull(); // shipping box id
    expect(parseCnBoxQr('KOA+RK73H2ATTD 8202F')).toBeNull(); // part label
    expect(parseCnBoxQr('TCX273')).toBeNull(); // supplier carton barcode
    expect(parseCnBoxQr('')).toBeNull();
    expect(parseCnBoxQr('0;SZ-26110077;1;2')).toBeNull(); // too short
  });

  it('rejects malformed headers', () => {
    // Non-integer flag / invoice / seq / total / item-count.
    expect(parseCnBoxQr('x;SZ-26110077;1;2;6;KOA')).toBeNull();
    expect(parseCnBoxQr('0;;1;2;6;KOA')).toBeNull();
    expect(parseCnBoxQr('0;SZ 26110077;1;2;6;KOA')).toBeNull();
    expect(parseCnBoxQr('0;SZ-26110077;0;2;6;KOA')).toBeNull();
    expect(parseCnBoxQr('0;SZ-26110077;1;0;6;KOA')).toBeNull();
    expect(parseCnBoxQr('0;SZ-26110077;1;2;0;KOA')).toBeNull();
    expect(parseCnBoxQr('0;SZ-26110077;3;2;6;KOA')).toBeNull(); // seq > total
    expect(parseCnBoxQr('0;SZ-26110077;1.5;2;6;KOA')).toBeNull();
  });
});

describe('resolveCnBox', () => {
  // Mirrors warehouse_sz invoice GZ-26110068: cartons 38/39/40/41, box 1 of 4
  // must resolve to ctn 38 — the case the warehouse walked through by hand.
  const gzItems = [
    { id: '1', invoiceNo: 'GZ-26110068', ctnNo: '38', remainingQty: 50000 },
    { id: '2', invoiceNo: 'GZ-26110068', ctnNo: '38', remainingQty: 100000 },
    { id: '3', invoiceNo: 'GZ-26110068', ctnNo: '38', remainingQty: 15000 },
    { id: '4', invoiceNo: 'GZ-26110068', ctnNo: '38', remainingQty: 100000 },
    { id: '5', invoiceNo: 'GZ-26110068', ctnNo: '39', remainingQty: 100000 },
    { id: '6', invoiceNo: 'GZ-26110068', ctnNo: '39', remainingQty: 200000 },
    { id: '7', invoiceNo: 'GZ-26110068', ctnNo: '40', remainingQty: 300000 },
    { id: '8', invoiceNo: 'GZ-26110068', ctnNo: '41', remainingQty: 200000 },
  ];

  it('GZ-26110068 box 1/4 → ctn 38 with its four lines', () => {
    const qr = parseCnBoxQr(GZ_BOX_1)!;
    const target = resolveCnBox(qr, gzItems);
    expect(target).toMatchObject({ ctnNo: '38' });
    if (!('error' in target)) expect(target.lines.map((l) => l.id)).toEqual(['1', '2', '3', '4']);
  });

  it('sorts ctn_no numerically, not as text', () => {
    // Text sort would order 1,10,11,2 — numeric must give 1,2,10,11.
    const items = [
      { invoiceNo: 'X-1', ctnNo: '1' },
      { invoiceNo: 'X-1', ctnNo: '10' },
      { invoiceNo: 'X-1', ctnNo: '11' },
      { invoiceNo: 'X-1', ctnNo: '2' },
    ];
    expect(resolveCnBox({ invoiceNo: 'X-1', boxSeq: 2, totalBoxes: 4 }, items)).toMatchObject({
      ctnNo: '2',
    });
    expect(resolveCnBox({ invoiceNo: 'X-1', boxSeq: 3, totalBoxes: 4 }, items)).toMatchObject({
      ctnNo: '10',
    });
  });

  it('scopes boxes per invoice on multi-invoice orders', () => {
    const items = [
      ...gzItems,
      { id: 'a', invoiceNo: 'SZ-26110077', ctnNo: '25', remainingQty: 1 },
      { id: 'b', invoiceNo: 'SZ-26110077', ctnNo: '26', remainingQty: 1 },
    ];
    const qr = parseCnBoxQr(SZ_BOX_1)!;
    const target = resolveCnBox(qr, items);
    expect(target).toMatchObject({ ctnNo: '25' });
    if (!('error' in target)) expect(target.lines.map((l) => l.id)).toEqual(['a']);
  });

  it('keeps resolving done lines so a finished box stays stable', () => {
    const items = gzItems.map((it) =>
      it.ctnNo === '38' ? { ...it, remainingQty: 0 } : it,
    );
    const target = resolveCnBox({ invoiceNo: 'GZ-26110068', boxSeq: 1, totalBoxes: 4 }, items);
    expect(target).toMatchObject({ ctnNo: '38' });
    if (!('error' in target)) expect(target.lines).toHaveLength(4);
  });

  it('reports wrong_order, not_found and no_numeric_ctn distinctly', () => {
    expect(resolveCnBox({ invoiceNo: 'XX-1', boxSeq: 1, totalBoxes: 4 }, gzItems)).toEqual({
      error: 'wrong_order',
    });
    expect(
      resolveCnBox({ invoiceNo: 'GZ-26110068', boxSeq: 5, totalBoxes: 4 }, gzItems),
    ).toEqual({ error: 'not_found' });
    expect(
      resolveCnBox({ invoiceNo: 'X-9', boxSeq: 1, totalBoxes: 1 }, [
        { invoiceNo: 'X-9', ctnNo: 'X273' },
      ]),
    ).toEqual({ error: 'no_numeric_ctn' });
  });

  it('ignores non-numeric ctn rows when picking the target box', () => {
    const items = [
      { invoiceNo: 'X-2', ctnNo: 'X273' }, // supplier-style carton barcode, not a box no
      { invoiceNo: 'X-2', ctnNo: '7' },
      { invoiceNo: 'X-2', ctnNo: '8' },
    ];
    expect(resolveCnBox({ invoiceNo: 'X-2', boxSeq: 1, totalBoxes: 2 }, items)).toMatchObject({
      ctnNo: '7',
    });
  });
});
