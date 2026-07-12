import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApiWarehouseService } from './apiWarehouse';
import type { WarehouseService } from '../warehouse';

const ACTOR_ID = 'u-actor';

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}

const MISMATCH_ROW = {
  id: 'mm1',
  receiving_invoice_item_id: 'rii1',
  kind: 'qty_mismatch',
  mismatch_qty: 2,
  wrong_part_no: null,
  note: 'short',
  status: 'pending',
  effective_received_qty: 8,
  previous_received_qty: 10,
  reported_by: 'u1',
  confirmed_by: null,
  confirmed_at: null,
  cancelled_by: null,
  cancelled_at: null,
  created_at: '2026-07-02T10:00:00.000Z',
  updated_at: '2026-07-02T10:00:00.000Z',
};

const ORDER_BUNDLE = {
  id: 'ro1',
  ref_no: 'RO-001',
  status: 'in_hand',
  delivery_date: '2026-07-01T00:00:00.000Z',
  remaining_items: 2,
  allocated_by_item: { rii1: 5 },
  supplier: {
    id: 's1',
    code: 'SUP',
    name: 'Supplier One',
    qr_template: 'tpl',
    qrcode_qty_encoding: 'enc',
  },
  invoices: [
    {
      id: 'inv1',
      receiving_order_id: 'ro1',
      invoice_no: 'INV-1',
      supplier_id: 's1',
      items: [
        {
          id: 'rii1',
          receiving_invoice_id: 'inv1',
          part_id: 'p1',
          qty: 10,
          received_qty: 10,
          picked_qty: 3,
          put_away_qty: 2,
          box_id: null,
          date_code: 'D1',
          lot_code: 'L1',
          coo: 'CN',
          cow: null,
          part: { id: 'p1', part_no: 'PN-1', description: 'Part one' },
          mismatch: MISMATCH_ROW,
        },
      ],
    },
  ],
};

const PICKING_ROW = {
  picking_order_id: 'po1',
  picking_order_ref: 'PO-001',
  picking_order_status: 'picking',
  picking_order_ship_to: 'Berlin',
  picking_item_id: 'pi1',
  required_qty: 5,
  picked_qty: 1,
  scanned_qty: 2,
  boxed_qty: 1,
  part_id: 'p1',
  part_no: 'PN-1',
  shelf_code: 'A1',
  box_id: null,
  date_code: 'D1',
  lot_code: 'L1',
  coo: 'CN',
  cow: null,
  allocated_qty: 4,
  allocation_id: 'al1',
};

const PICKING_BUNDLE = {
  rows: [PICKING_ROW],
  packages_by_item: {
    pi1: [
      {
        id: 'pkg1',
        picking_item_id: 'pi1',
        qty: 2,
        shipping_box_id: null,
        date_code: 'D1',
        lot_code: 'L1',
        coo: 'CN',
        cow: null,
        verified: 0,
        created_at: '2026-07-03T00:00:00.000Z',
      },
    ],
  },
  boxes_by_order: {
    po1: [{ id: 'box1', picking_order_id: 'po1', status: 'open' }],
  },
  // Keyed by picking ORDER id — the web indexes logs by picking ITEM id, so
  // this must be ignored in favour of the per-item POST below.
  transition_logs: {
    po1: [
      {
        id: 'tl-order',
        entity_id: 'po1',
        from_status: null,
        to_status: 'picking',
        note: null,
        created_at: '2026-07-04T00:00:00.000Z',
        actor_name: null,
      },
    ],
  },
};

const ITEM_LOGS = {
  logs: [
    {
      id: 'tl1',
      entity_type: 'picking_item',
      entity_id: 'pi1',
      from_status: null,
      to_status: 'picking',
      note: 'started',
      created_at: '2026-07-04T00:00:00.000Z',
      actor_name: 'Operator One',
    },
    {
      id: 'tl2',
      entity_type: 'picking_item',
      entity_id: 'pi2',
      from_status: 'picking',
      to_status: 'finished',
      note: null,
      created_at: '2026-07-05T00:00:00.000Z',
      actor_name: null,
    },
  ],
};

