import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBackendWarehouseService } from './backendWarehouse';
import { createWarehouseService } from '../warehouse';
import { ApiError } from '../apiClient';
import { clearApiCache } from '../apiCache';

const BASE_URL = 'http://backend.test';

// The apiClient GET cache is module-level; keep tests isolated from it.
beforeEach(() => {
  clearApiCache();
});

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}

describe('createBackendWarehouseService', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('resetDemoData POSTs /dev/reset against the configured base URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const service = createBackendWarehouseService({
      apiBaseUrl: BASE_URL,
      getActorId: () => 'u-actor',
    });

    await service.resetDemoData();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/dev/reset`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('resetDemoData propagates API errors', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'something exploded',
      json: async () => {
        throw new Error('no json');
      },
    } as unknown as Response);
    const service = createBackendWarehouseService({
      apiBaseUrl: BASE_URL,
      getActorId: () => 'u-actor',
    });

    await expect(service.resetDemoData()).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe('backendWarehouse receiving flow', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  function service(actorId: string | undefined = 'u-actor') {
    return createBackendWarehouseService({
      apiBaseUrl: BASE_URL,
      getActorId: () => actorId,
    });
  }

  function lastCall() {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    return { url: url as string, init: init as RequestInit };
  }

  it('getReceivingOrders filters by status and skips the param for "all"', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await service().getReceivingOrders('in_hand');
    expect(lastCall().url).toBe(`${BASE_URL}/receiving-orders?status=in_hand`);
    expect(lastCall().init.method).toBe('GET');

    await service().getReceivingOrders('all');
    expect(lastCall().url).toBe(`${BASE_URL}/receiving-orders`);
  });

  it('getReceivingOrder GETs the nested detail', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'ro1', invoices: [] }));

    const detail = await service().getReceivingOrder('ro1');

    expect(lastCall().url).toBe(`${BASE_URL}/receiving-orders/ro1`);
    expect(lastCall().init.method).toBe('GET');
    expect(detail.id).toBe('ro1');
  });

  it('confirmReceivingOrderArrived POSTs the actor id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'ro1', status: 'in_hand' }));

    await service().confirmReceivingOrderArrived('ro1');

    expect(lastCall().url).toBe(`${BASE_URL}/receiving-orders/ro1/confirm-arrival`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });
  });

  it('getPickingOrdersByReceivingOrder GETs the picking section', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pickingOrders: [] }));

    const section = await service().getPickingOrdersByReceivingOrder('ro1');

    expect(lastCall().url).toBe(`${BASE_URL}/receiving-orders/ro1/picking`);
    expect(section.pickingOrders).toEqual([]);
  });

  it('scanReceiving POSTs actorId + raw and returns the applied item', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 'rii1', partId: 'p1', partNo: 'ABC', qty: 100, receivedQty: 50 })
    );

    const result = await service().scanReceiving('ro1', { raw: 'RAW-LABEL' });

    expect(lastCall().url).toBe(`${BASE_URL}/receiving-orders/ro1/scan`);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      actorId: 'u-actor',
      raw: 'RAW-LABEL',
    });
    expect(result.receivedQty).toBe(50);
  });

  it('scanReceiving surfaces 409 candidate bodies on the ApiError', async () => {
    const candidates = [
      { id: 'rii1', partId: 'p1', partNo: 'ABC', wclItemNo: null, qty: 100, receivedQty: 0 },
      { id: 'rii2', partId: 'p1', partNo: 'ABC', wclItemNo: 'W-1', qty: 200, receivedQty: 0 },
    ];
    fetchMock.mockResolvedValue(
      jsonResponse({ message: 'multiple_matches', candidates }, 409)
    );

    const err = await service()
      .scanReceiving('ro1', { raw: 'RAW-LABEL' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.body?.message).toBe('multiple_matches');
    expect(err.body?.candidates).toHaveLength(2);
  });

  it('scanReceiving can resend explicit fields picked from the candidates', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'rii2' }));

    await service().scanReceiving('ro1', { raw: 'RAW-LABEL', partNo: 'ABC', qty: 25 });

    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      actorId: 'u-actor',
      raw: 'RAW-LABEL',
      partNo: 'ABC',
      qty: 25,
    });
  });

  it('mutations reject locally when no operator is signed in', async () => {
    const signedOut = () =>
      createBackendWarehouseService({
        apiBaseUrl: BASE_URL,
        getActorId: () => undefined,
      });
    await expect(signedOut().confirmReceivingOrderArrived('ro1')).rejects.toThrow(
      'operator_not_signed_in'
    );
    await expect(
      signedOut().scanReceiving('ro1', { raw: 'x' })
    ).rejects.toThrow('operator_not_signed_in');
    await expect(
      signedOut().reportMismatch('rii1', { reason: 'damaged' })
    ).rejects.toThrow('operator_not_signed_in');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs the item-keyed mismatch lifecycle against /receiving-invoice-items/:id/mismatch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null));

    await service().getActiveMismatch('rii1');
    expect(lastCall().url).toBe(`${BASE_URL}/receiving-invoice-items/rii1/mismatch`);
    expect(lastCall().init.method).toBe('GET');

    await service().reportMismatch('rii1', { reason: 'damaged', mismatchQty: 3, note: 'dented' });
    expect(lastCall().url).toBe(`${BASE_URL}/receiving-invoice-items/rii1/mismatch`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      actorId: 'u-actor',
      reason: 'damaged',
      mismatchQty: 3,
      note: 'dented',
    });

    await service().editMismatch('rii1', { reason: 'qty_mismatch', mismatchQty: 5 });
    expect(lastCall().url).toBe(`${BASE_URL}/receiving-invoice-items/rii1/mismatch`);
    expect(lastCall().init.method).toBe('PATCH');

    await service().confirmMismatch('rii1');
    expect(lastCall().url).toBe(`${BASE_URL}/receiving-invoice-items/rii1/mismatch/confirm`);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });

    await service().cancelMismatch('rii1');
    expect(lastCall().url).toBe(`${BASE_URL}/receiving-invoice-items/rii1/mismatch/cancel`);
  });

  it('getSupplierQrTemplates maps the scan-templates DTO to the client shape', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { supplierCode: 'KOA', qrTemplate: '^.*$', qtyEncoding: 'koa_zeros' },
        { supplierCode: 'DAITO', qrTemplate: null, qtyEncoding: null },
      ])
    );

    const templates = await service().getSupplierQrTemplates();

    expect(lastCall().url).toBe(`${BASE_URL}/scan-templates`);
    expect(templates).toEqual([
      { code: 'KOA', qrcodeTemplate: '^.*$', qrcodeQtyEncoding: 'koa_zeros' },
      { code: 'DAITO', qrcodeTemplate: '', qrcodeQtyEncoding: null },
    ]);
  });

  it('maps the shipping-box / package mutations used by the receiving picking tab', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await service().createShippingBoxForPickingOrder('po1');
    expect(lastCall().url).toBe(`${BASE_URL}/picking-orders/po1/boxes`);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });

    await service().addPackageToBox('pkg1', 'box1');
    expect(lastCall().url).toBe(`${BASE_URL}/shipping-boxes/box1/packages`);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      packageId: 'pkg1',
      actorId: 'u-actor',
    });

    await service().removePackageFromBox('box1', 'pkg1');
    expect(lastCall().url).toBe(`${BASE_URL}/shipping-boxes/box1/packages/pkg1`);
    expect(lastCall().init.method).toBe('DELETE');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });

    await service().removeScannedPackage('pkg1');
    expect(lastCall().url).toBe(`${BASE_URL}/packages/pkg1`);
    expect(lastCall().init.method).toBe('DELETE');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });
  });

  it('addAllUnboxedPackagesToBox returns the packed count', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ packed: 4 }));

    const count = await service().addAllUnboxedPackagesToBox('box1');

    expect(lastCall().url).toBe(`${BASE_URL}/shipping-boxes/box1/add-all-unboxed`);
    expect(count).toBe(4);
  });
});

describe('backendWarehouse put-away flow', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  function service(actorId: string | undefined = 'u-actor') {
    return createBackendWarehouseService({
      apiBaseUrl: BASE_URL,
      getActorId: () => actorId,
    });
  }

  function lastCall() {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    return { url: url as string, init: init as RequestInit };
  }

  it('getPutAwayCandidates GETs /put-away/candidates', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          id: 'ro1',
          refNo: '04958210',
          status: 'in_hand',
          supplierCode: 'DAITO',
          supplierName: 'DAITO',
          warehouseCode: 'HK1',
          warehouseSectionCode: 'MAIN',
          subInventoryCode: 'STORE1',
          receivedItems: 2,
          unboxedItems: 2,
        },
      ])
    );

    const rows = await service().getPutAwayCandidates();

    expect(lastCall().url).toBe(`${BASE_URL}/put-away/candidates`);
    expect(lastCall().init.method).toBe('GET');
    expect(rows[0].unboxedItems).toBe(2);
  });

  it('getPutAwayDetail GETs the one aggregate', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        order: { id: 'ro1', refNo: '04958210', status: 'in_hand' },
        items: [{ id: 'rii1', remainingQty: 100 }],
        lots: [],
        scans: [{ id: 'scan1', receivingInvoiceItemId: 'rii1', qty: 5 }],
        boxes: [{ id: 'SBOX-0002', shelfCode: 'A-01-02', status: 'open', items: [] }],
      })
    );

    const detail = await service().getPutAwayDetail('ro1');

    expect(lastCall().url).toBe(`${BASE_URL}/receiving-orders/ro1/put-away`);
    expect(lastCall().init.method).toBe('GET');
    expect(detail.items[0].id).toBe('rii1');
    expect(detail.scans[0].qty).toBe(5);
    expect(detail.boxes[0].items).toEqual([]);
  });

  it('getShelves reads the admin shelves list', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ code: 'A-01-01', zone: 'A', locationType: 'shelf' }])
    );

    const shelves = await service().getShelves();

    expect(lastCall().url).toBe(`${BASE_URL}/admin/shelves`);
    expect(lastCall().init.method).toBe('GET');
    expect(shelves[0].code).toBe('A-01-01');
  });

  it('recordPutAwayScan POSTs to the order path with actorId and batch fields', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'scan1' }, 201));

    await service().recordPutAwayScan('ro1', 'rii1', 25, '2610', 'L1', 'JP', 'TW');

    expect(lastCall().url).toBe(`${BASE_URL}/receiving-orders/ro1/put-away-scans`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      actorId: 'u-actor',
      receivingInvoiceItemId: 'rii1',
      qty: 25,
      dateCode: '2610',
      lotCode: 'L1',
      coo: 'JP',
      cow: 'TW',
    });
  });

  it('recordPutAwayScan omits null batch fields', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'scan1' }, 201));

    await service().recordPutAwayScan('ro1', 'rii1', 10, null, null, null, null);

    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      actorId: 'u-actor',
      receivingInvoiceItemId: 'rii1',
      qty: 10,
    });
  });

  it('assignPutAwayScanToBox POSTs the scan id to the box scans route', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await service().assignPutAwayScanToBox('scan1', 'SBOX-0002');

    expect(lastCall().url).toBe(`${BASE_URL}/shelf-boxes/SBOX-0002/scans`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      scanId: 'scan1',
      actorId: 'u-actor',
    });
  });

  it('removePutAwayScanFromBox DELETEs the scan membership with actorId body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await service().removePutAwayScanFromBox('scan1', 'SBOX-0002');

    expect(lastCall().url).toBe(`${BASE_URL}/shelf-boxes/SBOX-0002/scans/scan1`);
    expect(lastCall().init.method).toBe('DELETE');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });
  });

  it('removePutAwayScannedPiece DELETEs the staged scan with actorId body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await service().removePutAwayScannedPiece('scan1');

    expect(lastCall().url).toBe(`${BASE_URL}/put-away-scans/scan1`);
    expect(lastCall().init.method).toBe('DELETE');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });
  });

  it('addAllUnboxedScansToBox returns the count', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ count: 3 }));

    const count = await service().addAllUnboxedScansToBox('SBOX-0002');

    expect(lastCall().url).toBe(`${BASE_URL}/shelf-boxes/SBOX-0002/add-all-unboxed`);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });
    expect(count).toBe(3);
  });

  it('createShelfBox POSTs receivingOrderId + shelfCode + actorId', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 'SBOX-0003', receivingOrderId: 'ro1', shelfCode: 'A-01-02', status: 'open' }, 201)
    );

    const box = await service().createShelfBox('ro1', 'A-01-02');

    expect(lastCall().url).toBe(`${BASE_URL}/shelf-boxes`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      receivingOrderId: 'ro1',
      shelfCode: 'A-01-02',
      actorId: 'u-actor',
    });
    expect(box.id).toBe('SBOX-0003');
  });

  it('closeShelfBox POSTs the close verb; cancelShelfBox DELETEs with actorId body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await service().closeShelfBox('SBOX-0002');
    expect(lastCall().url).toBe(`${BASE_URL}/shelf-boxes/SBOX-0002/close`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });

    await service().cancelShelfBox('SBOX-0002');
    expect(lastCall().url).toBe(`${BASE_URL}/shelf-boxes/SBOX-0002`);
    expect(lastCall().init.method).toBe('DELETE');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });
  });

  it('put-away mutations reject locally when no operator is signed in', async () => {
    const signedOut = () =>
      createBackendWarehouseService({
        apiBaseUrl: BASE_URL,
        getActorId: () => undefined,
      });

    await expect(
      signedOut().recordPutAwayScan('ro1', 'rii1', 1, null, null, null, null)
    ).rejects.toThrow('operator_not_signed_in');
    await expect(signedOut().assignPutAwayScanToBox('scan1', 'b1')).rejects.toThrow(
      'operator_not_signed_in'
    );
    await expect(signedOut().removePutAwayScanFromBox('scan1', 'b1')).rejects.toThrow(
      'operator_not_signed_in'
    );
    await expect(signedOut().removePutAwayScannedPiece('scan1')).rejects.toThrow(
      'operator_not_signed_in'
    );
    await expect(signedOut().addAllUnboxedScansToBox('b1')).rejects.toThrow(
      'operator_not_signed_in'
    );
    await expect(signedOut().createShelfBox('ro1', 'A-01-01')).rejects.toThrow(
      'operator_not_signed_in'
    );
    await expect(signedOut().closeShelfBox('b1')).rejects.toThrow('operator_not_signed_in');
    await expect(signedOut().cancelShelfBox('b1')).rejects.toThrow('operator_not_signed_in');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('backendWarehouse picking flow', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  function service(actorId: string | undefined = 'u-actor') {
    return createBackendWarehouseService({
      apiBaseUrl: BASE_URL,
      getActorId: () => actorId,
    });
  }

  function lastCall() {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    return { url: url as string, init: init as RequestInit };
  }

  it('getPickingOrders passes the status filter through and skips it when absent', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await service().getPickingOrders();
    expect(lastCall().url).toBe(`${BASE_URL}/picking-orders`);
    expect(lastCall().init.method).toBe('GET');

    await service().getPickingOrders('picking');
    expect(lastCall().url).toBe(`${BASE_URL}/picking-orders?status=picking`);
  });

  it('getPickingOrder GETs the nested detail', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'po1',
        refNo: 'SO-2026-0001',
        status: 'picking',
        measuringTask: null,
        items: [
          {
            id: 'pi1',
            partNo: 'RK73H1JTTD1002F',
            qty: 2000,
            pickedQty: 0,
            allocatedQty: 2000,
            allocations: [
              {
                id: 'a1',
                qty: 2000,
                lot: { id: 'lot1', shelfCode: 'A-01-01', boxId: 'BOX-0001' },
                receivingInvoiceItemId: null,
                receivingOrderId: null,
                boxId: null,
              },
            ],
            packages: [],
          },
        ],
        boxes: [{ id: 'box1', status: 'open', packageCount: 0 }],
      })
    );

    const detail = await service().getPickingOrder('po1');

    expect(lastCall().url).toBe(`${BASE_URL}/picking-orders/po1`);
    expect(lastCall().init.method).toBe('GET');
    expect(detail.items[0].allocations[0].lot?.shelfCode).toBe('A-01-01');
    expect(detail.boxes[0].packageCount).toBe(0);
  });

  it('scanPickingItem POSTs to /picking-items/:id/scan and unwraps {packageIds}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ packageIds: ['pkg1', 'pkg2'] }, 201));

    const result = await service().scanPickingItem('pi1', {
      allocationId: 'a1',
      qty: 500,
      dateCode: '2601',
      lotCode: 'L1',
      coo: 'JP',
      cow: 'TW',
    });

    expect(lastCall().url).toBe(`${BASE_URL}/picking-items/pi1/scan`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      actorId: 'u-actor',
      allocationId: 'a1',
      qty: 500,
      dateCode: '2601',
      lotCode: 'L1',
      coo: 'JP',
      cow: 'TW',
    });
    expect(result.packageIds).toEqual(['pkg1', 'pkg2']);
  });

  it('scanPickingItem omits null batch fields so the source attrs win', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ packageIds: ['pkg1'] }, 201));

    await service().scanPickingItem('pi1', {
      allocationId: 'a1',
      qty: 10,
      dateCode: null,
      lotCode: null,
      coo: null,
      cow: null,
    });

    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      actorId: 'u-actor',
      allocationId: 'a1',
      qty: 10,
    });
  });

  it('verifyPackage POSTs /packages/:id/verify with the actor id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await service().verifyPackage('pkg1');

    expect(lastCall().url).toBe(`${BASE_URL}/packages/pkg1/verify`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });
  });

  it('updateShippingBox PATCHes gram weights and box fields', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'box1' }));

    await service().updateShippingBox('box1', {
      boxSize: '20 X 16 X 20',
      netWeightG: 500,
      grossWeightG: '650',
      destinationCountry: 'HK',
    });

    expect(lastCall().url).toBe(`${BASE_URL}/shipping-boxes/box1`);
    expect(lastCall().init.method).toBe('PATCH');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      actorId: 'u-actor',
      boxSize: '20 X 16 X 20',
      netWeightG: 500,
      grossWeightG: '650',
      destinationCountry: 'HK',
    });
  });

  it('cancelShippingBox and closeShippingBox POST the lifecycle verbs', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await service().cancelShippingBox('box1');
    expect(lastCall().url).toBe(`${BASE_URL}/shipping-boxes/box1/cancel`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });

    await service().closeShippingBox('box1');
    expect(lastCall().url).toBe(`${BASE_URL}/shipping-boxes/box1/close`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });
  });

  it('finishPickingOrder POSTs the finish verb and returns the measuring task', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 'mt1', pickingOrderId: 'po1', status: 'pending' })
    );

    const task = await service().finishPickingOrder('po1');

    expect(lastCall().url).toBe(`${BASE_URL}/picking-orders/po1/finish`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });
    expect(task).toEqual({ id: 'mt1', pickingOrderId: 'po1', status: 'pending' });
  });

  it('reportPickingOrderIssues POSTs per-order entries and returns id arrays', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ reported: ['po1'], skipped: ['po2'] }));

    const entries = [
      {
        pickingOrderId: 'po1',
        reason: 'insufficient_stock' as const,
        qty: 100,
        packSize: null,
        note: 'partial',
        remark: 'only 100 on the shelf',
      },
      {
        pickingOrderId: 'po2',
        reason: 'insufficient_stock' as const,
        qty: 100,
        packSize: null,
        note: 'partial',
        remark: null,
      },
    ];
    const result = await service().reportPickingOrderIssues(entries);

    expect(lastCall().url).toBe(`${BASE_URL}/picking-orders/report-issues`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      actorId: 'u-actor',
      entries,
    });
    expect(result).toEqual({ reported: ['po1'], skipped: ['po2'] });
  });

  it('picking mutations reject locally when no operator is signed in', async () => {
    const signedOut = () =>
      createBackendWarehouseService({
        apiBaseUrl: BASE_URL,
        getActorId: () => undefined,
      });

    await expect(
      signedOut().scanPickingItem('pi1', { allocationId: 'a1', qty: 1 })
    ).rejects.toThrow('operator_not_signed_in');
    await expect(signedOut().verifyPackage('pkg1')).rejects.toThrow(
      'operator_not_signed_in'
    );
    await expect(
      signedOut().updateShippingBox('box1', { boxSize: 'S' })
    ).rejects.toThrow('operator_not_signed_in');
    await expect(signedOut().cancelShippingBox('box1')).rejects.toThrow(
      'operator_not_signed_in'
    );
    await expect(signedOut().closeShippingBox('box1')).rejects.toThrow(
      'operator_not_signed_in'
    );
    await expect(signedOut().finishPickingOrder('po1')).rejects.toThrow(
      'operator_not_signed_in'
    );
    await expect(
      signedOut().reportPickingOrderIssues([
        { pickingOrderId: 'po1', reason: 'other' },
      ])
    ).rejects.toThrow('operator_not_signed_in');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('backendWarehouse measuring flow', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  function service(actorId: string | undefined = 'u-actor') {
    return createBackendWarehouseService({
      apiBaseUrl: BASE_URL,
      getActorId: () => actorId,
    });
  }

  function lastCall() {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    return { url: url as string, init: init as RequestInit };
  }

  it('getMeasuringTasks passes the status filter through and skips it when absent', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await service().getMeasuringTasks();
    expect(lastCall().url).toBe(`${BASE_URL}/measuring-tasks`);
    expect(lastCall().init.method).toBe('GET');

    await service().getMeasuringTasks('pending');
    expect(lastCall().url).toBe(`${BASE_URL}/measuring-tasks?status=pending`);
  });

  it('getMeasuringTasks returns the list rows verbatim', async () => {
    const rows = [
      {
        id: 'mt1',
        status: 'pending',
        pickingOrderId: 'po1',
        refNo: 'SO-2026-0001',
        shipTo: 'ACME HK',
        boxCount: 2,
        closedBoxCount: 1,
        createdAt: '2026-07-17T10:00:00.000Z',
      },
    ];
    fetchMock.mockResolvedValue(jsonResponse(rows));

    const result = await service().getMeasuringTasks('pending');

    expect(result).toEqual(rows);
  });

  it('getMeasuringTask GETs the consolidated detail', async () => {
    const detail = {
      task: { id: 'mt1', status: 'pending', pickingOrderId: 'po1', createdAt: '2026-07-17T10:00:00.000Z' },
      order: {
        id: 'po1',
        refNo: 'SO-2026-0001',
        status: 'finished',
        shipTo: 'ACME HK',
        customerCode: 'ACME',
        destinationCountry: 'Hong Kong',
        poNo: 'PO-1',
      },
      boxes: [
        {
          id: 'box1',
          status: 'open',
          boxSize: null,
          grossWeight: null,
          netWeight: null,
          destinationCountry: null,
          packages: [
            {
              id: 'pkg1',
              qty: 500,
              dateCode: '2601',
              lotCode: 'L1',
              coo: 'JP',
              cow: 'TW',
              verified: false,
              partId: 'part1',
              partNo: 'RK73H1JTTD1002F',
              wclItemNo: 'WCL-1',
            },
          ],
        },
      ],
    };
    fetchMock.mockResolvedValue(jsonResponse(detail));

    const result = await service().getMeasuringTask('mt1');

    expect(lastCall().url).toBe(`${BASE_URL}/measuring-tasks/mt1`);
    expect(lastCall().init.method).toBe('GET');
    expect(result).toEqual(detail);
    expect(result.boxes[0].packages[0].partNo).toBe('RK73H1JTTD1002F');
  });

  it('completeMeasuringTask POSTs the complete verb with the actor id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await service().completeMeasuringTask('mt1');

    expect(lastCall().url).toBe(`${BASE_URL}/measuring-tasks/mt1/complete`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });
  });

  it('completeMeasuringTask rejects locally when no operator is signed in', async () => {
    const signedOut = createBackendWarehouseService({
      apiBaseUrl: BASE_URL,
      getActorId: () => undefined,
    });
    await expect(signedOut.completeMeasuringTask('mt1')).rejects.toThrow(
      'operator_not_signed_in'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('backendWarehouse goods verify flow', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  function service(actorId: string | undefined = 'u-actor') {
    return createBackendWarehouseService({
      apiBaseUrl: BASE_URL,
      getActorId: () => actorId,
    });
  }

  function lastCall() {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    return { url: url as string, init: init as RequestInit };
  }

  it('generateGoodsVerifyTasks POSTs an empty body without a date', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ created: 3, date: '2026-07-17' }));

    const result = await service().generateGoodsVerifyTasks();

    expect(lastCall().url).toBe(`${BASE_URL}/goods-verify-tasks/generate`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({});
    expect(result).toEqual({ created: 3, date: '2026-07-17' });
  });

  it('generateGoodsVerifyTasks POSTs the date when given (no actorId — system job)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ created: 0, date: '2026-07-16' }));

    const result = await service().generateGoodsVerifyTasks('2026-07-16');

    expect(JSON.parse(lastCall().init.body as string)).toEqual({ date: '2026-07-16' });
    expect(result.created).toBe(0);
  });

  it('getGoodsVerifyTasks passes the filters through and skips absent ones', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await service().getGoodsVerifyTasks();
    expect(lastCall().url).toBe(`${BASE_URL}/goods-verify-tasks`);
    expect(lastCall().init.method).toBe('GET');

    await service().getGoodsVerifyTasks({ date: '2026-07-17', status: 'pending', shelfCode: 'A-01-01' });
    expect(lastCall().url).toBe(
      `${BASE_URL}/goods-verify-tasks?date=2026-07-17&status=pending&shelfCode=A-01-01`
    );
  });

  it('getGoodsVerifyTasks returns the queue rows verbatim', async () => {
    const rows = [
      {
        id: 'gvt1',
        taskDate: '2026-07-17',
        shelfCode: 'A-01-01',
        boxId: 'SBOX-0001',
        partId: 'part1',
        partNo: 'RK73H1JTTD1002F',
        wclItemNo: 'WCL-1',
        expectedQty: 500,
        status: 'pending',
        verifiedBy: null,
        verifiedAt: null,
      },
    ];
    fetchMock.mockResolvedValue(jsonResponse(rows));

    const result = await service().getGoodsVerifyTasks({ date: '2026-07-17' });

    expect(result).toEqual(rows);
  });

  it('getGoodsVerifyTask GETs the nested detail', async () => {
    const detail = {
      task: {
        id: 'gvt1',
        taskDate: '2026-07-17',
        inventoryLotId: 'lot1',
        shelfCode: 'A-01-01',
        boxId: 'SBOX-0001',
        partId: 'part1',
        partNo: 'RK73H1JTTD1002F',
        wclItemNo: 'WCL-1',
        description: 'RES 10K 1%',
        expectedQty: 500,
        status: 'pending',
        verifiedBy: null,
        verifiedAt: null,
        createdAt: '2026-07-17T10:00:00.000Z',
      },
      lot: {
        id: 'lot1',
        dateCode: '2601',
        lotCode: 'L1',
        coo: 'JP',
        cow: 'TW',
        shelfCode: 'A-01-01',
        boxId: 'SBOX-0001',
        totalQty: 500,
        allocatedQty: 0,
        availableQty: 500,
        warehouseCode: 'HK1',
        warehouseSectionCode: 'MAIN',
        subInventoryCode: 'STORE1',
      },
      box: {
        id: 'SBOX-0001',
        status: 'closed',
        items: [
          { id: 'sbi1', partId: 'part1', partNo: 'RK73H1JTTD1002F', qty: 500, verified: false, verifiedAt: null },
        ],
      },
    };
    fetchMock.mockResolvedValue(jsonResponse(detail));

    const result = await service().getGoodsVerifyTask('gvt1');

    expect(lastCall().url).toBe(`${BASE_URL}/goods-verify-tasks/gvt1`);
    expect(lastCall().init.method).toBe('GET');
    expect(result).toEqual(detail);
    expect(result.box?.items[0].partNo).toBe('RK73H1JTTD1002F');
  });

  it('verifyGoodsVerifyTask POSTs the actor id and omits countedQty when absent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'gvt1', status: 'verified' }));

    const result = await service().verifyGoodsVerifyTask('gvt1');

    expect(lastCall().url).toBe(`${BASE_URL}/goods-verify-tasks/gvt1/verify`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ actorId: 'u-actor' });
    expect(result.status).toBe('verified');
  });

  it('verifyGoodsVerifyTask includes countedQty when given', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'gvt1', status: 'verified' }));

    await service().verifyGoodsVerifyTask('gvt1', 480);

    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      actorId: 'u-actor',
      countedQty: 480,
    });
  });

  it('verifyGoodsVerifyTask rejects locally when no operator is signed in', async () => {
    const signedOut = createBackendWarehouseService({
      apiBaseUrl: BASE_URL,
      getActorId: () => undefined,
    });
    await expect(signedOut.verifyGoodsVerifyTask('gvt1', 1)).rejects.toThrow(
      'operator_not_signed_in'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('backendWarehouse stock search flow', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  function service() {
    return createBackendWarehouseService({
      apiBaseUrl: BASE_URL,
      getActorId: () => 'u-actor',
    });
  }

  function lastCall() {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    return { url: url as string, init: init as RequestInit };
  }

  it('searchStock builds the query string from the filters and skips absent ones', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ parts: [], lots: [] }));

    await service().searchStock();
    expect(lastCall().url).toBe(`${BASE_URL}/stock-search`);
    expect(lastCall().init.method).toBe('GET');

    await service().searchStock({ partNo: 'RK73' });
    expect(lastCall().url).toBe(`${BASE_URL}/stock-search?partNo=RK73`);

    await service().searchStock({
      supplierId: 'sup1',
      partNo: 'RK73',
      shelfCode: 'A-01-01',
    });
    expect(lastCall().url).toBe(
      `${BASE_URL}/stock-search?supplierId=sup1&partNo=RK73&shelfCode=A-01-01`
    );
  });

  it('searchStock returns the parts/lots rows verbatim', async () => {
    const result = {
      parts: [
        {
          id: 'part1',
          partNo: 'RK73H1JTTD1002F',
          wclItemNo: 'WCL-1',
          description: 'RES 10K 1%',
          defaultCoo: 'JP',
          onHandQty: 500,
        },
      ],
      lots: [
        {
          partId: 'part1',
          dateCode: '2601',
          lotCode: 'L1',
          coo: 'JP',
          cow: 'TW',
          shelfCode: 'A-01-01',
          boxId: 'SBOX-0001',
          warehouseCode: 'HK1',
          warehouseSectionCode: 'MAIN',
          subInventoryCode: 'STORE1',
          totalQty: 500,
          allocatedQty: 0,
          availableQty: 500,
        },
        {
          partId: 'part1',
          dateCode: null,
          lotCode: null,
          coo: null,
          cow: null,
          shelfCode: null,
          boxId: null,
          warehouseCode: 'HK1',
          warehouseSectionCode: null,
          subInventoryCode: null,
          totalQty: 0,
          allocatedQty: 0,
          availableQty: 0,
        },
      ],
    };
    fetchMock.mockResolvedValue(jsonResponse(result));

    const actual = await service().searchStock({ shelfCode: 'A-01-01' });

    expect(lastCall().url).toBe(`${BASE_URL}/stock-search?shelfCode=A-01-01`);
    expect(actual).toEqual(result);
  });

  it('searchStock passes an empty result through', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ parts: [], lots: [] }));

    const actual = await service().searchStock({ partNo: 'NOPE' });

    expect(actual).toEqual({ parts: [], lots: [] });
  });

  it('getSuppliers reads the admin suppliers list for the filter dropdown', async () => {
    const rows = [
      { id: 'sup1', code: 'KOA', name: 'KOA Corporation', shortName: 'KOA' },
      { id: 'sup2', code: 'DAITO', name: 'DAITO', shortName: null },
    ];
    fetchMock.mockResolvedValue(jsonResponse(rows));

    const suppliers = await service().getSuppliers();

    expect(lastCall().url).toBe(`${BASE_URL}/admin/suppliers`);
    expect(lastCall().init.method).toBe('GET');
    expect(suppliers).toEqual(rows);
  });
});

describe('createWarehouseService', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('wires the backend adapter without an adapter option', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const service = createWarehouseService({
      apiBaseUrl: BASE_URL,
      getActorId: () => 'u-actor',
    });

    await service.resetDemoData();

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/dev/reset`,
      expect.objectContaining({ method: 'POST' })
    );
  });
});

describe('backendWarehouse box search', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  function service(actorId: string | undefined = 'u-actor') {
    return createBackendWarehouseService({
      apiBaseUrl: BASE_URL,
      getActorId: () => actorId,
    });
  }

  function lastCall() {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    return { url: url as string, init: init as RequestInit };
  }

  it('searchBoxes GETs /boxes with the q param and returns rows verbatim', async () => {
    const rows = [
      { kind: 'shipping', id: 'BOX-S-HK1-20260720-0001', status: 'open', createdAt: '2026-07-20T01:00:00.000Z', refNo: 'SO-2026-0001' },
      { kind: 'shelf', id: 'BOX-H-HK1-20260720-0001', status: 'open', createdAt: '2026-07-20T01:01:00.000Z', refNo: '04958210' },
    ];
    fetchMock.mockResolvedValue(jsonResponse(rows));

    const result = await service().searchBoxes('0001');

    expect(lastCall().url).toBe(`${BASE_URL}/boxes?q=0001`);
    expect(lastCall().init.method).toBe('GET');
    expect(result).toEqual(rows);
  });
});
