import { eq } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";
import { allocatePickingOrder } from "./allocate";

export async function seedDb(db: PgliteDatabase<typeof schema>) {
  const now = new Date();

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
    { id: uuid(), code: "ABLIC", name: "ABLIC" },
    { id: uuid(), code: "DAITO", name: "DAITO" },
    { id: uuid(), code: "DEXERI", name: "DEXERIALS -MCI" },
    { id: uuid(), code: "DIOTEC", name: "DIOTEC" },
    { id: uuid(), code: "HINODE", name: "HINODE -MCI" },
    { id: uuid(), code: "ICHAUS", name: "ICHAUS -MCI" },
    { id: uuid(), code: "IK", name: "IK Semicon" },
    { id: uuid(), code: "KOA", name: "KOA" },
    { id: uuid(), code: "KYOCER", name: "KYOCERA -MCI" },
    { id: uuid(), code: "M", name: "M-TRON" },
    { id: uuid(), code: "MINEBE", name: "MINEBEAMITSUMI -MCI" },
    { id: uuid(), code: "MMC", name: "MMC" },
    { id: uuid(), code: "NCC", name: "NCC" },
    { id: uuid(), code: "NDK", name: "NDK" },
    { id: uuid(), code: "NIDEC", name: "NIDEC" },
    { id: uuid(), code: "NITSUKO", name: "NITSUKO" },
    { id: uuid(), code: "OKAYA", name: "OKAYA -MCI" },
    { id: uuid(), code: "SEIKO", name: "SEIKO -MCI & MCE" },
    { id: uuid(), code: "SEMIKR", name: "SEMIKRON -MCI" },
    { id: uuid(), code: "SEMITE", name: "SEMITEC" },
    { id: uuid(), code: "SHINDE", name: "Shindengen" },
    { id: uuid(), code: "SUMITO", name: "SUMITOMO -MCI" },
    { id: uuid(), code: "TE", name: "TE -MCI" },
    { id: uuid(), code: "VINA", name: "VINA -MCE" },
    { id: uuid(), code: "YAMAIC", name: "YAMAICHI -MCE" },
    { id: uuid(), code: "YAMA1", name: "YAMAICHI -MCI" },
  ] as const;
  await db.insert(schema.suppliers).values(supplierRecords);
  const supplierByCode = Object.fromEntries(supplierRecords.map((s) => [s.code, s])) as Record<
    (typeof supplierRecords)[number]["code"],
    (typeof supplierRecords)[number]
  >;

  const partRecords = [
    { id: uuid(), partNo: "RK73B1JTTD181G", internalCode: "", description: "", defaultCoo: "CN" },
    { id: uuid(), partNo: "RK73H2ATTD1372F", internalCode: "", description: "", defaultCoo: "CN" },
    { id: uuid(), partNo: "RK73H1JTTD1501F", internalCode: "", description: "", defaultCoo: "CN" },
    { id: uuid(), partNo: "RK73H1JTTD2202F", internalCode: "", description: "", defaultCoo: "CN" },
    { id: uuid(), partNo: "RK73H2ATTD1002F", internalCode: "", description: "", defaultCoo: "CN" },
    { id: uuid(), partNo: "S-1206B18-M3T1U", internalCode: "", description: "", defaultCoo: "JP" },
    { id: uuid(), partNo: "S-80860CNNB-B9LT2U", internalCode: "", description: "", defaultCoo: "JP" },
    { id: uuid(), partNo: "S-8240ADJ-I6T1U", internalCode: "", description: "", defaultCoo: "JP" },
    { id: uuid(), partNo: "DBI25-16A", internalCode: "", description: "", defaultCoo: "IN" },
    { id: uuid(), partNo: "MM1Z4733A", internalCode: "", description: "", defaultCoo: "CN" },
    { id: uuid(), partNo: "SL1M", internalCode: "", description: "", defaultCoo: "CN" },
    { id: uuid(), partNo: "SMF51CA", internalCode: "", description: "", defaultCoo: "CN" },
    { id: uuid(), partNo: "Z1SMA1020", internalCode: "", description: "", defaultCoo: "DE" },
    { id: uuid(), partNo: "IL34063ADT", internalCode: "", description: "", defaultCoo: "KR" },
    { id: uuid(), partNo: "CX2016SA20000D0HSSCC", internalCode: "", description: "", defaultCoo: "JP" },
    { id: uuid(), partNo: "NCC-TND14V-471KB00AAA0", internalCode: "", description: "", defaultCoo: "ID" },
    { id: uuid(), partNo: "NX8045GB", internalCode: "", description: "", defaultCoo: "CN" },
    { id: uuid(), partNo: "Q-SPT7P0327620C5GF", internalCode: "", description: "", defaultCoo: "MY" },
    { id: uuid(), partNo: "OKAYA-RE104-L", internalCode: "", description: "", defaultCoo: "CN" },
    { id: uuid(), partNo: "D1FL20U", internalCode: "", description: "", defaultCoo: "JP" },
    { id: uuid(), partNo: "04028DA12RBUFB", internalCode: "", description: "", defaultCoo: "CN" },
  ] as const;
  await db.insert(schema.parts).values(partRecords);
  const partByNo = Object.fromEntries(partRecords.map((p) => [p.partNo, p])) as Record<
    (typeof partRecords)[number]["partNo"],
    (typeof partRecords)[number]
  >;

  const shelfRecords = [
    { code: "A-01-01", zone: "A" },
    { code: "A-01-02", zone: "A" },
    { code: "A-01-03", zone: "A" },
    { code: "A-01-04", zone: "A" },
    { code: "A-01-05", zone: "A" },
    { code: "A-01-06", zone: "A" },
    { code: "A-01-07", zone: "A" },
    { code: "A-01-08", zone: "A" },
    { code: "B-01-01", zone: "B" },
    { code: "B-02-01", zone: "B" },
    { code: "B-02-02", zone: "B" },
  ] as const;
  await db.insert(schema.shelves).values(shelfRecords);

  // Pre-existing shelf inventory from Section 4 of the seed curation.
  const preExistingLots = [
    { id: uuid(), partId: partByNo["IL34063ADT"].id, dateCode: "", lotCode: "", coo: "KR", cow: "USA", shelfCode: "A-01-01", boxId: null, totalQty: 5000, allocatedQty: 0 },
    { id: uuid(), partId: partByNo["CX2016SA20000D0HSSCC"].id, dateCode: "", lotCode: "", coo: "JP", cow: "USA", shelfCode: "A-01-02", boxId: null, totalQty: 5000, allocatedQty: 0 },
    { id: uuid(), partId: partByNo["NCC-TND14V-471KB00AAA0"].id, dateCode: "", lotCode: "", coo: "ID", cow: "USA", shelfCode: "A-01-03", boxId: null, totalQty: 5000, allocatedQty: 0 },
    { id: uuid(), partId: partByNo["NX8045GB"].id, dateCode: "", lotCode: "", coo: "CN", cow: "USA", shelfCode: "A-01-04", boxId: null, totalQty: 5000, allocatedQty: 0 },
    { id: uuid(), partId: partByNo["Q-SPT7P0327620C5GF"].id, dateCode: "", lotCode: "", coo: "MY", cow: "USA", shelfCode: "A-01-05", boxId: null, totalQty: 5000, allocatedQty: 0 },
    { id: uuid(), partId: partByNo["OKAYA-RE104-L"].id, dateCode: "", lotCode: "", coo: "CN", cow: "USA", shelfCode: "A-01-06", boxId: null, totalQty: 5000, allocatedQty: 0 },
    { id: uuid(), partId: partByNo["D1FL20U"].id, dateCode: "", lotCode: "", coo: "JP", cow: "USA", shelfCode: "A-01-07", boxId: null, totalQty: 5000, allocatedQty: 0 },
    { id: uuid(), partId: partByNo["04028DA12RBUFB"].id, dateCode: "", lotCode: "", coo: "CN", cow: "USA", shelfCode: "A-01-08", boxId: null, totalQty: 10, allocatedQty: 0 },
  ] as const;
  await db.insert(schema.inventoryLots).values(preExistingLots);

  // Pre-existing shelf boxes so the goods-verify flow has boxes to check.
  const preExistingShelfBoxes = [
    { id: "SBOX-SEED-001", receivingOrderId: null as string | null, shelfCode: "A-01-01", status: "open" as const, createdAt: now },
    { id: "SBOX-SEED-002", receivingOrderId: null as string | null, shelfCode: "A-01-02", status: "closed" as const, createdAt: now },
    { id: "SBOX-SEED-003", receivingOrderId: null as string | null, shelfCode: "B-01-01", status: "open" as const, createdAt: now },
  ] as const;
  await db.insert(schema.shelfBoxes).values(preExistingShelfBoxes);

  await db.insert(schema.shelfBoxItems).values([
    {
      id: uuid(),
      shelfBoxId: "SBOX-SEED-001",
      receivingInvoiceItemId: null as string | null,
      partId: partByNo["RK73B1JTTD181G"].id,
      qty: 1000,
      verified: false,
      verifiedAt: null as Date | null,
    },
    {
      id: uuid(),
      shelfBoxId: "SBOX-SEED-001",
      receivingInvoiceItemId: null as string | null,
      partId: partByNo["RK73H2ATTD1372F"].id,
      qty: 500,
      verified: true,
      verifiedAt: now,
    },
    {
      id: uuid(),
      shelfBoxId: "SBOX-SEED-002",
      receivingInvoiceItemId: null as string | null,
      partId: partByNo["S-1206B18-M3T1U"].id,
      qty: 500,
      verified: true,
      verifiedAt: now,
    },
    {
      id: uuid(),
      shelfBoxId: "SBOX-SEED-003",
      receivingInvoiceItemId: null as string | null,
      partId: partByNo["S-8240ADJ-I6T1U"].id,
      qty: 200,
      verified: false,
      verifiedAt: null as Date | null,
    },
    {
      id: uuid(),
      shelfBoxId: "SBOX-SEED-003",
      receivingInvoiceItemId: null as string | null,
      partId: partByNo["D1FL20U"].id,
      qty: 100,
      verified: false,
      verifiedAt: null as Date | null,
    },
  ]);

  // Receiving orders
  const receivingOrderRecords = [
    {
      id: uuid(),
      refNo: "04958058-W-01",
      supplierId: supplierByCode.KOA.id,
      deliveryDate: now,
      status: "in_hand" as const,
      arrivedAt: now,
      arrivedBy: userOperator.id,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: uuid(),
      refNo: "1080082369",
      supplierId: supplierByCode.ABLIC.id,
      deliveryDate: now,
      status: "in_hand" as const,
      arrivedAt: now,
      arrivedBy: userOperator.id,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: uuid(),
      refNo: "52600142",
      supplierId: supplierByCode.DIOTEC.id,
      deliveryDate: now,
      status: "pending" as const,
      arrivedAt: null as Date | null,
      arrivedBy: null as string | null,
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
    { id: uuid(), receivingOrderId: receivingOrderByRef["04958058-W-01"].id, invoiceNo: "04958058-W-01", supplierId: supplierByCode.KOA.id },
    { id: uuid(), receivingOrderId: receivingOrderByRef["1080082369"].id, invoiceNo: "1080082369", supplierId: supplierByCode.ABLIC.id },
    { id: uuid(), receivingOrderId: receivingOrderByRef["52600142"].id, invoiceNo: "52600142", supplierId: supplierByCode.DIOTEC.id },
  ] as const;
  await db.insert(schema.receivingInvoices).values(invoiceRecords);
  const invoiceByNo = Object.fromEntries(invoiceRecords.map((inv) => [inv.invoiceNo, inv])) as Record<
    (typeof invoiceRecords)[number]["invoiceNo"],
    (typeof invoiceRecords)[number]
  >;

  const receivingInvoiceItemRecords = [
    // KOA 04958058-W-01
    {
      id: uuid(),
      receivingInvoiceId: invoiceByNo["04958058-W-01"].id,
      partId: partByNo["RK73B1JTTD181G"].id,
      poNo: "1180200568STD",
      poLine: "1",
      qty: 15000,
      receivedQty: 15000,
      pickedQty: 0,
      putAwayQty: 0,
      boxId: null as string | null,
      dateCode: "" as string | null,
      lotCode: "" as string | null,
      coo: "CN",
      cow: "USA",
      reportedMismatch: false,
      mismatchNote: null as string | null,
    },
    {
      id: uuid(),
      receivingInvoiceId: invoiceByNo["04958058-W-01"].id,
      partId: partByNo["RK73H2ATTD1372F"].id,
      poNo: "1180200568STD",
      poLine: "2",
      qty: 40000,
      receivedQty: 40000,
      pickedQty: 0,
      putAwayQty: 0,
      boxId: null,
      dateCode: "",
      lotCode: "",
      coo: "CN",
      cow: "USA",
      reportedMismatch: false,
      mismatchNote: null,
    },
    {
      id: uuid(),
      receivingInvoiceId: invoiceByNo["04958058-W-01"].id,
      partId: partByNo["RK73H1JTTD1501F"].id,
      poNo: "1180200859STD",
      poLine: "3",
      qty: 5000,
      receivedQty: 5000,
      pickedQty: 0,
      putAwayQty: 0,
      boxId: null,
      dateCode: "",
      lotCode: "",
      coo: "CN",
      cow: "USA",
      reportedMismatch: false,
      mismatchNote: null,
    },
    {
      id: uuid(),
      receivingInvoiceId: invoiceByNo["04958058-W-01"].id,
      partId: partByNo["RK73H1JTTD2202F"].id,
      poNo: "1180200859STD",
      poLine: "4",
      qty: 5000,
      receivedQty: 5000,
      pickedQty: 0,
      putAwayQty: 0,
      boxId: null,
      dateCode: "",
      lotCode: "",
      coo: "CN",
      cow: "USA",
      reportedMismatch: false,
      mismatchNote: null,
    },
    {
      id: uuid(),
      receivingInvoiceId: invoiceByNo["04958058-W-01"].id,
      partId: partByNo["RK73H2ATTD1002F"].id,
      poNo: "1180201327STD",
      poLine: "5",
      qty: 70000,
      receivedQty: 70000,
      pickedQty: 0,
      putAwayQty: 0,
      boxId: null,
      dateCode: "",
      lotCode: "",
      coo: "CN",
      cow: "USA",
      reportedMismatch: false,
      mismatchNote: null,
    },
    // ABLIC 1080082369
    {
      id: uuid(),
      receivingInvoiceId: invoiceByNo["1080082369"].id,
      partId: partByNo["S-1206B18-M3T1U"].id,
      poNo: "1180200571W",
      poLine: "1",
      qty: 3000,
      receivedQty: 3000,
      pickedQty: 0,
      putAwayQty: 0,
      boxId: null,
      dateCode: "",
      lotCode: "",
      coo: "JP",
      cow: "USA",
      reportedMismatch: false,
      mismatchNote: null,
    },
    {
      id: uuid(),
      receivingInvoiceId: invoiceByNo["1080082369"].id,
      partId: partByNo["S-80860CNNB-B9LT2U"].id,
      poNo: "1180200214",
      poLine: "2",
      qty: 3000,
      receivedQty: 3000,
      pickedQty: 0,
      putAwayQty: 0,
      boxId: null,
      dateCode: "",
      lotCode: "",
      coo: "JP",
      cow: "USA",
      reportedMismatch: false,
      mismatchNote: null,
    },
    {
      id: uuid(),
      receivingInvoiceId: invoiceByNo["1080082369"].id,
      partId: partByNo["S-8240ADJ-I6T1U"].id,
      poNo: "1180201399",
      poLine: "3",
      qty: 15000,
      receivedQty: 15000,
      pickedQty: 0,
      putAwayQty: 0,
      boxId: null,
      dateCode: "",
      lotCode: "",
      coo: "JP",
      cow: "USA",
      reportedMismatch: false,
      mismatchNote: null,
    },
    // DIOTEC 52600142 (pending)
    {
      id: uuid(),
      receivingInvoiceId: invoiceByNo["52600142"].id,
      partId: partByNo["DBI25-16A"].id,
      poNo: "1180200536",
      poLine: "1",
      qty: 900,
      receivedQty: 0,
      pickedQty: 0,
      putAwayQty: 0,
      boxId: null,
      dateCode: "",
      lotCode: "",
      coo: "IN",
      cow: "USA",
      reportedMismatch: false,
      mismatchNote: null,
    },
    {
      id: uuid(),
      receivingInvoiceId: invoiceByNo["52600142"].id,
      partId: partByNo["MM1Z4733A"].id,
      poNo: "1180200595",
      poLine: "2",
      qty: 75000,
      receivedQty: 0,
      pickedQty: 0,
      putAwayQty: 0,
      boxId: null,
      dateCode: "",
      lotCode: "",
      coo: "CN",
      cow: "USA",
      reportedMismatch: false,
      mismatchNote: null,
    },
    {
      id: uuid(),
      receivingInvoiceId: invoiceByNo["52600142"].id,
      partId: partByNo["SL1M"].id,
      poNo: "1180200706",
      poLine: "3",
      qty: 300000,
      receivedQty: 0,
      pickedQty: 0,
      putAwayQty: 0,
      boxId: null,
      dateCode: "",
      lotCode: "",
      coo: "CN",
      cow: "USA",
      reportedMismatch: false,
      mismatchNote: null,
    },
    {
      id: uuid(),
      receivingInvoiceId: invoiceByNo["52600142"].id,
      partId: partByNo["SMF51CA"].id,
      poNo: "1180201274",
      poLine: "4",
      qty: 12000,
      receivedQty: 0,
      pickedQty: 0,
      putAwayQty: 0,
      boxId: null,
      dateCode: "",
      lotCode: "",
      coo: "CN",
      cow: "USA",
      reportedMismatch: false,
      mismatchNote: null,
    },
    {
      id: uuid(),
      receivingInvoiceId: invoiceByNo["52600142"].id,
      partId: partByNo["Z1SMA1020"].id,
      poNo: "1180201290",
      poLine: "5",
      qty: 7500,
      receivedQty: 0,
      pickedQty: 0,
      putAwayQty: 0,
      boxId: null,
      dateCode: "",
      lotCode: "",
      coo: "DE",
      cow: "USA",
      reportedMismatch: false,
      mismatchNote: null,
    },
  ] as const;
  await db.insert(schema.receivingInvoiceItems).values(receivingInvoiceItemRecords);

  // Note: in-hand receiving orders intentionally do NOT create inventory_lots here.
  // Allocations are made against receiving_invoice_items directly.

  const pickingOrderRecords = [
    { id: uuid(), refNo: "PICK-001", supplierId: supplierByCode.KOA.id, deliveryDate: now, poNo: "PO-PICK-001", requiredDateCodeNotice: null as string | null, shipTo: "US", destinationCountry: "USA", status: "pending" as const, createdAt: now, updatedAt: now },
    { id: uuid(), refNo: "PICK-002", supplierId: supplierByCode.ABLIC.id, deliveryDate: now, poNo: "PO-PICK-002", requiredDateCodeNotice: null, shipTo: "CN", destinationCountry: "China", status: "pending" as const, createdAt: now, updatedAt: now },
    { id: uuid(), refNo: "PICK-003", supplierId: supplierByCode.OKAYA.id, deliveryDate: now, poNo: "PO-PICK-003", requiredDateCodeNotice: null, shipTo: "US", destinationCountry: "USA", status: "pending" as const, createdAt: now, updatedAt: now },
    { id: uuid(), refNo: "PICK-004", supplierId: supplierByCode.KYOCER.id, deliveryDate: now, poNo: "PO-PICK-004", requiredDateCodeNotice: null, shipTo: "CN", destinationCountry: "China", status: "pending" as const, createdAt: now, updatedAt: now },
    { id: uuid(), refNo: "PICK-005", supplierId: supplierByCode.IK.id, deliveryDate: now, poNo: "PO-PICK-005", requiredDateCodeNotice: null, shipTo: "US", destinationCountry: "USA", status: "pending" as const, createdAt: now, updatedAt: now },
  ] as const;
  await db.insert(schema.pickingOrders).values(pickingOrderRecords);
  const pickingOrderByRef = Object.fromEntries(pickingOrderRecords.map((po) => [po.refNo, po])) as Record<
    (typeof pickingOrderRecords)[number]["refNo"],
    (typeof pickingOrderRecords)[number]
  >;

  const pickingItemRecords = [
    // PICK-001 (KOA)
    {
      id: uuid(),
      pickingOrderId: pickingOrderByRef["PICK-001"].id,
      partId: partByNo["RK73H2ATTD1372F"].id,
      qty: 500,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null as string | null,
    },
    {
      id: uuid(),
      pickingOrderId: pickingOrderByRef["PICK-001"].id,
      partId: partByNo["RK73H1JTTD1501F"].id,
      qty: 200,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null,
    },
    {
      id: uuid(),
      pickingOrderId: pickingOrderByRef["PICK-001"].id,
      partId: partByNo["RK73H2ATTD1002F"].id,
      qty: 1000,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null,
    },
    // PICK-002 (ABLIC)
    {
      id: uuid(),
      pickingOrderId: pickingOrderByRef["PICK-002"].id,
      partId: partByNo["S-1206B18-M3T1U"].id,
      qty: 100,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null,
    },
    {
      id: uuid(),
      pickingOrderId: pickingOrderByRef["PICK-002"].id,
      partId: partByNo["S-8240ADJ-I6T1U"].id,
      qty: 500,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null,
    },
    {
      id: uuid(),
      pickingOrderId: pickingOrderByRef["PICK-002"].id,
      partId: partByNo["D1FL20U"].id,
      qty: 100,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null,
    },
    // PICK-003 (OKAYA)
    {
      id: uuid(),
      pickingOrderId: pickingOrderByRef["PICK-003"].id,
      partId: partByNo["OKAYA-RE104-L"].id,
      qty: 500,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null,
    },
    {
      id: uuid(),
      pickingOrderId: pickingOrderByRef["PICK-003"].id,
      partId: partByNo["D1FL20U"].id,
      qty: 100,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null,
    },
    {
      id: uuid(),
      pickingOrderId: pickingOrderByRef["PICK-003"].id,
      partId: partByNo["IL34063ADT"].id,
      qty: 200,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null,
    },
    // PICK-004 (KYOCER)
    {
      id: uuid(),
      pickingOrderId: pickingOrderByRef["PICK-004"].id,
      partId: partByNo["NX8045GB"].id,
      qty: 50,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null,
    },
    {
      id: uuid(),
      pickingOrderId: pickingOrderByRef["PICK-004"].id,
      partId: partByNo["CX2016SA20000D0HSSCC"].id,
      qty: 100,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null,
    },
    {
      id: uuid(),
      pickingOrderId: pickingOrderByRef["PICK-004"].id,
      partId: partByNo["Q-SPT7P0327620C5GF"].id,
      qty: 120,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null,
    },
    // PICK-005 (IK)
    {
      id: uuid(),
      pickingOrderId: pickingOrderByRef["PICK-005"].id,
      partId: partByNo["IL34063ADT"].id,
      qty: 200,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null,
    },
    {
      id: uuid(),
      pickingOrderId: pickingOrderByRef["PICK-005"].id,
      partId: partByNo["NCC-TND14V-471KB00AAA0"].id,
      qty: 250,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null,
    },
    {
      id: uuid(),
      pickingOrderId: pickingOrderByRef["PICK-005"].id,
      partId: partByNo["04028DA12RBUFB"].id,
      qty: 1,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null,
    },
  ] as const;
  await db.insert(schema.pickingItems).values(pickingItemRecords);

  // Attempt to allocate all seeded picking orders from shelf stock or in-hand receiving items.
  for (const po of pickingOrderRecords) {
    await allocatePickingOrder(db, po.id);
  }
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