describe('createApiWarehouseService (receiving)', () => {
  const fetchMock = vi.fn();

  function createService(): WarehouseService {
    return createApiWarehouseService({
      adapter: 'api',
      apiBaseUrl: 'http://api.test',
      getActorId: () => ACTOR_ID,
    });
  }

  function routeFetch(routes: Record<string, unknown>): void {
    fetchMock.mockImplementation((url: string) => {
      for (const [path, data] of Object.entries(routes)) {
        if (url === `http://api.test${path}`) {
          return Promise.resolve(jsonResponse(data));
        }
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
  }

  function lastBody(): unknown {
    const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] ?? [];
    return init?.body ? JSON.parse(String(init.body)) : undefined;
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getReceivingOrders', () => {
    const LIST_ROWS = [
      {
        id: 'ro1',
        ref_no: 'RO-001',
        status: 'pending',
        delivery_date: '2026-07-05',
        supplier_name: 'Supplier One',
        remaining_items: 3,
        pending_picking_orders: 1,
      },
      {
        id: 'ro2',
        ref_no: 'RO-002',
        status: 'clear',
        delivery_date: null,
        supplier_name: null,
        remaining_items: 0,
        pending_picking_orders: 0,
      },
    ];

    it('requests without status for "all" and maps rows', async () => {
      fetchMock.mockResolvedValue(jsonResponse(LIST_ROWS));
      const rows = await createService().getReceivingOrders('all');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/receiving-orders',
        expect.objectContaining({ method: 'GET' })
      );
      expect(rows).toEqual([
        {
          id: 'ro1',
          refNo: 'RO-001',
          status: 'pending',
          deliveryDate: '2026-07-05',
          supplierName: 'Supplier One',
          remainingItems: 3,
          pendingPickingOrders: 1,
        },
        {
          id: 'ro2',
          refNo: 'RO-002',
          status: 'clear',
          deliveryDate: null,
          supplierName: null,
          remainingItems: 0,
          pendingPickingOrders: 0,
        },
      ]);
    });

    it('passes a non-"all" filter as the status query param', async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));
      await createService().getReceivingOrders('in_hand');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/receiving-orders?status=in_hand',
        expect.objectContaining({ method: 'GET' })
      );
    });
  });

  describe('getReceivingOrder', () => {
    it('composes order + picking bundles with an item-logs POST and maps everything', async () => {
      routeFetch({
        '/receiving-orders/ro1': ORDER_BUNDLE,
        '/receiving-orders/ro1/picking': PICKING_BUNDLE,
        '/picking-items/transition-logs': ITEM_LOGS,
      });

      const detail = await createService().getReceivingOrder('ro1');

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        'http://api.test/picking-items/transition-logs',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ ids: ['pi1'] }),
        })
      );

      expect(detail.id).toBe('ro1');
      expect(detail.refNo).toBe('RO-001');
      expect(detail.status).toBe('in_hand');
      expect(detail.deliveryDate).toEqual(new Date('2026-07-01T00:00:00.000Z'));
      expect(detail.supplier).toEqual({
        id: 's1',
        code: 'SUP',
        name: 'Supplier One',
        qrcodeTemplate: 'tpl',
        qrcodeQtyEncoding: 'enc',
      });
      expect(detail.remainingItems).toBe(2);
      expect(detail.allocatedByItem).toEqual({ rii1: 5 });

      expect(detail.invoices).toHaveLength(1);
      const invoice = detail.invoices[0];
      expect(invoice.id).toBe('inv1');
      expect(invoice.receivingOrderId).toBe('ro1');
      expect(invoice.invoiceNo).toBe('INV-1');
      expect(invoice.supplierId).toBe('s1');

      const item = invoice.items[0];
      expect(item).toMatchObject({
        id: 'rii1',
        receivingInvoiceId: 'inv1',
        partId: 'p1',
        poNo: null,
        poLine: null,
        qty: 10,
        receivedQty: 10,
        pickedQty: 3,
        putAwayQty: 2,
        boxId: null,
        dateCode: 'D1',
        lotCode: 'L1',
        coo: 'CN',
        cow: null,
      });
      expect(item.part).toEqual({
        id: 'p1',
        partNo: 'PN-1',
        internalCode: null,
        description: 'Part one',
        defaultCoo: null,
      });
      expect(item.mismatch).toMatchObject({
        id: 'mm1',
        receivingInvoiceItemId: 'rii1',
        reason: 'qty_mismatch',
        mismatchQty: 2,
        wrongPartNo: null,
        note: 'short',
        status: 'pending',
        effectiveReceivedQty: 8,
        previousReceivedQty: 10,
        reportedBy: 'u1',
        confirmedBy: null,
        confirmedAt: null,
        cancelledBy: null,
        cancelledAt: null,
      });
      expect(item.mismatch?.reportedAt).toEqual(new Date('2026-07-02T10:00:00.000Z'));

      expect(detail.pickingRows).toEqual([PICKING_ROW]);
      expect(detail.packagesByItem.pi1).toEqual([
        {
          id: 'pkg1',
          pickingItemId: 'pi1',
          pickingOrderId: 'po1',
          qty: 2,
          shippingBoxId: null,
          dateCode: 'D1',
          lotCode: 'L1',
          coo: 'CN',
          cow: null,
          createdAt: '2026-07-03T00:00:00.000Z',
        },
      ]);
      expect(detail.boxesByOrder.po1).toEqual([
        { id: 'box1', pickingOrderId: 'po1', status: 'open' },
      ]);

      // Logs grouped by picking ITEM id; the bundle's order-keyed
      // transition_logs must not leak in.
      expect(Object.keys(detail.transitionLogs).sort()).toEqual(['pi1', 'pi2']);
      expect(detail.transitionLogs.pi1).toEqual([
        {
          id: 'tl1',
          entityId: 'pi1',
          fromState: null,
          toState: 'picking',
          metadata: 'started',
          createdAt: new Date('2026-07-04T00:00:00.000Z'),
          actorName: 'Operator One',
        },
      ]);
    });

    it('skips the logs POST when the picking bundle has no items', async () => {
      routeFetch({
        '/receiving-orders/ro1': { ...ORDER_BUNDLE, invoices: [] },
        '/receiving-orders/ro1/picking': {
          rows: [],
          packages_by_item: {},
          boxes_by_order: {},
          transition_logs: {},
        },
      });

      const detail = await createService().getReceivingOrder('ro1');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(detail.transitionLogs).toEqual({});
      expect(detail.pickingRows).toEqual([]);
    });
  });

  describe('confirmReceivingOrderArrived', () => {
    it('posts to the confirm-arrival endpoint with no body', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 'ro1', status: 'in_hand' }));

      await expect(
        createService().confirmReceivingOrderArrived('ro1')
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/receiving-orders/ro1/confirm-arrival',
        expect.objectContaining({ method: 'POST' })
      );
      const [, init] = fetchMock.mock.calls[0];
      expect(init.body).toBeUndefined();
      expect(init.headers).toBeUndefined();
    });
  });

  describe('mismatches', () => {
    it('getActiveMismatch maps the row and null passes through', async () => {
      fetchMock.mockResolvedValue(jsonResponse(MISMATCH_ROW));
      const mismatch = await createService().getActiveMismatch('rii1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/receiving-invoice-items/rii1/mismatch',
        expect.objectContaining({ method: 'GET' })
      );
      expect(mismatch).toMatchObject({
        id: 'mm1',
        receivingInvoiceItemId: 'rii1',
        reason: 'qty_mismatch',
        effectiveReceivedQty: 8,
        previousReceivedQty: 10,
      });
      expect(mismatch?.reportedAt).toEqual(new Date('2026-07-02T10:00:00.000Z'));

      fetchMock.mockResolvedValue(jsonResponse(null));
      await expect(createService().getActiveMismatch('rii1')).resolves.toBeNull();
    });

    it('reportMismatch posts the snake_case body with actor_id', async () => {
      fetchMock.mockResolvedValue(jsonResponse(MISMATCH_ROW, 201));

      await expect(
        createService().reportMismatch('rii1', {
          reason: 'damaged',
          mismatchQty: 1,
          wrongPartNo: null,
          note: 'crushed',
        })
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/receiving-invoice-items/rii1/mismatches',
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toEqual({
        reason: 'damaged',
        mismatch_qty: 1,
        wrong_part_no: null,
        note: 'crushed',
        actor_id: ACTOR_ID,
      });
    });

    it('editMismatch patches with the same mapping', async () => {
      fetchMock.mockResolvedValue(jsonResponse(MISMATCH_ROW));

      await expect(
        createService().editMismatch('mm1', { reason: 'wrong_part' })
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/mismatches/mm1',
        expect.objectContaining({ method: 'PATCH' })
      );
      expect(lastBody()).toEqual({
        reason: 'wrong_part',
        mismatch_qty: null,
        wrong_part_no: null,
        note: null,
        actor_id: ACTOR_ID,
      });
    });

    it('confirmMismatch and cancelMismatch post actor_id only', async () => {
      fetchMock.mockResolvedValue(jsonResponse(MISMATCH_ROW));
      const service = createService();

      await expect(service.confirmMismatch('mm1')).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenLastCalledWith(
        'http://api.test/mismatches/mm1/confirm',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ actor_id: ACTOR_ID }),
        })
      );

      await expect(service.cancelMismatch('mm1')).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenLastCalledWith(
        'http://api.test/mismatches/mm1/cancel',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ actor_id: ACTOR_ID }),
        })
      );
    });
  });

  describe('getPickingOrdersByReceivingOrder', () => {
    it('returns the mapped picking rows', async () => {
      fetchMock.mockResolvedValue(jsonResponse(PICKING_BUNDLE));

      const rows = await createService().getPickingOrdersByReceivingOrder('ro1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/receiving-orders/ro1/picking',
        expect.objectContaining({ method: 'GET' })
      );
      expect(rows).toEqual([PICKING_ROW]);
    });
  });

  describe('getPickingItemTransitionLogs', () => {
    it('posts the ids and maps the flat log list', async () => {
      fetchMock.mockResolvedValue(jsonResponse(ITEM_LOGS));

      const logs = await createService().getPickingItemTransitionLogs(['pi1', 'pi2']);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/picking-items/transition-logs',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ ids: ['pi1', 'pi2'] }),
        })
      );
      expect(logs).toEqual([
        {
          id: 'tl1',
          entityId: 'pi1',
          fromState: null,
          toState: 'picking',
          metadata: 'started',
          createdAt: new Date('2026-07-04T00:00:00.000Z'),
          actorName: 'Operator One',
        },
        {
          id: 'tl2',
          entityId: 'pi2',
          fromState: 'picking',
          toState: 'finished',
          metadata: null,
          createdAt: new Date('2026-07-05T00:00:00.000Z'),
          actorName: null,
        },
      ]);
    });

    it('returns an empty list without fetching when ids are empty', async () => {
      const logs = await createService().getPickingItemTransitionLogs([]);

      expect(logs).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

const PICKING_LIST_ROWS = [
  {
    id: 'po1',
    ref_no: 'PO-001',
    status: 'picking',
    ship_to: 'Berlin',
    total_qty: 9,
  },
  {
    id: 'po2',
    ref_no: 'PO-002',
    status: 'finished',
    ship_to: null,
    total_qty: 0,
  },
];

const PICKING_ORDER_BUNDLE = {
  order: {
    id: 'po1',
    external_id: 'ext-1',
    ref_no: 'PO-001',
    status: 'picking',
    ship_to: 'Berlin',
    destination_country: 'DE',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-06T00:00:00.000Z',
    issue_reason: 'insufficient_stock',
    issue_note: 'short on shelf',
    issue_qty: 3,
    issue_pack_size: null,
    issue_remark: 'check A1',
    issue_reported_at: '2026-07-06T08:00:00.000Z',
    issue_reported_by: 'u9',
    issue_reported_by_name: 'Operator Nine',
  },
  measuring_task: { id: 'mt1', status: 'pending' },
  items: [
    {
      id: 'pi1',
      part_id: 'p1',
      part_no: 'PN-1',
      qty: 5,
      picked_qty: 1,
      scanned_not_boxed_qty: 0,
      remaining_qty: 4,
      allocated_qty: 4,
      line_id: 'L1',
      required_date_code: 'D-req',
      source_shelf_code: 'A1',
    },
  ],
  allocations: [
    {
      id: 'al1',
      picking_item_id: 'pi1',
      qty: 4,
      remark: 'alloc note',
      inventory_lot_id: 'lot1',
      receiving_order_id: 'ro1',
      receiving_order_ref_no: 'RO-001',
      lot: {
        id: 'lot1',
        part_id: 'p1',
        shelf_code: 'A1',
        box_id: null,
        date_code: 'D1',
        lot_code: 'LOT1',
        coo: 'CN',
        cow: null,
        date_code_norm: 'd1',
        lot_code_norm: 'lot1',
        coo_norm: 'cn',
        cow_norm: null,
      },
      receiving_items: [
        {
          receiving_invoice_item_id: 'rii1',
          qty: 4,
          invoice_no: 'INV-1',
          box_id: null,
          date_code_norm: 'd1',
          lot_code_norm: 'lot1',
          coo_norm: 'cn',
          cow_norm: null,
        },
      ],
    },
  ],
  packages: [
    {
      id: 'pkg1',
      picking_item_id: 'pi1',
      source_type: 'scan',
      source_id: null,
      qty: 1,
      shipping_box_id: 'box1',
      date_code: 'D1',
      lot_code: 'LOT1',
      coo: 'CN',
      cow: null,
      verified: 0,
      created_at: '2026-07-03T00:00:00.000Z',
    },
  ],
  boxes: [
    {
      id: 'box1',
      status: 'open',
      box_size: null,
      net_weight_g: null,
      gross_weight_g: null,
      destination_country: null,
      created_at: '2026-07-02T00:00:00.000Z',
      updated_at: '2026-07-02T00:00:00.000Z',
    },
  ],
};

const PLAIN_ORDER_BUNDLE = {
  order: {
    id: 'po2',
    ref_no: 'PO-002',
    status: 'pending',
    ship_to: null,
    destination_country: null,
    issue_reason: null,
    issue_note: null,
    issue_qty: null,
    issue_pack_size: null,
    issue_remark: null,
    issue_reported_at: null,
    issue_reported_by: null,
    issue_reported_by_name: null,
  },
  measuring_task: null,
  items: [],
  allocations: [],
  packages: [],
  boxes: [],
};

describe('createApiWarehouseService (picking)', () => {
  const fetchMock = vi.fn();

  function createService(): WarehouseService {
    return createApiWarehouseService({
      adapter: 'api',
      apiBaseUrl: 'http://api.test',
      getActorId: () => ACTOR_ID,
    });
  }

  function routeFetch(routes: Record<string, unknown>): void {
    fetchMock.mockImplementation((url: string) => {
      for (const [path, data] of Object.entries(routes)) {
        if (url === `http://api.test${path}`) {
          return Promise.resolve(jsonResponse(data));
        }
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
  }

  function lastBody(): unknown {
    const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] ?? [];
    return init?.body ? JSON.parse(String(init.body)) : undefined;
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getPickingOrders', () => {
    it('gets the list and maps rows (supplierName/deliveryDate are API gaps)', async () => {
      fetchMock.mockResolvedValue(jsonResponse(PICKING_LIST_ROWS));

      const rows = await createService().getPickingOrders();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/picking-orders',
        expect.objectContaining({ method: 'GET' })
      );
      expect(rows).toEqual([
        {
          id: 'po1',
          refNo: 'PO-001',
          status: 'picking',
          deliveryDate: null,
          supplierName: null,
          shipTo: 'Berlin',
          totalQty: 9,
        },
        {
          id: 'po2',
          refNo: 'PO-002',
          status: 'finished',
          deliveryDate: null,
          supplierName: null,
          shipTo: null,
          totalQty: 0,
        },
      ]);
    });
  });

  describe('getPickingOrder', () => {
    it('maps the composed bundle into the detail shape', async () => {
      fetchMock.mockResolvedValue(jsonResponse(PICKING_ORDER_BUNDLE));

      const detail = await createService().getPickingOrder('po1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/picking-orders/po1',
        expect.objectContaining({ method: 'GET' })
      );

      expect(detail.id).toBe('po1');
      expect(detail.refNo).toBe('PO-001');
      expect(detail.status).toBe('picking');
      expect(detail.shipTo).toBe('Berlin');
      expect(detail.destinationCountry).toBe('DE');
      // API bundle gaps: no delivery_date/supplier/po_no/date-code notice.
      expect(detail.deliveryDate).toBeNull();
      expect(detail.supplier).toBeNull();
      expect(detail.poNo).toBeNull();
      expect(detail.requiredDateCodeNotice).toBeNull();

      expect(detail.issueReason).toBe('insufficient_stock');
      expect(detail.issueQty).toBe(3);
      expect(detail.issuePackSize).toBeNull();
      expect(detail.issueNote).toBe('short on shelf');
      expect(detail.issueRemark).toBe('check A1');
      expect(detail.issueReportedAt).toEqual(new Date('2026-07-06T08:00:00.000Z'));
      expect(detail.issueReportedBy).toBe('u9');
      expect(detail.issueReportedByUser).toEqual({ displayName: 'Operator Nine' });

      expect(detail.measuringTask).toEqual({ id: 'mt1', status: 'pending' });

      expect(detail.items).toHaveLength(1);
      const item = detail.items[0];
      expect(item).toMatchObject({
        id: 'pi1',
        pickingOrderId: 'po1',
        partId: 'p1',
        qty: 5,
        pickedQty: 1,
        allocatedQty: 4,
        requiredDateCode: 'D-req',
        sourceShelfCode: 'A1',
      });
      expect(item.part).toEqual({
        id: 'p1',
        partNo: 'PN-1',
        internalCode: null,
        description: null,
        defaultCoo: null,
      });

      expect(item.allocations).toHaveLength(1);
      expect(item.allocations[0]).toEqual({
        id: 'al1',
        pickingItemId: 'pi1',
        qty: 4,
        remark: 'alloc note',
        inventoryLot: {
          id: 'lot1',
          partId: 'p1',
          dateCode: 'D1',
          lotCode: 'LOT1',
          coo: 'CN',
          cow: null,
          shelfCode: 'A1',
          boxId: null,
        },
        receivingOrder: { id: 'ro1', refNo: 'RO-001' },
        pickingItem: {
          id: 'pi1',
          part: {
            id: 'p1',
            partNo: 'PN-1',
            internalCode: null,
            description: null,
            defaultCoo: null,
          },
        },
      });

      const expectedPackage = {
        id: 'pkg1',
        pickingItemId: 'pi1',
        pickingOrderId: 'po1',
        qty: 1,
        shippingBoxId: 'box1',
        dateCode: 'D1',
        lotCode: 'LOT1',
        coo: 'CN',
        cow: null,
        createdAt: new Date('2026-07-03T00:00:00.000Z'),
      };
      expect(item.packages).toEqual([expectedPackage]);

      expect(detail.shippingBoxes).toEqual([
        {
          id: 'box1',
          pickingOrderId: 'po1',
          status: 'open',
          packages: [expectedPackage],
        },
      ]);
    });

    it('maps the null cases on a plain order', async () => {
      fetchMock.mockResolvedValue(jsonResponse(PLAIN_ORDER_BUNDLE));

      const detail = await createService().getPickingOrder('po2');

      expect(detail.measuringTask).toBeNull();
      expect(detail.issueReason).toBeNull();
      expect(detail.issueReportedAt).toBeNull();
      expect(detail.issueReportedBy).toBeNull();
      expect(detail.issueReportedByUser).toBeNull();
      expect(detail.items).toEqual([]);
      expect(detail.shippingBoxes).toEqual([]);
    });
  });

  describe('scanAllocation', () => {
    it('posts qty + actor_id and returns the first package id', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ package_ids: ['pkg9', 'pkg10'] }));

      const packageId = await createService().scanAllocation('al1', 2);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/allocations/al1/scan',
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toEqual({ qty: 2, actor_id: ACTOR_ID });
      expect(packageId).toBe('pkg9');
    });

    it('returns an empty string when no package ids come back', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ package_ids: [] }));

      await expect(createService().scanAllocation('al1', 1)).resolves.toBe('');
    });
  });

  describe('applyOcrPick', () => {
    it('posts to the picking-orders ocr-pick route with the receiving order id', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ package_ids: ['pkg1'] }));

      await expect(
        createService().applyOcrPick({
          receivingOrderId: 'ro1',
          pickingItemId: 'pi1',
          qty: 5,
          dateCode: 'D1',
          lotCode: 'L1',
          coo: 'CN',
          cow: null,
        })
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/picking-orders/ro1/ocr-pick',
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toEqual({
        picking_item_id: 'pi1',
        qty: 5,
        date_code: 'D1',
        lot_code: 'L1',
        coo: 'CN',
        cow: null,
        actor_id: ACTOR_ID,
      });
    });
  });

  describe('box/package mutations', () => {
    it('addPackageToBox posts {box_id, actor_id}', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

      await expect(
        createService().addPackageToBox('pkg1', 'box1')
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/packages/pkg1/add-to-box',
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toEqual({ box_id: 'box1', actor_id: ACTOR_ID });
    });

    it('removePackageFromBox and removeScannedPackage both DELETE with actor_id query', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const service = createService();

      await expect(service.removePackageFromBox('pkg1')).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenLastCalledWith(
        `http://api.test/packages/pkg1?actor_id=${ACTOR_ID}`,
        expect.objectContaining({ method: 'DELETE' })
      );

      await expect(service.removeScannedPackage('pkg2')).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenLastCalledWith(
        `http://api.test/packages/pkg2?actor_id=${ACTOR_ID}`,
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('createShippingBoxForPickingOrder posts actor_id to the boxes route', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 'box2' }, 201));

      await expect(
        createService().createShippingBoxForPickingOrder('po1')
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/picking-orders/po1/boxes',
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toEqual({ actor_id: ACTOR_ID });
    });

    it('addAllUnboxedPackagesToBox resolves the order via the box then posts', async () => {
      routeFetch({
        '/shipping-boxes/box1/for-measuring': {
          box: { id: 'box1', picking_order_id: 'po1', status: 'open' },
          order: { id: 'po1' },
          task: null,
          packages: [],
        },
        [`/picking-orders/po1/boxes/box1/add-all-unboxed?actor_id=${ACTOR_ID}`]: {
          packed: 3,
        },
      });

      const packed = await createService().addAllUnboxedPackagesToBox('box1');

      expect(packed).toBe(3);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'http://api.test/shipping-boxes/box1/for-measuring',
        expect.objectContaining({ method: 'GET' })
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        `http://api.test/picking-orders/po1/boxes/box1/add-all-unboxed?actor_id=${ACTOR_ID}`,
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toBeUndefined();
    });

    it('cancelShippingBox posts with actor_id in the query and no body', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

      await expect(createService().cancelShippingBox('box1')).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        `http://api.test/shipping-boxes/box1/cancel?actor_id=${ACTOR_ID}`,
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toBeUndefined();
    });

    it('finishPickingOrder posts with actor_id in the query and no body', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

      await expect(createService().finishPickingOrder('po1')).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        `http://api.test/picking-orders/po1/finish?actor_id=${ACTOR_ID}`,
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toBeUndefined();
    });
  });

  describe('reportPickingOrderIssues', () => {
    it('posts picking_order_ids with a collapsed remark and maps id arrays to counts', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ reported: ['po1'], skipped: ['po2'] })
      );

      const result = await createService().reportPickingOrderIssues(
        [
          { orderId: 'po1', remark: 'short stock' },
          { orderId: 'po2', remark: null },
        ],
        { reason: 'insufficient_stock', qty: 3, packSize: null, note: 'ignored' }
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/picking-orders/report-issues',
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toEqual({
        picking_order_ids: ['po1', 'po2'],
        reason: 'insufficient_stock',
        qty: 3,
        pack_size: null,
        remark: 'short stock',
        actor_id: ACTOR_ID,
      });
      expect(result).toEqual({ reported: 1, skipped: 1 });
    });

    it('sends a null remark when no entry has one', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ reported: [], skipped: [] }));

      await createService().reportPickingOrderIssues(
        [{ orderId: 'po1' }],
        { reason: 'other' }
      );

      expect(lastBody()).toEqual({
        picking_order_ids: ['po1'],
        reason: 'other',
        qty: null,
        pack_size: null,
        remark: null,
        actor_id: ACTOR_ID,
      });
    });
  });
});

