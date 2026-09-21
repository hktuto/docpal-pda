// Shipper data assembly (spec
// docs/superpowers/specs/2026-09-21-admin-excel-export-renderer-separation-design.md):
// queries + grouping/merging moved verbatim from
// src/routes/admin/receivingShipper.ts. Behavior specs:
// docs/superpowers/specs/2026-09-14-admin-receiving-shipper-download-design.md
// + 2026-09-16-admin-receiving-shipper-related-allocated-design.md
// (supersedes 2026-09-07-admin-receiving-picking-list-design.md).
// Two modes (both read-only — re-allocation lives on
// POST /admin/receiving-orders/:id/reallocate):
//   default (?mode omitted): LIVE shipper for an in-hand order — slots come
//     from the current `allocations` table.
//   ?mode=finished: for a completed (`clear`) order — same layout, but slots
//     come from `picking_packages` (what was actually packed), because live
//     allocations are consumed/emptied once picking finishes.
// Split by location (spec
// docs/superpowers/specs/2026-09-21-shipper-split-by-location-design.md):
// loadShipperDocuments returns one ShipperDocument per receiving-office
// (org_id, sub_inventory_code) section of the order's items; slot attribution
// for whole-order/package/related slots uses the picking order's pair.

import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { AppDb } from "../../db.js";
import { queryAll, queryGet } from "../../db/query.js";
import type { ShipperDocument, ShipperGroup, ShipperSlot } from "./model.js";

interface OrderHeadRow {
  batchNo: string;
  status: string;
  deliveryDate: Date | null;
  supplierCode: string | null;
  supplierName: string | null;
  totalCtn: number | null;
}

interface ItemRow {
  id: string;
  invoiceNo: string;
  drawingNo: string | null;
  poNo: string | null;
  poLine: string | null;
  partKey: string;
  partNo: string;
  wclItemNo: string | null;
  ctnNo: string | null;
  receivedQty: number;
  orgId: number | null;
  subInventoryCode: string | null;
}

interface AllocRow {
  itemId: string | null;
  demandPartNo: string | null;
  partKey: string | null;
  orderId: string;
  orderNo: string;
  poNo: string | null;
  prioritySeq: number;
  customerCode: string | null;
  customerLabel: string | null;
  qty: number;
  // Picking order's stock partition — only selected where section attribution
  // needs it (whole-order / package slots); absent on item-level rows.
  orgId?: number | null;
  subInventoryCode?: string | null;
}

interface RelatedAllocRow {
  demandPartNo: string;
  qty: number;
  orgId: number | null;
  subInventoryCode: string | null;
}

