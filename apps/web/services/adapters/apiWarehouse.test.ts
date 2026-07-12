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