const CANDIDATE_ROW = {
  id: 'ro1',
  ref_no: 'RO-001',
  status: 'in_hand',
  supplier_name: 'Supplier One',
  available_qty: 10,
  unboxed_qty: 3,
};

const LOT_ROW = {
  receiving_invoice_item_id: 'rii1',
  part_id: 'p1',
  part_no: 'PN-1',
  date_code: 'D1',
  lot_code: 'L1',
  coo: 'CN',
  cow: null,
  total_qty: 10,
  available_qty: 6,
  scanned_qty: 7,
  boxed_qty: 4,
};

const SCAN_ROW = {
  id: 'pas1',
  receiving_invoice_item_id: 'rii1',
  part_id: 'p1',
  qty: 4,
  date_code: 'D1',
  lot_code: 'L1',
  coo: 'CN',
  cow: null,
  shelf_box_id: 'sbox1',
  verified: 1,
  verified_at: '2026-07-03T00:00:00.000Z',
  created_at: '2026-07-02T00:00:00.000Z',
  updated_at: '2026-07-03T00:00:00.000Z',
};

// Full row shape returned by POST /put-away/scans (post-3a): the table has no
// part_id column, and a fresh scan is unboxed/unverified.
const CREATED_SCAN_ROW = {
  id: 'pas9',
  receiving_invoice_item_id: 'rii1',
  qty: 2,
  shelf_box_id: null,
  date_code: null,
  lot_code: null,
  coo: null,
  cow: null,
  verified: 0,
  verified_at: null,
  created_at: '2026-07-06T00:00:00.000Z',
  updated_at: '2026-07-06T00:00:00.000Z',
};

