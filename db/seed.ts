import { eq } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";
import { allocatePickingOrder } from "./allocate";

export async function seedDb(db: PgliteDatabase<typeof schema>) {
  const now = new Date();
  const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

  // Demo only: passwords are stored as-is so the local demo can compare them directly.
  const userOperator = {
    id: uuid(),
    username: "operator",
    passwordHash: "DocPal2026!",
    displayName: "Demo Operator",
    role: "operator" as const,
    createdAt: now,
  };
  const userAdmin = {
    id: uuid(),
    username: "admin",
    passwordHash: "DocPalAdmin2026!",
    displayName: "Demo Admin",
    role: "admin" as const,
    createdAt: now,
  };

  await db.insert(schema.users).values([userOperator, userAdmin]);

  const supplierRecords = [
    { id: uuid(), code: "ALP", name: "Alpha Electronics" },
    { id: uuid(), code: "BET", name: "Beta Semiconductor" },
    { id: uuid(), code: "GAM", name: "Gamma Precision" },
    { id: uuid(), code: "DEL", name: "Delta Components" },
    { id: uuid(), code: "EPS", name: "Epsilon Connectors" },
  ] as const;
  await db.insert(schema.suppliers).values(supplierRecords);
  const supplierByCode = Object.fromEntries(supplierRecords.map((s) => [s.code, s])) as Record<
    (typeof supplierRecords)[number]["code"],
    (typeof supplierRecords)[number]
  >;

  const partRecords = [
    { id: uuid(), partNo: "RES-0603-10K", internalCode: "RES-0603-10K", description: "Resistor 10K 0603", defaultCoo: "JP" },
    { id: uuid(), partNo: "CAP-0805-100N", internalCode: "CAP-0805-100N", description: "Cap 100nF 0805", defaultCoo: "JP" },
    { id: uuid(), partNo: "IC-LM358DR", internalCode: "IC-LM358DR", description: "Op-amp", defaultCoo: "MY" },
    { id: uuid(), partNo: "MOS-IRLML6244", internalCode: "MOS-IRLML6244", description: "MOSFET", defaultCoo: "MY" },
    { id: uuid(), partNo: "MCU-STM32F103", internalCode: "MCU-STM32F103", description: "MCU", defaultCoo: "CN" },
    { id: uuid(), partNo: "SNS-BMP280", internalCode: "SNS-BMP280", description: "Pressure sensor", defaultCoo: "DE" },
    { id: uuid(), partNo: "CON-PH2.0-4P", internalCode: "CON-PH2.0-4P", description: "4-pin connector", defaultCoo: "TW" },
  ] as const;
  await db.insert(schema.parts).values(partRecords);
  const partByNo = Object.fromEntries(partRecords.map((p) => [p.partNo, p])) as Record<
    (typeof partRecords)[number]["partNo"],
    (typeof partRecords)[number]
  >;

  const shelfRecords = [
    { code: "A-01-01", zone: "A" },
    { code: "A-01-02", zone: "A" },
    { code: "A-02-01", zone: "A" },
    { code: "A-02-02", zone: "A" },
    { code: "B-01-01", zone: "B" },
    { code: "B-02-01", zone: "B" },
    { code: "B-02-02", zone: "B" },
  ] as const;
  await db.insert(schema.shelves).values(shelfRecords);

  const shelvedLots = [
    { id: uuid(), partId: partByNo["RES-0603-10K"].id, dateCode: "2404", lotCode: "L240401", coo: "JP", cow: "USA", shelfCode: "A-01-01", boxId: null as string | null, totalQty: 5000, allocatedQty: 0 },
    { id: uuid(), partId: partByNo["CAP-0805-100N"].id, dateCode: "2404", lotCode: "L240402", coo: "JP", cow: "USA", shelfCode: "A-01-02", boxId: null, totalQty: 3000, allocatedQty: 0 },
    { id: uuid(), partId: partByNo["CON-PH2.0-4P"].id, dateCode: "2403", lotCode: "L240302", coo: "TW", cow: "USA", shelfCode: "B-02-01", boxId: null, totalQty: 2000, allocatedQty: 0 },
  ] as const;
  await db.insert(schema.inventoryLots).values(shelvedLots.map((lot) => ({ ...lot })));

  // Receiving orders
  const receivingOrderRecords = [
    {
      id: uuid(),
      refNo: "RO-240701-001",
      supplierId: supplierByCode.ALP.id,
      deliveryDate: now,
      status: "in_hand" as const,
      arrivedAt: now,
      arrivedBy: userOperator.id,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: uuid(),
      refNo: "RO-240701-002",
      supplierId: supplierByCode.BET.id,
      deliveryDate: now,
      status: "in_hand" as const,
      arrivedAt: now,
      arrivedBy: userOperator.id,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: uuid(),
      refNo: "RO-240705-001",
      supplierId: supplierByCode.GAM.id,
      deliveryDate: days(4),
      status: "pending" as const,
      arrivedAt: null as Date | null,
      arrivedBy: null as string | null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: uuid(),
      refNo: "RO-240710-001",
      supplierId: supplierByCode.DEL.id,
      deliveryDate: days(9),
      status: "pending" as const,
      arrivedAt: null as Date | null,
      arrivedBy: null as string | null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: uuid(),
      refNo: "RO-240615-001",
      supplierId: supplierByCode.EPS.id,
      deliveryDate: days(-15),
      status: "in_hand" as const,
      arrivedAt: now,
      arrivedBy: userOperator.id,
      createdAt: now,
      updatedAt: now,
    },
  ] as const;
  await db.insert(schema.receivingOrders).values(receivingOrderRecords);
  const receivingOrderByRef = Object.fromEntries(receivingOrderRecords.map((ro) => [ro.refNo, ro])) as Record<
    (typeof receivingOrderRecords)[number]["refNo"],
    (typeof receivingOrderRecords)[number]
  >;

  const invoiceRecords = [
    { id: uuid(), receivingOrderId: receivingOrderByRef["RO-240701-001"].id, invoiceNo: "INV-ALP-240701-001", supplierId: supplierByCode.ALP.id },
    { id: uuid(), receivingOrderId: receivingOrderByRef["RO-240701-001"].id, invoiceNo: "INV-ALP-240701-002", supplierId: supplierByCode.ALP.id },
    { id: uuid(), receivingOrderId: receivingOrderByRef["RO-240701-002"].id, invoiceNo: "INV-BET-240701-001", supplierId: supplierByCode.BET.id },
    { id: uuid(), receivingOrderId: receivingOrderByRef["RO-240701-002"].id, invoiceNo: "INV-BET-240701-002", supplierId: supplierByCode.BET.id },
    { id: uuid(), receivingOrderId: receivingOrderByRef["RO-240701-002"].id, invoiceNo: "INV-BET-240701-003", supplierId: supplierByCode.BET.id },
    { id: uuid(), receivingOrderId: receivingOrderByRef["RO-240705-001"].id, invoiceNo: "INV-GAM-240705-001", supplierId: supplierByCode.GAM.id },
    { id: uuid(), receivingOrderId: receivingOrderByRef["RO-240710-001"].id, invoiceNo: "INV-DEL-240710-001", supplierId: supplierByCode.DEL.id },
    { id: uuid(), receivingOrderId: receivingOrderByRef["RO-240615-001"].id, invoiceNo: "INV-EPS-240615-001", supplierId: supplierByCode.EPS.id },
  ] as const;
  await db.insert(schema.receivingInvoices).values(invoiceRecords);
  const invoiceByNo = Object.fromEntries(invoiceRecords.map((inv) => [inv.invoiceNo, inv])) as Record<
    (typeof invoiceRecords)[number]["invoiceNo"],
    (typeof invoiceRecords)[number]
  >;

  const receivingInvoiceItemRecords = [
    // ALP RO-240701-001
    { id: uuid(), receivingInvoiceId: invoiceByNo["INV-ALP-240701-001"].id, partId: partByNo["RES-0603-10K"].id, poNo: "PO-ALP-240701-001", poLine: "1", qty: 40000, receivedQty: 40000, pickedQty: 0, putAwayQty: 0, boxId: null as string | null, dateCode: null as string | null, lotCode: null as string | null, coo: "JP", cow: "USA", reportedMismatch: false, mismatchNote: null as string | null },
    { id: uuid(), receivingInvoiceId: invoiceByNo["INV-ALP-240701-001"].id, partId: partByNo["CAP-0805-100N"].id, poNo: "PO-ALP-240701-001", poLine: "2", qty: 5000, receivedQty: 5000, pickedQty: 0, putAwayQty: 0, boxId: null, dateCode: "2406", lotCode: "L240601", coo: "JP", cow: "USA", reportedMismatch: false, mismatchNote: null },
    { id: uuid(), receivingInvoiceId: invoiceByNo["INV-ALP-240701-002"].id, partId: partByNo["CAP-0805-100N"].id, poNo: "PO-ALP-240701-001", poLine: "3", qty: 2000, receivedQty: 2000, pickedQty: 0, putAwayQty: 0, boxId: null, dateCode: "2406", lotCode: "L240602", coo: "JP", cow: "USA", reportedMismatch: false, mismatchNote: null },
    // BET RO-240701-002
    { id: uuid(), receivingInvoiceId: invoiceByNo["INV-BET-240701-001"].id, partId: partByNo["IC-LM358DR"].id, poNo: "PO-BET-240701-001", poLine: "1", qty: 1000, receivedQty: 1000, pickedQty: 0, putAwayQty: 0, boxId: null, dateCode: "2406", lotCode: "L240603", coo: "MY", cow: "USA", reportedMismatch: false, mismatchNote: null },
    { id: uuid(), receivingInvoiceId: invoiceByNo["INV-BET-240701-002"].id, partId: partByNo["MOS-IRLML6244"].id, poNo: "PO-BET-240701-001", poLine: "2", qty: 800, receivedQty: 800, pickedQty: 0, putAwayQty: 0, boxId: null, dateCode: "2406", lotCode: "L240604", coo: "MY", cow: "USA", reportedMismatch: false, mismatchNote: null },
    { id: uuid(), receivingInvoiceId: invoiceByNo["INV-BET-240701-003"].id, partId: partByNo["SNS-BMP280"].id, poNo: "PO-BET-240701-001", poLine: "3", qty: 300, receivedQty: 300, pickedQty: 0, putAwayQty: 0, boxId: null, dateCode: "2406", lotCode: "L240605", coo: "DE", cow: "USA", reportedMismatch: false, mismatchNote: null },
    // GAM RO-240705-001 (pending)
    { id: uuid(), receivingInvoiceId: invoiceByNo["INV-GAM-240705-001"].id, partId: partByNo["SNS-BMP280"].id, poNo: "PO-GAM-240705-001", poLine: "1", qty: 500, receivedQty: 0, pickedQty: 0, putAwayQty: 0, boxId: null, dateCode: null as string | null, lotCode: null as string | null, coo: "DE", cow: "USA", reportedMismatch: false, mismatchNote: null },
    // DEL RO-240710-001 (pending)
    { id: uuid(), receivingInvoiceId: invoiceByNo["INV-DEL-240710-001"].id, partId: partByNo["MCU-STM32F103"].id, poNo: "PO-DEL-240710-001", poLine: "1", qty: 80000, receivedQty: 0, pickedQty: 0, putAwayQty: 0, boxId: null, dateCode: null as string | null, lotCode: null as string | null, coo: "CN", cow: "USA", reportedMismatch: false, mismatchNote: null },
    // EPS RO-240615-001
    { id: uuid(), receivingInvoiceId: invoiceByNo["INV-EPS-240615-001"].id, partId: partByNo["CON-PH2.0-4P"].id, poNo: "PO-EPS-240615-001", poLine: "1", qty: 3000, receivedQty: 3000, pickedQty: 0, putAwayQty: 0, boxId: null, dateCode: "2404", lotCode: "L240403", coo: "TW", cow: "USA", reportedMismatch: false, mismatchNote: null },
  ] as const;
  await db.insert(schema.receivingInvoiceItems).values(receivingInvoiceItemRecords);

  // Note: in-hand receiving orders intentionally do NOT create inventory_lots here.
  // Allocations are made against receiving_invoice_items directly.

  const pickingOrderRecords = [
    { id: uuid(), refNo: "TN-240701-001", supplierId: supplierByCode.ALP.id, deliveryDate: now, poNo: "SO-240701-001", requiredDateCodeNotice: null as string | null, shipTo: "US", destinationCountry: "USA", status: "pending" as const, createdAt: now, updatedAt: now },
    { id: uuid(), refNo: "TN-240701-002", supplierId: supplierByCode.ALP.id, deliveryDate: now, poNo: "SO-240701-002", requiredDateCodeNotice: null, shipTo: "ZH", destinationCountry: "China", status: "pending" as const, createdAt: now, updatedAt: now },
    { id: uuid(), refNo: "TN-240701-003", supplierId: supplierByCode.ALP.id, deliveryDate: now, poNo: "SO-240701-003", requiredDateCodeNotice: null, shipTo: "SH", destinationCountry: "China", status: "pending" as const, createdAt: now, updatedAt: now },
    { id: uuid(), refNo: "TN-240701-004", supplierId: supplierByCode.ALP.id, deliveryDate: now, poNo: "SO-240701-004", requiredDateCodeNotice: null, shipTo: "BJ", destinationCountry: "China", status: "pending" as const, createdAt: now, updatedAt: now },
    { id: uuid(), refNo: "TN-240701-005", supplierId: supplierByCode.BET.id, deliveryDate: now, poNo: "SO-240701-005", requiredDateCodeNotice: null, shipTo: "US", destinationCountry: "USA", status: "pending" as const, createdAt: now, updatedAt: now },
    { id: uuid(), refNo: "TN-240705-001", supplierId: supplierByCode.GAM.id, deliveryDate: days(4), poNo: "SO-240705-001", requiredDateCodeNotice: null, shipTo: "DE", destinationCountry: "Germany", status: "pending" as const, createdAt: now, updatedAt: now },
  ] as const;
  await db.insert(schema.pickingOrders).values(pickingOrderRecords);
  const pickingOrderByRef = Object.fromEntries(pickingOrderRecords.map((po) => [po.refNo, po])) as Record<
    (typeof pickingOrderRecords)[number]["refNo"],
    (typeof pickingOrderRecords)[number]
  >;

  const pickingItemRecords = [
    // TN-240701-001
    { id: uuid(), pickingOrderId: pickingOrderByRef["TN-240701-001"].id, partId: partByNo["RES-0603-10K"].id, qty: 600, pickedQty: 0, allocatedQty: 0, requiredDateCode: null, sourceShelfCode: null as string | null },
    { id: uuid(), pickingOrderId: pickingOrderByRef["TN-240701-001"].id, partId: partByNo["CAP-0805-100N"].id, qty: 200, pickedQty: 0, allocatedQty: 0, requiredDateCode: null, sourceShelfCode: null },
    // TN-240701-002
    { id: uuid(), pickingOrderId: pickingOrderByRef["TN-240701-002"].id, partId: partByNo["RES-0603-10K"].id, qty: 20000, pickedQty: 0, allocatedQty: 0, requiredDateCode: ">=2405", sourceShelfCode: null },
    // TN-240701-003
    { id: uuid(), pickingOrderId: pickingOrderByRef["TN-240701-003"].id, partId: partByNo["RES-0603-10K"].id, qty: 1200, pickedQty: 0, allocatedQty: 0, requiredDateCode: ">=2405", sourceShelfCode: null },
    // TN-240701-004
    { id: uuid(), pickingOrderId: pickingOrderByRef["TN-240701-004"].id, partId: partByNo["RES-0603-10K"].id, qty: 800, pickedQty: 0, allocatedQty: 0, requiredDateCode: ">=2405", sourceShelfCode: null },
    // TN-240701-005
    { id: uuid(), pickingOrderId: pickingOrderByRef["TN-240701-005"].id, partId: partByNo["IC-LM358DR"].id, qty: 400, pickedQty: 0, allocatedQty: 0, requiredDateCode: null, sourceShelfCode: null },
    { id: uuid(), pickingOrderId: pickingOrderByRef["TN-240701-005"].id, partId: partByNo["MOS-IRLML6244"].id, qty: 200, pickedQty: 0, allocatedQty: 0, requiredDateCode: null, sourceShelfCode: null },
    // TN-240705-001
    { id: uuid(), pickingOrderId: pickingOrderByRef["TN-240705-001"].id, partId: partByNo["SNS-BMP280"].id, qty: 200, pickedQty: 0, allocatedQty: 0, requiredDateCode: ">2406", sourceShelfCode: null },
  ] as const;
  await db.insert(schema.pickingItems).values(pickingItemRecords);

  // Allocate picking orders that can be satisfied from shelf stock or in-hand receiving orders.
  // Order 6 (TN-240705-001) stays unallocated until the GAM shipment arrives.
  await allocatePickingOrder(db, pickingOrderByRef["TN-240701-001"].id);
  await allocatePickingOrder(db, pickingOrderByRef["TN-240701-002"].id);
  await allocatePickingOrder(db, pickingOrderByRef["TN-240701-003"].id);
  await allocatePickingOrder(db, pickingOrderByRef["TN-240701-004"].id);
  await allocatePickingOrder(db, pickingOrderByRef["TN-240701-005"].id);
}

// Demo only: passwords are stored as-is so the local demo can compare them directly.
export async function ensureDemoPasswords(db: PgliteDatabase<typeof schema>) {
  await db
    .update(schema.users)
    .set({ passwordHash: "DocPal2026!" })
    .where(eq(schema.users.username, "operator"));

  await db
    .update(schema.users)
    .set({ passwordHash: "DocPalAdmin2026!" })
    .where(eq(schema.users.username, "admin"));
}
