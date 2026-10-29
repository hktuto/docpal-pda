// Label-print param conversion, backend-side (spec
// docs/superpowers/specs/2026-10-29-backend-label-print-conversion-design.md).
// Converters dispatch per print_template_id; templates without a registered
// converter fall back to the default superset builder keyed by label_type
// (each row is a SUPERSET of the documented template fields
// (docs/backend/print-service.md) — canvas templates bind by name and ignore
// extras. All values are strings unless boolean).

import { inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { queryAll, queryGet, type DbOrTx } from "./query.js";
import { getPickingOrderDetail, type PickingItemDetail, type PickingOrderDetail, type PickingPackageDetail } from "./picking.js";
import { resolveLabelPrintRulesForOrder, type LabelPrintRuleMatch } from "./labelPrint.js";
import { dateCodeRank } from "./dateCode.js";
import type { UserScopeEntry } from "./user-scope.js";
import { dynamicPrint } from "../print.js";
import { newId } from "./id.js";
import { labelPrints } from "./schema/index.js";
import { now } from "./now.js";

export interface LabelPrintContext {
  db: DbOrTx;
  order: PickingOrderDetail;
  match: LabelPrintRuleMatch;
}

/** A converted param row plus its print-record linkage: carton rows carry
 *  `shippingBoxId`, item/item_box rows carry `packageId`. `params` is exactly
 *  what goes upstream to the print service. */
export interface LabelPrintParamRow {
  shippingBoxId: string | null;
  packageId: string | null;
  params: Record<string, unknown>;
}

type LinkedLabelParamConverter = (ctx: LabelPrintContext) => Promise<LabelPrintParamRow[]>;

// Per-templateId overrides register here (A4 chunking, customer-specific
// payloads, DB-enriched fields).
const linkedConverters: Record<string, LinkedLabelParamConverter> = {
  "yhft-ch-01": yhftCh01Linked,
};

interface BatchFields {
  dateCode: string;
  lotCode: string;
  coo: string;
  cow: string;
}

const str = (v: string | number | null | undefined): string =>
  v === null || v === undefined ? "" : String(v);

/** Batch fields anchor to the pick-time scanned values when present, falling
 *  back to the stored source snapshot (same rule as verify re-scan matching). */
function packageBatch(pkg: PickingPackageDetail): BatchFields {
  return {
    dateCode: str(pkg.scannedDateCode ?? pkg.dateCode),
    lotCode: str(pkg.scannedLotCode ?? pkg.lotCode),
    coo: str(pkg.scannedCoo ?? pkg.coo),
    cow: str(pkg.scannedCow ?? pkg.cow),
  };
}

/** Canonical trace string for a package: `part|dateCode|lotCode|qty` with
 *  empty segments skipped. */
function packageTrace(item: PickingItemDetail, pkg: PickingPackageDetail): string {
  const batch = packageBatch(pkg);
  return [str(item.wclItemNo) || item.partNo, batch.dateCode, batch.lotCode, str(pkg.qty)]
    .filter((s) => s !== "")
    .join("|");
}

function identityFields(order: PickingOrderDetail): Record<string, string> {
  return {
    orderNo: order.orderNo,
    poNo: str(order.poNo),
    customerCode: str(order.customerCode),
    customerName: str(order.customerCode),
    shipTo: str(order.shipTo),
    invNo: str(order.poNo),
  };
}

function partFields(item: PickingItemDetail | null): Record<string, string> {
  const partNo = item?.partNo ?? "";
  const wclItemNo = str(item?.wclItemNo);
  const brand = str(item?.brand);
  return {
    partNo,
    wclItemNo,
    itemCode: wclItemNo,
    itemNum: wclItemNo,
    sku: wclItemNo || partNo,
    productCode: partNo,
    mfgPn: partNo,
    partNumber: partNo,
    ATICode: partNo,
    MFRCode: brand,
  };
}

function batchFields(batch: BatchFields): Record<string, string> {
  return {
    dateCode: batch.dateCode,
    lotCode: batch.lotCode,
    lotNo: batch.lotCode,
    coo: batch.coo,
    cow: batch.cow,
    makeIn: batch.coo,
    originCountry: batch.coo,
    productionDate: batch.dateCode,
  };
}

const EMPTY_BATCH: BatchFields = { dateCode: "", lotCode: "", coo: "", cow: "" };

/** Default builder (linked): one row per shipping box (`carton`) or one row
 *  per package across all items (`item_box` / `item`), then 1-based
 *  page/total/showTailBox over the row set. */
export function buildDefaultLinkedLabelPrintParams(
  labelType: string,
  order: PickingOrderDetail
): LabelPrintParamRow[] {
  const identity = identityFields(order);
  const rows: LabelPrintParamRow[] = [];

  if (labelType === "carton") {
    const boxes = [...order.boxes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const box of boxes) {
      const boxPkgs: { item: PickingItemDetail; pkg: PickingPackageDetail }[] = [];
      for (const item of order.items) {
        for (const pkg of item.packages) {
          if (pkg.shippingBoxId === box.id) boxPkgs.push({ item, pkg });
        }
      }
      // Single-part box: expose that part's identity/batch; mixed boxes leave
      // them empty.
      const distinctParts = new Set(boxPkgs.map(({ item }) => item.partNo));
      const single = distinctParts.size === 1 ? boxPkgs[0] : undefined;
      const totalQty = boxPkgs.reduce((sum, { pkg }) => sum + pkg.qty, 0);
      rows.push({
        shippingBoxId: box.id,
        packageId: null,
        params: {
          ...identity,
          ...partFields(single?.item ?? null),
          ...batchFields(single ? packageBatch(single.pkg) : EMPTY_BATCH),
          qty: str(totalQty),
          quantity: str(totalQty),
          serialNo: box.id,
          boxId: box.id,
          barcodeValue: box.id,
          barCode: box.id,
          extraCode: box.id,
          qrcode: box.id,
          qrPayload: box.id,
          traceCode: box.id,
          midQr: box.id,
          topQr: box.id,
        },
      });
    }
  } else {
    for (const item of order.items) {
      for (const pkg of item.packages) {
        const trace = packageTrace(item, pkg);
        rows.push({
          shippingBoxId: null,
          packageId: pkg.id,
          params: {
            ...identity,
            ...partFields(item),
            ...batchFields(packageBatch(pkg)),
            qty: str(pkg.qty),
            quantity: str(pkg.qty),
            serialNo: str(pkg.shippingBoxId),
            boxId: str(pkg.shippingBoxId),
            barcodeValue: pkg.id,
            barCode: pkg.id,
            extraCode: str(pkg.shippingBoxId),
            qrcode: trace,
            qrPayload: trace,
            traceCode: trace,
            midQr: trace,
            topQr: trace,
          },
        });
      }
    }
  }

  const total = rows.length;
  return rows.map((row, i) => ({
    ...row,
    params: {
      ...row.params,
      page: String(i + 1),
      total: String(total),
      showTailBox: true,
    },
  }));
}

export function buildDefaultLabelPrintParams(
  labelType: string,
  order: PickingOrderDetail
): Record<string, unknown>[] {
  return buildDefaultLinkedLabelPrintParams(labelType, order).map((row) => row.params);
}

/** Linked conversion: per-templateId converter when registered, otherwise the
 *  default builder keyed by label_type. */
export async function buildLinkedLabelPrintParams(ctx: LabelPrintContext): Promise<LabelPrintParamRow[]> {
  const converter = linkedConverters[ctx.match.printTemplateId];
  if (converter) return converter(ctx);
  return buildDefaultLinkedLabelPrintParams(ctx.match.labelType, ctx.order);
}

export async function buildLabelPrintParams(ctx: LabelPrintContext): Promise<Record<string, unknown>[]> {
  return (await buildLinkedLabelPrintParams(ctx)).map((row) => row.params);
}

// ---------------------------------------------------------------------------
// yhft-ch-01 (永和丰泰_长虹, SZ — 内外箱通用): per-package rows
// (item/item_box) or per-shipping-box rows (carton), supplier name looked up
// from the item's brand, composite QR payloads. Field names follow the
// template's canvas bindings (schema export yhft-ch-01).
// ---------------------------------------------------------------------------

const YHFT_COMPANY = "四川芯智热控技术有限公司";

/** Canonical YYWW → "YYYY/MM/DD" (the Monday of that ISO week — the template
 *  prints a full date, the system stores only year+week). Invalid or
 *  non-4-digit codes pass through unchanged; empty stays empty. */
function dateCodeToSlashDate(code: string): string {
  if (code === "") return "";
  const rank = dateCodeRank(code);
  if (rank === null) return code;
  const fullYear = Math.floor(rank / 100);
  const week = rank % 100;
  // ISO week 1 is the week containing Jan 4; anchor to its Monday.
  const jan4 = new Date(Date.UTC(fullYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + (week - 1) * 7);
  const m = String(monday.getUTCMonth() + 1).padStart(2, "0");
  const d = String(monday.getUTCDate()).padStart(2, "0");
  return `${monday.getUTCFullYear()}/${m}/${d}`;
}

function yhftCh01Row(
  order: PickingOrderDetail,
  item: PickingItemDetail | null,
  pkg: PickingPackageDetail | null,
  qty: number,
  drawingNo: string
): Record<string, unknown> {
  const batch = pkg ? packageBatch(pkg) : EMPTY_BATCH;
  // 物料型号 prints the WCL item no.
  const mpn = str(item?.wclItemNo) || (item?.partNo ?? "");
  const npm2 = drawingNo;
  const qtyText = `${qty} PCS`;
  const deliveryNum = order.orderNo;
  return {
    company: YHFT_COMPANY,
    // The template's 供应商名称 prints the picking order's customer.
    supplier: str(order.customerCode),
    field: "物料代码:",
    mpn,
    npm2,
    qty: qtyText,
    dateCode: dateCodeToSlashDate(batch.dateCode),
    field3: "ROHS",
    batch: batch.lotCode,
    deliveryNum,
    barcode: npm2,
    partNo: "",
    qrcode1: [npm2, batch.lotCode, deliveryNum].filter((s) => s !== "").join("|"),
    qrcode2: [mpn, qtyText].filter((s) => s !== "").join("|"),
  };
}

async function yhftCh01Linked(ctx: LabelPrintContext): Promise<LabelPrintParamRow[]> {
  const { db, order, match } = ctx;

  // Drawing number (零件图号): only inventory_lots carries drawing_no —
  // packages from other sources (or lots without one) leave npm2 blank.
  const lotIds = [
    ...new Set(
      order.items.flatMap((i) =>
        i.packages.filter((p) => p.sourceType === "inventory_lot").map((p) => p.sourceId)
      )
    ),
  ];
  const lotRows = lotIds.length
    ? await queryAll<{ id: string; drawingNo: string | null }>(
        db,
        sql`SELECT id, drawing_no AS "drawingNo" FROM inventory_lots WHERE ${inArray(sql`id`, lotIds)}`
      )
    : [];
  const drawingByLotId = new Map(lotRows.map((r) => [r.id, r.drawingNo ?? ""]));
  const drawingNoOf = (pkg: PickingPackageDetail | null | undefined): string =>
    pkg?.sourceType === "inventory_lot" ? (drawingByLotId.get(pkg.sourceId) ?? "") : "";

  const rows: LabelPrintParamRow[] = [];
  if (match.labelType === "carton") {
    const boxes = [...order.boxes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const box of boxes) {
      const boxPkgs: { item: PickingItemDetail; pkg: PickingPackageDetail }[] = [];
      for (const item of order.items) {
        for (const pkg of item.packages) {
          if (pkg.shippingBoxId === box.id) boxPkgs.push({ item, pkg });
        }
      }
      // Same single-part rule as the default builder: mixed boxes leave the
      // part/batch fields empty.
      const distinctParts = new Set(boxPkgs.map(({ item }) => item.partNo));
      const single = distinctParts.size === 1 ? boxPkgs[0] : undefined;
      const totalQty = boxPkgs.reduce((sum, { pkg }) => sum + pkg.qty, 0);
      rows.push({
        shippingBoxId: box.id,
        packageId: null,
        params: yhftCh01Row(order, single?.item ?? null, single?.pkg ?? null, totalQty, drawingNoOf(single?.pkg)),
      });
    }
  } else {
    for (const item of order.items) {
      for (const pkg of item.packages) {
        rows.push({
          shippingBoxId: null,
          packageId: pkg.id,
          params: yhftCh01Row(order, item, pkg, pkg.qty, drawingNoOf(pkg)),
        });
      }
    }
  }

  const total = rows.length;
  return rows.map((row, i) => ({
    ...row,
    params: { ...row.params, page: String(i + 1), total: String(total) },
  }));
}

/** Converted param-row count for one match (the PDA panel shows it before
 *  printing); used by the label-print-rules route handler only. */
export async function labelCountForMatch(
  db: DbOrTx,
  order: PickingOrderDetail,
  match: LabelPrintRuleMatch
): Promise<number> {
  return (await buildLabelPrintParams({ db, order, match })).length;
}

export interface PrintOrderLabelResult {
  jobs: unknown;
  labelCount: number;
}

export async function printOrderLabel(
  db: DbOrTx,
  input: {
    orderId: string;
    ruleId: string;
    actorId: string;
    scope?: UserScopeEntry[] | null;
    // Caller-picked agent printer (serviceId + deviceKey from
    // GET /print/printers); absent = the template's default printer.
    printer?: { serviceId: string; deviceKey: string };
  }
): Promise<PrintOrderLabelResult> {
  const rule = await queryGet<{ id: string; active: boolean }>(
    db,
    sql`SELECT id, active FROM label_print_rules WHERE id = ${input.ruleId}`
  );
  if (!rule) throw new HTTPException(404, { message: "label_print_rule_not_found" });
  if (!rule.active) throw new HTTPException(409, { message: "label_print_rule_inactive" });

  // Re-validate against the order (rules may have changed since the client
  // fetched the matches); also 404s unknown orders.
  const { matches } = await resolveLabelPrintRulesForOrder(db, input.orderId);
  const match = matches.find((m) => m.ruleId === input.ruleId);
  if (!match) throw new HTTPException(409, { message: "label_rule_no_longer_matches" });
  // External labels are provided by the customer — nothing to print.
  if (match.labelSource === "external") {
    throw new HTTPException(409, { message: "label_rule_external" });
  }

  const order = await getPickingOrderDetail(db, input.orderId, input.scope);
  const rows = await buildLinkedLabelPrintParams({ db, order, match });
  if (rows.length === 0) {
    throw new HTTPException(400, { message: "printing_params_required" });
  }
  const printingParams = rows.map((row) => row.params);

  const data = (await dynamicPrint({
    templateId: match.printTemplateId,
    printingParams,
    copies: 1,
    mode: "auto",
    orientation: "portrait",
    // deviceKey doubles as printerName for the dynamic-print route (the
    // upstream treats the agent deviceKey as the printer identity).
    ...(input.printer
      ? { serviceId: input.printer.serviceId, deviceKey: input.printer.deviceKey, printerName: input.printer.deviceKey }
      : {}),
  })) as { jobs?: unknown };
  const jobs = data?.jobs ?? [];

  // Print history (2026-10-30): one row per print action, recording the exact
  // per-label payload linked to its package/box. Only on upstream success.
  await db.insert(labelPrints).values({
    id: newId(),
    pickingOrderId: input.orderId,
    ruleId: match.ruleId,
    labelType: match.labelType,
    printTemplateId: match.printTemplateId,
    printerName: input.printer?.deviceKey ?? null,
    serviceId: input.printer?.serviceId ?? null,
    deviceKey: input.printer?.deviceKey ?? null,
    expectedLabelCount: rows.length,
    payload: rows,
    result: jobs,
    printedBy: input.actorId,
    createdDate: now(),
    lastUpdateDate: now(),
  });

  return { jobs, labelCount: rows.length };
}