function ymd(d: Date | null): string {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

interface ShipperData {
  head: OrderHeadRow;
  items: ItemRow[];
  itemAllocs: AllocRow[];
  orderAllocs: AllocRow[];
  packageAllocs: AllocRow[];
  relatedAllocs: RelatedAllocRow[];
}

async function loadShipperData(db: AppDb, id: string, finished: boolean): Promise<ShipperData> {
  const head = await queryGet<OrderHeadRow>(
    db,
    sql`
      SELECT
        ro.batch_no AS "batchNo",
        ro.status,
        ro.delivery_date AS "deliveryDate",
        ro.supplier_code AS "supplierCode",
        s.name AS "supplierName",
        (SELECT SUM(ri.total_ctn)::int FROM receiving_invoices ri WHERE ri.receiving_order_id = ro.id) AS "totalCtn"
      FROM receiving_orders ro
      LEFT JOIN suppliers s ON s.code = ro.supplier_code
      WHERE ro.id = ${id}
    `
  );
  if (!head) throw new HTTPException(404, { message: "receiving_order_not_found" });

  const items = await queryAll<ItemRow>(
    db,
    sql`
      SELECT
        rii.id,
        ri.invoice_no AS "invoiceNo",
        rii.additional_data->>'drawing_no' AS "drawingNo",
        rii.po_no AS "poNo",
        rii.po_line AS "poLine",
        COALESCE(rii.wcl_item_no, rii.part_no) AS "partKey",
        rii.part_no AS "partNo",
        rii.wcl_item_no AS "wclItemNo",
        rii.ctn_no AS "ctnNo",
        rii.received_qty AS "receivedQty",
        rii.org_id AS "orgId",
        rii.sub_inventory_code AS "subInventoryCode"
      FROM receiving_invoice_items rii
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      WHERE ri.receiving_order_id = ${id}
      ORDER BY COALESCE(rii.wcl_item_no, rii.part_no), rii.po_no, rii.po_line, rii.ctn_no, rii.id
    `
  );

  // Slot sources differ by mode:
  //   live     → itemAllocs (per-carton) + orderAllocs (whole-order, no ctn)
  //   finished → packageAllocs (per part GROUP per order, from actual packages)
  let itemAllocs: AllocRow[] = [];
  let orderAllocs: AllocRow[] = [];
  let packageAllocs: AllocRow[] = [];
  let relatedAllocs: RelatedAllocRow[] = [];

  if (finished) {
    // Actual picked qtys traced back to this order's invoice items:
    //   - direct dock picks: pp.source_type='receiving_invoice_item'
    //   - put-away picks: pp.source_type='inventory_lot' via
    //     inventory_lot_sources. A lot maps to ONE part key here
    //     (MIN over its sources from this order) so multi-source lots never
    //     double-count a package; cross-part-key lots land on one key.
    packageAllocs = await queryAll<AllocRow>(
      db,
      sql`
        WITH src AS (
          SELECT
            COALESCE(dir."partKey", lotsrc."partKey") AS "partKey",
            pp.id AS package_id, pp.qty, pp.picking_item_id
          FROM picking_packages pp
          LEFT JOIN (
            SELECT rii.id AS item_id, COALESCE(rii.wcl_item_no, rii.part_no) AS "partKey"
            FROM receiving_invoice_items rii
            JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
            WHERE ri.receiving_order_id = ${id}
          ) dir ON pp.source_type = 'receiving_invoice_item' AND pp.source_id = dir.item_id
          LEFT JOIN (
            SELECT ils.inventory_lot_id AS lot_id,
                   MIN(COALESCE(rii.wcl_item_no, rii.part_no)) AS "partKey"
            FROM inventory_lot_sources ils
            JOIN receiving_invoice_items rii ON rii.id = ils.receiving_invoice_item_id
            JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
            WHERE ri.receiving_order_id = ${id}
            GROUP BY ils.inventory_lot_id
          ) lotsrc ON pp.source_type = 'inventory_lot' AND pp.source_id = lotsrc.lot_id
        )
        SELECT
          NULL AS "itemId",
          NULL AS "demandPartNo",
          src."partKey",
          po.id AS "orderId", po.order_no AS "orderNo", po.po_no AS "poNo",
          po.priority_seq AS "prioritySeq",
          po.customer_code AS "customerCode", cp.label AS "customerLabel",
          po.org_id AS "orgId", po.sub_inventory_code AS "subInventoryCode",
          SUM(src.qty)::int AS qty
        FROM src
        JOIN picking_items pi ON pi.id = src.picking_item_id
        JOIN picking_orders po ON po.id = pi.picking_order_id
        LEFT JOIN customer_profiles cp ON cp.customers ? po.customer_code
        WHERE src."partKey" IS NOT NULL
        GROUP BY src."partKey", po.id, po.order_no, po.po_no, po.priority_seq, po.customer_code, cp.label, po.org_id, po.sub_inventory_code
      `
    );
  } else {
    // Item-level allocations (receiving line carries ctn_no → boxed source).
    itemAllocs = await queryAll<AllocRow>(
      db,
      sql`
        SELECT
          a.receiving_invoice_item_id AS "itemId",
          NULL AS "demandPartNo",
          NULL AS "partKey",
          po.id AS "orderId", po.order_no AS "orderNo", po.po_no AS "poNo",
          po.priority_seq AS "prioritySeq",
          po.customer_code AS "customerCode", cp.label AS "customerLabel",
          SUM(a.qty)::int AS qty
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        JOIN picking_orders po ON po.id = pi.picking_order_id
        LEFT JOIN customer_profiles cp ON cp.customers ? po.customer_code
        JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${id}
        GROUP BY a.receiving_invoice_item_id, po.id, po.order_no, po.po_no, po.priority_seq, po.customer_code, cp.label
      `
    );

    // Order-level allocations (receiving line without ctn_no → whole-order
    // source, allocate.ts:53-55). Matched back to a part group in JS via the
    // allocate.ts part-key rule (demand part_no = source part_no OR wcl_item_no).
    orderAllocs = await queryAll<AllocRow>(
      db,
      sql`
        SELECT
          NULL AS "itemId",
          pi.part_no AS "demandPartNo",
          NULL AS "partKey",
          po.id AS "orderId", po.order_no AS "orderNo", po.po_no AS "poNo",
          po.priority_seq AS "prioritySeq",
          po.customer_code AS "customerCode", cp.label AS "customerLabel",
          po.org_id AS "orgId", po.sub_inventory_code AS "subInventoryCode",
          SUM(a.qty)::int AS qty
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        JOIN picking_orders po ON po.id = pi.picking_order_id
        LEFT JOIN customer_profiles cp ON cp.customers ? po.customer_code
        WHERE a.receiving_order_id = ${id} AND a.receiving_invoice_item_id IS NULL
        GROUP BY pi.part_no, po.id, po.order_no, po.po_no, po.priority_seq, po.customer_code, cp.label, po.org_id, po.sub_inventory_code
      `
    );

    // Related-order allocated qty per demand part (spec 2026-09-16): the
    // group header cell shows how much of each part is already allocated to
    // the picking orders this receiving order feeds. Related = the order has
    // ≥1 allocation tracing back to this receiving order (item-level or
    // whole-order); the sum counts every allocation of the part on those
    // orders whatever its source (stock lot, this or another receiving
    // order). Matched back to a part group via the allocate.ts part-key rule.
    relatedAllocs = await queryAll<RelatedAllocRow>(
      db,
      sql`
        WITH related_orders AS (
          SELECT DISTINCT pi.picking_order_id AS order_id
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
          LEFT JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE a.receiving_order_id = ${id} OR ri.receiving_order_id = ${id}
        )
        SELECT pi.part_no AS "demandPartNo", SUM(a.qty)::int AS qty,
          po.org_id AS "orgId", po.sub_inventory_code AS "subInventoryCode"
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        JOIN picking_orders po ON po.id = pi.picking_order_id
        JOIN related_orders ro ON ro.order_id = pi.picking_order_id
        GROUP BY pi.part_no, po.org_id, po.sub_inventory_code
      `
    );
  }

  return { head, items, itemAllocs, orderAllocs, packageAllocs, relatedAllocs };
}

// Shipper block layout: allocation columns are PER-BLOCK slots, not a
// global column per picking order (each receipt's order set differs, so
// global columns would sprawl). Every part group prints as one block:
//   one row per carton: `invoice_no ctn_no` | part | qty
//   customer names / order_nos / per-slot qtys overlaid on the
//   block's last three rows (standalone rows above when fewer than 3)
// Slot count = the widest block's merged slot count.
function buildShipperDocument(
  head: OrderHeadRow,
  finished: boolean,
  items: ItemRow[],
  itemAllocs: AllocRow[],
  orderAllocs: AllocRow[],
  packageAllocs: AllocRow[],
  relatedAllocs: RelatedAllocRow[]
): ShipperDocument {
  interface SlotAlloc {
    customer: string; // customer name (fallback code / order_no)
    orderRef: string; // order_no (fallback po_no)
    qty: number;
    prioritySeq: number;
    orderNo: string;
  }

  function toSlot(a: AllocRow): SlotAlloc {
    return {
      customer: a.customerLabel ?? a.customerCode ?? a.orderNo,
      orderRef: a.orderNo || (a.poNo ?? ""),
      qty: a.qty,
      prioritySeq: a.prioritySeq,
      orderNo: a.orderNo,
    };
  }

  const bySlotOrder = (x: SlotAlloc, y: SlotAlloc) =>
    x.prioritySeq - y.prioritySeq || x.orderNo.localeCompare(y.orderNo);

  const allocsByItem = new Map<string, SlotAlloc[]>();
  for (const a of itemAllocs) {
    const list = allocsByItem.get(a.itemId!) ?? [];
    list.push(toSlot(a));
    allocsByItem.set(a.itemId!, list);
  }
  for (const list of allocsByItem.values()) list.sort(bySlotOrder);

  // Finished mode: actuals aggregated per part group (not pinnable to a
  // carton row once stock moved through put-away lots).
  const packageSlotsByPartKey = new Map<string, SlotAlloc[]>();
  for (const a of packageAllocs) {
    const list = packageSlotsByPartKey.get(a.partKey!) ?? [];
    list.push(toSlot(a));
    packageSlotsByPartKey.set(a.partKey!, list);
  }
  for (const list of packageSlotsByPartKey.values()) list.sort(bySlotOrder);

  // Group items by part, preserving the query's ordering.
  const groups: { partKey: string; items: ItemRow[]; orderAllocs: SlotAlloc[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.partKey === item.partKey) last.items.push(item);
    else groups.push({ partKey: item.partKey, items: [item], orderAllocs: [] });
  }
  // Whole-order (no ctn_no) allocations attach to their part group via the
  // allocate.ts part-key rule (demand part_no = source part_no OR wcl_item_no).
  for (const group of groups) {
    const byOrder = new Map<string, SlotAlloc>();
    for (const a of orderAllocs) {
      if (!group.items.some((i) => i.partNo === a.demandPartNo || i.wclItemNo === a.demandPartNo)) continue;
      const slot = byOrder.get(a.orderId);
      if (slot) slot.qty += a.qty;
      else byOrder.set(a.orderId, toSlot(a));
    }
    group.orderAllocs = [...byOrder.values()].sort(bySlotOrder);
  }

  // Related-order allocated qty per part group (same part-key rule as the
  // whole-order slot matching above). Live mode only — finished mode has no
  // group header cell.
  const relatedAllocatedByGroup = new Map<string, number>();
  for (const group of groups) {
    let sum = 0;
    for (const r of relatedAllocs) {
      if (group.items.some((i) => i.partNo === r.demandPartNo || i.wclItemNo === r.demandPartNo)) {
        sum += r.qty;
      }
    }
    relatedAllocatedByGroup.set(group.partKey, sum);
  }

  // Slot count = the widest block's slot count. Live mode: cartons of the
  // same part merge into one block, so a group's slots are the SUM of its
  // items' allocations (or the order-level slot count). Finished mode: the
  // group-level package slots.
  let slotCount = 0;
  for (const group of groups) {
    if (finished) {
      slotCount = Math.max(slotCount, packageSlotsByPartKey.get(group.partKey)?.length ?? 0);
    } else {
      slotCount = Math.max(slotCount, group.orderAllocs.length);
      let merged = 0;
      for (const item of group.items) merged += allocsByItem.get(item.id)?.length ?? 0;
      slotCount = Math.max(slotCount, merged);
    }
  }

  return {
    mode: finished ? "finished" : "live",
    head: {
      batchNo: head.batchNo,
      supplierCode: head.supplierCode,
      supplierName: head.supplierName,
      deliveryDate: ymd(head.deliveryDate),
      totalCtn: head.totalCtn,
    },
    slotCount,
    groups: groups.map((group) => {
      const totalQty = group.items.reduce((s, i) => s + i.receivedQty, 0);

      const blockItems: ShipperGroup["blockItems"] = [];
      let mergedSlots: SlotAlloc[];
      let allocatedTotal: number;

      if (finished) {
        mergedSlots = packageSlotsByPartKey.get(group.partKey) ?? [];
        allocatedTotal = mergedSlots.reduce((s, a) => s + a.qty, 0);
      } else {
        allocatedTotal =
          group.items.reduce(
            (s, i) => s + (allocsByItem.get(i.id) ?? []).reduce((t, a) => t + a.qty, 0),
            0
          ) + group.orderAllocs.reduce((s, a) => s + a.qty, 0);

        mergedSlots = [];
        for (const item of group.items) {
          mergedSlots.push(...(allocsByItem.get(item.id) ?? []));
        }
      }

      for (const item of group.items) {
        blockItems.push({
          invoiceNo: item.invoiceNo,
          drawingNo: item.drawingNo,
          ctnNo: item.ctnNo,
          qty: item.receivedQty,
        });
      }

      const slots: ShipperSlot[] = mergedSlots;
      return {
        partKey: group.partKey,
        blockItems,
        slots,
        relatedAllocated: finished ? 0 : relatedAllocatedByGroup.get(group.partKey) ?? 0,
        totalQty,
        allocatedTotal,
        orderLevel: !finished && group.orderAllocs.length > 0 ? { slots: group.orderAllocs } : null,
      };
    }),
  };
}

export async function loadShipperDocument(
  db: AppDb,
  id: string,
  { finished }: { finished: boolean }
): Promise<ShipperDocument> {
  const d = await loadShipperData(db, id, finished);
  return buildShipperDocument(
    d.head,
    finished,
    d.items,
    d.itemAllocs,
    d.orderAllocs,
    d.packageAllocs,
    d.relatedAllocs
  );
}

export interface ShipperSectionDocument {
  section: { orgId: number | null; subInventoryCode: string | null };
  doc: ShipperDocument;
}

// Split-by-location assembly (spec
// docs/superpowers/specs/2026-09-21-shipper-split-by-location-design.md):
// one document per receiving-office (org_id, sub_inventory_code) section of
// the order's items, sections ordered by orgId then subInventoryCode
// (NULLS LAST). Item-level slots follow their item; whole-order / package /
// related slots are attributed by the picking order's pair (case-insensitive
// sub-inventory compare), falling back to the section holding the slot's
// part group, first in section order.
export async function loadShipperDocuments(
  db: AppDb,
  id: string,
  { finished }: { finished: boolean }
): Promise<ShipperSectionDocument[]> {
  const d = await loadShipperData(db, id, finished);

  interface Section {
    orgId: number | null;
    subInventoryCode: string | null;
    items: ItemRow[];
  }
  const sectionByKey = new Map<string, Section>();
  for (const item of d.items) {
    const key = `${item.orgId}::${item.subInventoryCode?.toLowerCase() ?? ""}`;
    let section = sectionByKey.get(key);
    if (!section) {
      section = { orgId: item.orgId, subInventoryCode: item.subInventoryCode, items: [] };
      sectionByKey.set(key, section);
    }
    section.items.push(item);
  }
  const sections = [...sectionByKey.values()].sort(
    (a, b) =>
      (a.orgId ?? Number.MAX_SAFE_INTEGER) - (b.orgId ?? Number.MAX_SAFE_INTEGER) ||
      (a.subInventoryCode ?? "￿").localeCompare(b.subInventoryCode ?? "￿")
  );

  const pairMatches = (a: AllocRow | RelatedAllocRow, s: Section) =>
    a.orgId === s.orgId &&
    (a.subInventoryCode ?? "").toLowerCase() === (s.subInventoryCode ?? "").toLowerCase();

  // Candidate sections for a slot = those holding its part group (part-key
  // rule), in section order; the picking-order pair wins, else the first.
  function attribute(a: AllocRow | RelatedAllocRow, match: (i: ItemRow) => boolean): number | null {
    const candidates: number[] = [];
    sections.forEach((s, i) => {
      if (s.items.some(match)) candidates.push(i);
    });
    if (candidates.length === 0) return null;
    for (const i of candidates) if (pairMatches(a, sections[i]!)) return i;
    return candidates[0]!;
  }

  const perSection: {
    orderAllocs: AllocRow[];
    packageAllocs: AllocRow[];
    relatedAllocs: RelatedAllocRow[];
  }[] = sections.map(() => ({ orderAllocs: [], packageAllocs: [], relatedAllocs: [] }));

  for (const a of d.orderAllocs) {
    const i = attribute(a, (it) => it.partNo === a.demandPartNo || it.wclItemNo === a.demandPartNo);
    if (i !== null) perSection[i]!.orderAllocs.push(a);
  }
  for (const a of d.packageAllocs) {
    const i = attribute(a, (it) => it.partKey === a.partKey);
    if (i !== null) perSection[i]!.packageAllocs.push(a);
  }
  for (const r of d.relatedAllocs) {
    const i = attribute(r, (it) => it.partNo === r.demandPartNo || it.wclItemNo === r.demandPartNo);
    if (i !== null) perSection[i]!.relatedAllocs.push(r);
  }

  return sections.map((section, i) => {
    // Per-section Total Ctn: the cartons physically in this section (count of
    // distinct non-null ctn_no) — invoice-level total_ctn can't be
    // apportioned when one invoice spans sections. Carton-less sections show
    // a blank rather than a misleading 0.
    const ctns = new Set(section.items.map((it) => it.ctnNo).filter((c): c is string => c !== null));
    const head = { ...d.head, totalCtn: ctns.size > 0 ? ctns.size : null };
    return {
      section: { orgId: section.orgId, subInventoryCode: section.subInventoryCode },
      doc: buildShipperDocument(
        head,
        finished,
        section.items,
        d.itemAllocs,
        perSection[i]!.orderAllocs,
        perSection[i]!.packageAllocs,
        perSection[i]!.relatedAllocs
      ),
    };
  });
}