const SHELF_BOX_ROW = {
  id: 'sbox1',
  receiving_order_id: 'ro1',
  shelf_code: 'A1',
  status: 'open',
  created_at: '2026-07-02T00:00:00.000Z',
  updated_at: '2026-07-02T00:00:00.000Z',
  items: [
    { part_id: 'p1', part_no: 'PN-1', qty: 4, verified: 1 },
    { part_id: 'p2', part_no: 'PN-2', qty: 6, verified: 0 },
  ],
};

describe('createApiWarehouseService (put-away + shelves)', () => {
  const fetchMock = vi.fn();

  function createService(): WarehouseService {
    return createApiWarehouseService({
      adapter: 'api',
      apiBaseUrl: 'http://api.test',
      getActorId: () => ACTOR_ID,
    });
  }

  function lastBody(): unknown {
    const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] ?? [];
    return init?.body ? JSON.parse(String(init.body)) : undefined;
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getPutAwayCandidates', () => {
    it('gets the candidates and maps rows (unboxed_qty is dropped)', async () => {
      fetchMock.mockResolvedValue(jsonResponse([CANDIDATE_ROW]));

      const rows = await createService().getPutAwayCandidates();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/put-away/candidates',
        expect.objectContaining({ method: 'GET' })
      );
      expect(rows).toEqual([
        {
          id: 'ro1',
          refNo: 'RO-001',
          status: 'in_hand',
          supplierName: 'Supplier One',
          availableQty: 10,
        },
      ]);
    });
  });

  describe('getPutAwayLots', () => {
    it('gets the lots for a receiving order and maps rows', async () => {
      fetchMock.mockResolvedValue(jsonResponse([LOT_ROW]));

      const rows = await createService().getPutAwayLots('ro1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/receiving-orders/ro1/put-away-lots',
        expect.objectContaining({ method: 'GET' })
      );
      expect(rows).toEqual([
        {
          receivingInvoiceItemId: 'rii1',
          partId: 'p1',
          partNo: 'PN-1',
          dateCode: 'D1',
          lotCode: 'L1',
          coo: 'CN',
          cow: null,
          totalQty: 10,
          availableQty: 6,
          scannedQty: 7,
          boxedQty: 4,
        },
      ]);
    });
  });

  describe('getPutAwayScans', () => {
    it('maps scans with integer verified flags and date columns', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse([SCAN_ROW, { ...SCAN_ROW, id: 'pas2', shelf_box_id: null, verified: 0, verified_at: null }])
      );

      const rows = await createService().getPutAwayScans('ro1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/receiving-orders/ro1/put-away-scans',
        expect.objectContaining({ method: 'GET' })
      );
      expect(rows).toEqual([
        {
          id: 'pas1',
          receivingInvoiceItemId: 'rii1',
          partId: 'p1',
          qty: 4,
          dateCode: 'D1',
          lotCode: 'L1',
          coo: 'CN',
          cow: null,
          shelfBoxId: 'sbox1',
          verified: true,
          verifiedAt: new Date('2026-07-03T00:00:00.000Z'),
          createdAt: new Date('2026-07-02T00:00:00.000Z'),
        },
        {
          id: 'pas2',
          receivingInvoiceItemId: 'rii1',
          partId: 'p1',
          qty: 4,
          dateCode: 'D1',
          lotCode: 'L1',
          coo: 'CN',
          cow: null,
          shelfBoxId: null,
          verified: false,
          verifiedAt: null,
          createdAt: new Date('2026-07-02T00:00:00.000Z'),
        },
      ]);
    });
  });

  describe('getShelfBoxesForReceivingOrder', () => {
    it('maps boxes with their grouped items (part_id doubles as item id)', async () => {
      fetchMock.mockResolvedValue(jsonResponse([SHELF_BOX_ROW]));

      const boxes = await createService().getShelfBoxesForReceivingOrder('ro1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/receiving-orders/ro1/shelf-boxes',
        expect.objectContaining({ method: 'GET' })
      );
      expect(boxes).toEqual([
        {
          id: 'sbox1',
          receivingOrderId: 'ro1',
          shelfCode: 'A1',
          status: 'open',
          createdAt: new Date('2026-07-02T00:00:00.000Z'),
          items: [
            { id: 'p1', partId: 'p1', part: { partNo: 'PN-1' }, qty: 4, verified: true },
            { id: 'p2', partId: 'p2', part: { partNo: 'PN-2' }, qty: 6, verified: false },
          ],
        },
      ]);
    });
  });

  describe('getShelves', () => {
    it('gets shelves; zone is null (API shelves table has no zone column)', async () => {
      fetchMock.mockResolvedValue(jsonResponse([{ code: 'A1' }, { code: 'B2' }]));

      const shelves = await createService().getShelves();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/shelves',
        expect.objectContaining({ method: 'GET' })
      );
      expect(shelves).toEqual([
        { code: 'A1', zone: null },
        { code: 'B2', zone: null },
      ]);
    });
  });

  describe('recordPutAwayScan', () => {
    it('posts the snake_case body (no actor_id) and maps the full scan row', async () => {
      fetchMock.mockResolvedValue(jsonResponse(CREATED_SCAN_ROW, 201));

      const scan = await createService().recordPutAwayScan(
        'rii1', 2, null, null, null, null
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/put-away/scans',
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toEqual({
        receiving_invoice_item_id: 'rii1',
        qty: 2,
        date_code: null,
        lot_code: null,
        coo: null,
        cow: null,
      });
      expect(scan).toEqual({
        id: 'pas9',
        receivingInvoiceItemId: 'rii1',
        // API full-row gap: put_away_scans has no part_id column.
        partId: '',
        qty: 2,
        dateCode: null,
        lotCode: null,
        coo: null,
        cow: null,
        shelfBoxId: null,
        verified: false,
        verifiedAt: null,
        createdAt: new Date('2026-07-06T00:00:00.000Z'),
      });
    });
  });

  describe('createShelfBox', () => {
    it('posts {shelf_code, actor_id} and maps the full box row', async () => {
      const created = { ...SHELF_BOX_ROW, id: 'SBOX-0001' };
      delete (created as Record<string, unknown>).items;
      fetchMock.mockResolvedValue(jsonResponse(created, 201));

      const box = await createService().createShelfBox('ro1', 'A1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/receiving-orders/ro1/shelf-boxes',
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toEqual({ shelf_code: 'A1', actor_id: ACTOR_ID });
      expect(box).toEqual({
        id: 'SBOX-0001',
        receivingOrderId: 'ro1',
        shelfCode: 'A1',
        status: 'open',
        createdAt: new Date('2026-07-02T00:00:00.000Z'),
        items: [],
      });
    });
  });

  describe('scan/box mutations', () => {
    it('assignPutAwayScanToBox posts {shelf_box_id, actor_id}', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

      await expect(
        createService().assignPutAwayScanToBox('pas1', 'sbox1')
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/put-away/scans/pas1/assign-to-box',
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toEqual({ shelf_box_id: 'sbox1', actor_id: ACTOR_ID });
    });

    it('addAllUnboxedScansToBox posts with actor_id query and returns the count', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ count: 3 }));

      const count = await createService().addAllUnboxedScansToBox('sbox1');

      expect(fetchMock).toHaveBeenCalledWith(
        `http://api.test/shelf-boxes/sbox1/add-all-unboxed?actor_id=${ACTOR_ID}`,
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toBeUndefined();
      expect(count).toBe(3);
    });

    it('removePutAwayScanFromBox posts with actor_id query and no body', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

      await expect(
        createService().removePutAwayScanFromBox('pas1')
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        `http://api.test/put-away/scans/pas1/remove-from-box?actor_id=${ACTOR_ID}`,
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toBeUndefined();
    });

    it('removePutAwayScannedPiece posts with no actor and no body', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

      await expect(
        createService().removePutAwayScannedPiece('pas1')
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/put-away/scans/pas1/remove-piece',
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toBeUndefined();
    });

    it('closeShelfBox posts with actor_id query and no body', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

      await expect(createService().closeShelfBox('sbox1')).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        `http://api.test/shelf-boxes/sbox1/close?actor_id=${ACTOR_ID}`,
        expect.objectContaining({ method: 'POST' })
      );
      expect(lastBody()).toBeUndefined();
    });

    it('cancelShelfBox DELETEs with actor_id query', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

      await expect(createService().cancelShelfBox('sbox1')).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        `http://api.test/shelf-boxes/sbox1?actor_id=${ACTOR_ID}`,
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(lastBody()).toBeUndefined();
    });
  });
});
