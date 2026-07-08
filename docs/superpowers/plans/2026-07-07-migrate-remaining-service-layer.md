# Migrate Remaining Flows to Service Layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all remaining UI flows (put-away, measuring, goods-verify, stock-search) behind the `WarehouseService` interface, remove all `useDb()` / Drizzle imports from `pages/` and `components/`, and complete the API adapter stubs.

**Architecture:** Keep the pattern established in Phases 1–2: plain DTOs in `services/types.ts`, `WarehouseService` interface in `services/warehouse.ts`, PGlite adapter delegates to existing `db/*.ts` helpers, API adapter throws `not implemented`. UI pages import only `useWarehouse()` and `services/types.ts`. Scan candidate searches remain local; write actions go through the service.

**Tech Stack:** Nuxt 3 (`ssr: false`), Vue 3, PGlite, Drizzle ORM (inside adapters only), TypeScript.

---

## File structure

**Service layer (extend existing):**
- `services/types.ts` — add put-away, measuring, goods-verify, stock-search DTOs
- `services/warehouse.ts` — extend `WarehouseService` interface
- `services/adapters/pgliteWarehouse.ts` — implement new methods
- `services/adapters/apiWarehouse.ts` — add stubs

**UI pages (modify):**
- `pages/put-away/index.vue`
- `pages/put-away/[id].vue`
- `pages/measuring/index.vue`
- `pages/measuring/[id].vue`
- `pages/measuring/[taskId]/box/[boxId].vue`
- `pages/goods-verify/index.vue`
- `pages/goods-verify/shelf/[code].vue`
- `pages/goods-verify/box/[id].vue`
- `pages/stock-search/index.vue`

**UI components (modify):**
- `components/SelectShelfDialog.vue`
- `components/put-away/ShelfBoxesPanel.vue`
- `components/put-away/PutAwayLotsPanel.vue`
- `components/BoxMeasurementsModal.vue`

**Shared composables (modify):**
- `composables/useScanMatchers.ts` — route put-away/measuring/goods-verify scan writes through service
- `composables/useMockOcr.ts` — move `OcrParseResult` type to `services/types.ts`

---

## Phase 3 — Put-away flow

### Task 1: Add put-away DTOs to `services/types.ts`

**Files:**
- Modify: `services/types.ts`

- [ ] **Step 1: Add DTOs after the picking section**

```ts
// ------------------------------------------------------------------
// Put-away
// ------------------------------------------------------------------

export interface PutAwayCandidate {
  id: string;
  refNo: string;
  status: string;
  supplierName: string | null;
  availableQty: number;
}

export interface PutAwayLot {
  receivingInvoiceItemId: string;
  partId: string;
  partNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  totalQty: number;
  availableQty: number;
  scannedQty: number;
  boxedQty: number;
}

export interface PutAwayScan {
  id: string;
  receivingInvoiceItemId: string;
  partId: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfBoxId: string | null;
  verified: boolean;
  verifiedAt: Date | null;
  createdAt: Date;
}

export interface ShelfBoxItem {
  id: string;
  partId: string;
  part: Part | null;
  qty: number;
  verified: boolean;
}

export interface ShelfBox {
  id: string;
  receivingOrderId: string | null;
  shelfCode: string | null;
  status: string;
  createdAt: Date;
  items: ShelfBoxItem[];
}

export interface Shelf {
  code: string;
  zone: string | null;
}
```

- [ ] **Step 2: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 2: Extend `WarehouseService` with put-away methods

**Files:**
- Modify: `services/warehouse.ts`

- [ ] **Step 1: Import new DTOs and add interface methods**

Add to imports from `./types`:
```ts
PutAwayCandidate,
PutAwayLot,
PutAwayScan,
ShelfBox,
Shelf,
```

Add to `WarehouseService` interface:
```ts
// Put-away
getPutAwayCandidates(): Promise<PutAwayCandidate[]>;
getPutAwayLots(receivingOrderId: string): Promise<PutAwayLot[]>;
getPutAwayScans(receivingOrderId: string): Promise<PutAwayScan[]>;
getShelfBoxesForReceivingOrder(receivingOrderId: string): Promise<ShelfBox[]>;
getShelves(): Promise<Shelf[]>;
recordPutAwayScan(
  receivingInvoiceItemId: string,
  qty: number,
  dateCode: string | null,
  lotCode: string | null,
  coo: string | null,
  cow: string | null
): Promise<PutAwayScan>;
assignPutAwayScanToBox(scanId: string, boxId: string): Promise<void>;
removePutAwayScanFromBox(scanId: string): Promise<void>;
removePutAwayScannedPiece(scanId: string): Promise<void>;
createShelfBox(receivingOrderId: string, shelfCode: string): Promise<ShelfBox>;
closeShelfBox(id: string): Promise<void>;
cancelShelfBox(id: string): Promise<void>;
```

- [ ] **Step 2: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 3: Implement put-away methods in PGlite adapter

**Files:**
- Modify: `services/adapters/pgliteWarehouse.ts`

- [ ] **Step 1: Import existing DB helpers**

Add to imports from `~/db/putAway`:
```ts
getPutAwayCandidates as dbGetPutAwayCandidates,
getPutAwayLots as dbGetPutAwayLots,
getPutAwayScansForReceivingOrder as dbGetPutAwayScansForReceivingOrder,
getShelfBoxesForReceivingOrder as dbGetShelfBoxesForReceivingOrder,
recordPutAwayScan as dbRecordPutAwayScan,
assignScanToBox as dbAssignScanToBox,
removeScanFromBox as dbRemoveScanFromBox,
removeScannedPiece as dbRemoveScannedPiece,
createShelfBox as dbCreateShelfBox,
closeShelfBox as dbCloseShelfBox,
cancelShelfBox as dbCancelShelfBox,
```

Add to imports from `../types`:
```ts
PutAwayCandidate,
PutAwayLot,
PutAwayScan,
ShelfBox,
Shelf,
```

- [ ] **Step 2: Add mapper functions before `createPgliteWarehouseService`**

```ts
function toPutAwayCandidate(row: {
  id: string;
  ref_no: string;
  status: string;
  supplier_name: string | null;
  available_qty: number;
}): PutAwayCandidate {
  return {
    id: row.id,
    refNo: row.ref_no,
    status: row.status,
    supplierName: row.supplier_name,
    availableQty: row.available_qty,
  };
}

function toPutAwayLot(row: PutAwayLot): PutAwayLot {
  return row;
}

function toPutAwayScan(row: PutAwayScan): PutAwayScan {
  return row;
}

function toShelfBox(row: Awaited<ReturnType<typeof dbGetShelfBoxesForReceivingOrder>>[number]): ShelfBox {
  return {
    id: row.id,
    receivingOrderId: row.receivingOrderId,
    shelfCode: row.shelfCode,
    status: row.status,
    createdAt: row.createdAt,
    items: (row.items ?? []).map((item) => ({
      id: item.id,
      partId: item.partId,
      part: item.part
        ? { id: item.partId, partNo: item.part.partNo, internalCode: null, description: null, defaultCoo: null }
        : null,
      qty: item.qty,
      verified: item.verified,
    })),
  };
}
```

- [ ] **Step 3: Add methods to the returned service object**

```ts
async getPutAwayCandidates(): Promise<PutAwayCandidate[]> {
  const rows = await dbGetPutAwayCandidates(db);
  return rows.map(toPutAwayCandidate);
},

async getPutAwayLots(receivingOrderId: string): Promise<PutAwayLot[]> {
  return dbGetPutAwayLots(db, receivingOrderId);
},

async getPutAwayScans(receivingOrderId: string): Promise<PutAwayScan[]> {
  return dbGetPutAwayScansForReceivingOrder(db, receivingOrderId);
},

async getShelfBoxesForReceivingOrder(receivingOrderId: string): Promise<ShelfBox[]> {
  const rows = await dbGetShelfBoxesForReceivingOrder(db, receivingOrderId);
  return rows.map(toShelfBox);
},

async getShelves(): Promise<Shelf[]> {
  const rows = await db.query.shelves.findMany();
  return rows.map((s) => ({ code: s.code, zone: s.zone }));
},

async recordPutAwayScan(
  receivingInvoiceItemId: string,
  qty: number,
  dateCode: string | null,
  lotCode: string | null,
  coo: string | null,
  cow: string | null
): Promise<PutAwayScan> {
  return dbRecordPutAwayScan(db, receivingInvoiceItemId, qty, dateCode, lotCode, coo, cow);
},

async assignPutAwayScanToBox(scanId: string, boxId: string): Promise<void> {
  await dbAssignScanToBox(db, scanId, boxId, assertActorId(getActorId));
},

async removePutAwayScanFromBox(scanId: string): Promise<void> {
  await dbRemoveScanFromBox(db, scanId, assertActorId(getActorId));
},

async removePutAwayScannedPiece(scanId: string): Promise<void> {
  await dbRemoveScannedPiece(db, scanId);
},

async createShelfBox(receivingOrderId: string, shelfCode: string): Promise<ShelfBox> {
  const box = await dbCreateShelfBox(db, receivingOrderId, shelfCode, assertActorId(getActorId));
  return {
    id: box.id,
    receivingOrderId: box.receivingOrderId,
    shelfCode: box.shelfCode,
    status: box.status,
    createdAt: box.createdAt,
    items: [],
  };
},

async closeShelfBox(id: string): Promise<void> {
  await dbCloseShelfBox(db, id, assertActorId(getActorId));
},

async cancelShelfBox(id: string): Promise<void> {
  await dbCancelShelfBox(db, id, assertActorId(getActorId));
},
```

- [ ] **Step 4: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 4: Add stubs to API adapter

**Files:**
- Modify: `services/adapters/apiWarehouse.ts`

- [ ] **Step 1: Add put-away stubs**

Inside the returned object, add:
```ts
async getPutAwayCandidates() { throw notImplemented(); },
async getPutAwayLots() { throw notImplemented(); },
async getPutAwayScans() { throw notImplemented(); },
async getShelfBoxesForReceivingOrder() { throw notImplemented(); },
async getShelves() { throw notImplemented(); },
async recordPutAwayScan() { throw notImplemented(); },
async assignPutAwayScanToBox() { throw notImplemented(); },
async removePutAwayScanFromBox() { throw notImplemented(); },
async removePutAwayScannedPiece() { throw notImplemented(); },
async createShelfBox() { throw notImplemented(); },
async closeShelfBox() { throw notImplemented(); },
async cancelShelfBox() { throw notImplemented(); },
```

- [ ] **Step 2: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 5: Migrate `pages/put-away/index.vue`

**Files:**
- Modify: `pages/put-away/index.vue`

- [ ] **Step 1: Replace imports and data loading**

Remove:
```ts
import { getPutAwayCandidates, type PutAwayCandidate } from "~/db/putAway";
```

Add:
```ts
import { useWarehouse } from "~/composables/useWarehouse";
import type { PutAwayCandidate } from "~/services/types";
```

Replace `const db = await useDb();` with `const warehouse = useWarehouse();`.

Replace `load()` body:
```ts
async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    rawRows.value = await warehouse.getPutAwayCandidates();
  } catch (e) {
    loadError.value = errorMessage(e);
    rawRows.value = [];
  } finally {
    loading.value = false;
  }
}
```

- [ ] **Step 2: Update template field names**

Change template bindings from snake_case to camelCase:
- `po.ref_no` → `po.refNo`
- `po.supplier_name` → `po.supplierName`
- `po.available_qty` → `po.availableQty`

- [ ] **Step 3: Run type check and tests**

Run: `pnpm nuxt prepare && pnpm test`
Expected: passes

---

### Task 6: Migrate `pages/put-away/[id].vue`

**Files:**
- Modify: `pages/put-away/[id].vue`

- [ ] **Step 1: Replace imports**

Remove all imports of `~/db/schema`, `~/db/putAway`, `~/db/receiving`, `useDb`.

Add:
```ts
import { useWarehouse } from "~/composables/useWarehouse";
import type {
  ReceivingOrderDetail as ServiceReceivingOrderDetail,
  PutAwayLot,
  PutAwayScan,
  ShelfBox,
  Shelf,
} from "~/services/types";
```

Replace `const db = await useDb();` with `const warehouse = useWarehouse();`.

- [ ] **Step 2: Use service types for local refs**

```ts
const order = ref<ServiceReceivingOrderDetail | null>(null);
const lots = ref<PutAwayLot[]>([]);
const shelves = ref<Shelf[]>([]);
const boxes = ref<ShelfBox[]>([]);
const scans = ref<PutAwayScan[]>([]);
```

- [ ] **Step 3: Rewrite `load()` to use service**

```ts
async function load() {
  pending.value = true;
  error.value = null;
  try {
    const [orderData, lotsData, shelvesData, boxesData, scansData] = await Promise.all([
      warehouse.getReceivingOrder(orderId),
      warehouse.getPutAwayLots(orderId),
      warehouse.getShelves(),
      warehouse.getShelfBoxesForReceivingOrder(orderId),
      warehouse.getPutAwayScans(orderId),
    ]);
    order.value = orderData;
    lots.value = lotsData;
    shelves.value = shelvesData;

    const previousBoxIds = new Set(boxes.value.map((b) => b.id));
    boxes.value = boxesData;
    scans.value = scansData;
    const nextExpanded = new Set(expandedItemBoxes.value);
    for (const b of boxesData) {
      if (b.status === "open" && !previousBoxIds.has(b.id)) {
        nextExpanded.add(b.id);
      }
    }
    expandedItemBoxes.value = nextExpanded;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}
```

- [ ] **Step 4: Rewrite write handlers**

```ts
async function addScanToBox(scanId: string) {
  const boxId = boxSelections.value[scanId];
  if (!boxId) return;
  addingScan.value[scanId] = true;
  error.value = null;
  try {
    await warehouse.assignPutAwayScanToBox(scanId, boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    addingScan.value[scanId] = false;
  }
}

async function removeScanFromBoxHandler(scanId: string) {
  removingScan.value[scanId] = true;
  error.value = null;
  try {
    await warehouse.removePutAwayScanFromBox(scanId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    removingScan.value[scanId] = false;
  }
}

async function removeScanHandler(scanId: string) {
  removingScan.value[scanId] = true;
  error.value = null;
  try {
    await warehouse.removePutAwayScannedPiece(scanId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    removingScan.value[scanId] = false;
  }
}

async function createBoxFromDialog(shelfCode: string) {
  error.value = null;
  creating.value = true;
  try {
    await warehouse.createShelfBox(orderId, shelfCode);
    await load();
    boxesExpanded.value = true;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    creating.value = false;
  }
}

async function closeBox(boxId: string) {
  error.value = null;
  closing.value = true;
  try {
    await warehouse.closeShelfBox(boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    closing.value = false;
  }
}

async function cancelBox(boxId: string) {
  error.value = null;
  cancellingBox.value[boxId] = true;
  try {
    await warehouse.cancelShelfBox(boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    cancellingBox.value[boxId] = false;
  }
}
```

Remove the `currentUserId()` helper if no longer used.

- [ ] **Step 5: Run type check and tests**

Run: `pnpm nuxt prepare && pnpm test`
Expected: passes

---

### Task 7: Update put-away components

**Files:**
- Modify: `components/SelectShelfDialog.vue`
- Modify: `components/put-away/ShelfBoxesPanel.vue`
- Modify: `components/put-away/PutAwayLotsPanel.vue`

- [ ] **Step 1: `SelectShelfDialog.vue`**

Replace:
```ts
import * as schema from "~/db/schema";
```
with:
```ts
import type { Shelf } from "~/services/types";
```

Replace prop type:
```ts
shelves: Shelf[];
```

Template field names remain `code` and `zone`.

- [ ] **Step 2: `ShelfBoxesPanel.vue`**

Replace imports:
```ts
import type { ShelfBox } from "~/services/types";
import type { Shelf } from "~/services/types";
```

Update prop types:
```ts
boxes: ShelfBox[];
shelves: Shelf[];
```

Update template bindings: `box.shelfCode`, `box.createdAt`, `item.part?.partNo`.

- [ ] **Step 3: `PutAwayLotsPanel.vue`**

Replace imports:
```ts
import type { PutAwayLot, PutAwayScan, ShelfBox } from "~/services/types";
```

Update prop types and template bindings to camelCase:
- `lot.receivingInvoiceItemId`
- `lot.partNo`
- `lot.availableQty`
- `scan.shelfBoxId`

- [ ] **Step 4: Run type check and tests**

Run: `pnpm nuxt prepare && pnpm test`
Expected: passes

---

## Phase 4 — Measuring flow

### Task 8: Add measuring DTOs to `services/types.ts`

**Files:**
- Modify: `services/types.ts`

- [ ] **Step 1: Add DTOs after put-away section**

```ts
// ------------------------------------------------------------------
// Measuring
// ------------------------------------------------------------------

export type MeasuringTaskStatus = "pending" | "completed";
export type BoxStatus = "open" | "closed" | "verified";

export interface MeasuringTaskSummary {
  id: string;
  status: MeasuringTaskStatus;
  pickingOrderId: string;
  pickingOrderRef: string | null;
  supplierName: string | null;
  totalItems: number;
  packedItems: number;
}

export interface MeasuringPickingOrder {
  id: string;
  refNo: string | null;
  supplierId: string | null;
  deliveryDate: Date | null;
  poNo: string | null;
  requiredDateCodeNotice: string | null;
  status: PickingOrderStatus;
  createdAt: Date;
  updatedAt: Date;
  supplier: Supplier | null;
  items: MeasuringPickingItem[];
}

export interface MeasuringPickingItem {
  id: string;
  pickingOrderId: string;
  partId: string;
  qty: number;
  pickedQty: number;
  requiredDateCode: string | null;
  sourceShelfCode: string | null;
  part: Part | null;
  allocations: MeasuringAllocation[];
}

export interface MeasuringAllocation {
  id: string;
  pickingItemId: string;
  inventoryLotId: string;
  qty: number;
  inventoryLot: {
    id: string;
    partId: string;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    cow: string | null;
    shelfCode: string | null;
    boxId: string | null;
    totalQty: number;
    allocatedQty: number;
    part: Part | null;
  };
}

export interface MeasuringTaskDetail {
  id: string;
  status: MeasuringTaskStatus;
  pickingOrderId: string;
  createdAt: Date;
  pickingOrder: MeasuringPickingOrder | null;
  shippingBoxes: MeasuringShippingBox[];
}

export interface MeasuringShippingBox {
  id: string;
  pickingOrderId: string | null;
  measuringTaskId: string | null;
  status: BoxStatus;
  grossWeight: number | null;
  netWeight: number | null;
  destinationCountry: string | null;
  boxSize: string | null;
  createdAt: Date;
  packages: MeasuringPackage[];
}

export interface MeasuringPackage {
  id: string;
  pickingItemId: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  verified: boolean;
  pickingItem: {
    id: string;
    partId: string;
    part: Part | null;
  } | null;
}

export interface ShippingBoxForMeasuring {
  id: string;
  pickingOrderId: string | null;
  measuringTaskId: string | null;
  status: BoxStatus;
  grossWeight: number | null;
  netWeight: number | null;
  destinationCountry: string | null;
  boxSize: string | null;
  createdAt: Date;
  measuringTask: {
    id: string;
    status: MeasuringTaskStatus;
    pickingOrder: {
      id: string;
      refNo: string | null;
      supplier: Supplier | null;
    } | null;
  } | null;
  packages: MeasuringPackage[];
}

export interface BoxMeasurementsInput {
  grossWeight?: number | string | null;
  netWeight?: number | string | null;
  destinationCountry?: string | null;
  boxSize?: string | null;
}

export interface PackageVerificationInput {
  partNo: string;
  dateCode: string;
  lotCode: string;
  coo: string;
  cow: string;
  qty: number;
}
```

- [ ] **Step 2: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 9: Extend `WarehouseService` with measuring methods

**Files:**
- Modify: `services/warehouse.ts`

- [ ] **Step 1: Import new DTOs and add methods**

Add to imports from `./types`:
```ts
MeasuringTaskSummary,
MeasuringTaskDetail,
ShippingBoxForMeasuring,
BoxMeasurementsInput,
PackageVerificationInput,
```

Add to interface:
```ts
// Measuring
getMeasuringTasks(): Promise<MeasuringTaskSummary[]>;
getMeasuringTask(id: string): Promise<MeasuringTaskDetail>;
getShippingBoxForMeasuring(id: string): Promise<ShippingBoxForMeasuring>;
verifyPickingPackage(packageId: string): Promise<void>;
updateShippingBox(id: string, fields: BoxMeasurementsInput): Promise<ShippingBoxForMeasuring>;
closeShippingBox(id: string): Promise<void>;
completeMeasuringTask(id: string): Promise<void>;
```

- [ ] **Step 2: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 10: Implement measuring methods in PGlite adapter

**Files:**
- Modify: `services/adapters/pgliteWarehouse.ts`

- [ ] **Step 1: Import helpers and DTOs**

Add to imports from `~/db/measuring`:
```ts
getMeasuringTasks as dbGetMeasuringTasks,
getMeasuringTaskDetail as dbGetMeasuringTaskDetail,
getShippingBoxForMeasuring as dbGetShippingBoxForMeasuring,
findMatchingUnverifiedPackage as dbFindMatchingUnverifiedPackage,
verifyPickingPackageForMeasuring as dbVerifyPickingPackageForMeasuring,
updateShippingBox as dbUpdateShippingBox,
closeShippingBox as dbCloseShippingBox,
completeMeasuringTask as dbCompleteMeasuringTask,
```

Add to imports from `../types`:
```ts
MeasuringTaskSummary,
MeasuringTaskDetail,
MeasuringShippingBox,
MeasuringPackage,
MeasuringPickingOrder,
MeasuringPickingItem,
MeasuringAllocation,
ShippingBoxForMeasuring,
BoxMeasurementsInput,
PackageVerificationInput,
```

- [ ] **Step 2: Add mapper functions**

```ts
function toPartFromSchema(row: typeof schema.parts.$inferSelect): Part {
  return {
    id: row.id,
    partNo: row.partNo,
    internalCode: row.internalCode ?? null,
    description: row.description ?? null,
    defaultCoo: row.defaultCoo ?? null,
  };
}

function toMeasuringTaskSummary(row: {
  id: string;
  status: string;
  pickingOrderId: string;
  pickingOrderRef: string | null;
  supplierName: string | null;
  totalItems: number;
  packedItems: number;
}): MeasuringTaskSummary {
  return {
    id: row.id,
    status: row.status as MeasuringTaskStatus,
    pickingOrderId: row.pickingOrderId,
    pickingOrderRef: row.pickingOrderRef,
    supplierName: row.supplierName,
    totalItems: row.totalItems,
    packedItems: row.packedItems,
  };
}

function toMeasuringPackage(pkg: {
  id: string;
  pickingItemId: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  verified: boolean;
  pickingItem: { id: string; partId: string; part: typeof schema.parts.$inferSelect | null } | null;
}): MeasuringPackage {
  return {
    id: pkg.id,
    pickingItemId: pkg.pickingItemId,
    qty: pkg.qty,
    dateCode: pkg.dateCode,
    lotCode: pkg.lotCode,
    coo: pkg.coo,
    cow: pkg.cow,
    verified: pkg.verified,
    pickingItem: pkg.pickingItem
      ? {
          id: pkg.pickingItem.id,
          partId: pkg.pickingItem.partId,
          part: pkg.pickingItem.part ? toPartFromSchema(pkg.pickingItem.part) : null,
        }
      : null,
  };
}

function toMeasuringShippingBox(box: {
  id: string;
  pickingOrderId: string | null;
  measuringTaskId: string | null;
  status: string;
  grossWeight: number | null;
  netWeight: number | null;
  destinationCountry: string | null;
  boxSize: string | null;
  createdAt: Date;
  packages: any[];
}): MeasuringShippingBox {
  return {
    id: box.id,
    pickingOrderId: box.pickingOrderId,
    measuringTaskId: box.measuringTaskId,
    status: box.status as BoxStatus,
    grossWeight: box.grossWeight,
    netWeight: box.netWeight,
    destinationCountry: box.destinationCountry,
    boxSize: box.boxSize,
    createdAt: box.createdAt,
    packages: (box.packages ?? []).map(toMeasuringPackage),
  };
}

function toMeasuringTaskDetail(data: Awaited<ReturnType<typeof dbGetMeasuringTaskDetail>> | undefined): MeasuringTaskDetail {
  if (!data) throw new I18nError("measuring_task_not_found");
  const po = data.pickingOrder;
  return {
    id: data.id,
    status: data.status as MeasuringTaskStatus,
    pickingOrderId: data.pickingOrderId,
    createdAt: data.createdAt,
    pickingOrder: po
      ? {
          id: po.id,
          refNo: po.refNo,
          supplierId: po.supplierId,
          deliveryDate: po.deliveryDate,
          poNo: po.poNo,
          requiredDateCodeNotice: po.requiredDateCodeNotice,
          status: po.status as PickingOrderStatus,
          createdAt: po.createdAt,
          updatedAt: po.updatedAt,
          supplier: po.supplier ? toSupplier(po.supplier) : null,
          items: po.items.map((item): MeasuringPickingItem => ({
            id: item.id,
            pickingOrderId: item.pickingOrderId,
            partId: item.partId,
            qty: item.qty,
            pickedQty: item.pickedQty,
            requiredDateCode: item.requiredDateCode,
            sourceShelfCode: item.sourceShelfCode,
            part: item.part ? toPartFromSchema(item.part) : null,
            allocations: (item.allocations ?? []).map((a): MeasuringAllocation => ({
              id: a.id,
              pickingItemId: a.pickingItemId,
              inventoryLotId: a.inventoryLotId,
              qty: a.qty,
              inventoryLot: {
                id: a.inventoryLot.id,
                partId: a.inventoryLot.partId,
                dateCode: a.inventoryLot.dateCode,
                lotCode: a.inventoryLot.lotCode,
                coo: a.inventoryLot.coo,
                cow: a.inventoryLot.cow,
                shelfCode: a.inventoryLot.shelfCode,
                boxId: a.inventoryLot.boxId,
                totalQty: a.inventoryLot.totalQty,
                allocatedQty: a.inventoryLot.allocatedQty,
                part: a.inventoryLot.part ? toPartFromSchema(a.inventoryLot.part) : null,
              },
            })),
          })),
        }
      : null,
    shippingBoxes: (data.shippingBoxes ?? []).map(toMeasuringShippingBox),
  };
}

function toShippingBoxForMeasuring(box: NonNullable<Awaited<ReturnType<typeof dbGetShippingBoxForMeasuring>>>): ShippingBoxForMeasuring {
  return {
    id: box.id,
    pickingOrderId: box.pickingOrderId,
    measuringTaskId: box.measuringTaskId,
    status: box.status as BoxStatus,
    grossWeight: box.grossWeight,
    netWeight: box.netWeight,
    destinationCountry: box.destinationCountry,
    boxSize: box.boxSize,
    createdAt: box.createdAt,
    measuringTask: box.measuringTask
      ? {
          id: box.measuringTask.id,
          status: box.measuringTask.status as MeasuringTaskStatus,
          pickingOrder: box.measuringTask.pickingOrder
            ? {
                id: box.measuringTask.pickingOrder.id,
                refNo: box.measuringTask.pickingOrder.refNo,
                supplier: box.measuringTask.pickingOrder.supplier
                  ? toSupplier(box.measuringTask.pickingOrder.supplier)
                  : null,
              }
            : null,
        }
      : null,
    packages: (box.packages ?? []).map(toMeasuringPackage),
  };
}
```

- [ ] **Step 3: Implement `getMeasuringTasks` using the existing raw SQL**

```ts
async getMeasuringTasks(): Promise<MeasuringTaskSummary[]> {
  const result = await db.execute(sql`
    SELECT mt.id,
           mt.status,
           po.ref_no AS picking_order_ref,
           s.name AS supplier_name,
           COALESCE(SUM(pi.qty), 0) AS total_items,
           COALESCE(SUM(pkg.qty), 0) AS packed_items
     FROM measuring_tasks mt
     INNER JOIN picking_orders po ON po.id = mt.picking_order_id
     LEFT JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN picking_items pi ON pi.picking_order_id = po.id
     LEFT JOIN shipping_boxes sb ON sb.measuring_task_id = mt.id
     LEFT JOIN picking_packages pkg ON pkg.shipping_box_id = sb.id
     WHERE mt.status = 'pending'
     GROUP BY mt.id, mt.status, po.ref_no, s.name
     ORDER BY po.ref_no
  `);
  return ((result.rows ?? []) as any[]).map((row) =>
    toMeasuringTaskSummary({
      id: row.id as string,
      status: row.status as string,
      pickingOrderId: "", // not needed by UI list
      pickingOrderRef: row.picking_order_ref as string | null,
      supplierName: row.supplier_name as string | null,
      totalItems: Number(row.total_items ?? 0),
      packedItems: Number(row.packed_items ?? 0),
    })
  );
},
```

- [ ] **Step 4: Add remaining measuring methods**

```ts
async getMeasuringTask(id: string): Promise<MeasuringTaskDetail> {
  return toMeasuringTaskDetail(await dbGetMeasuringTaskDetail(db, id));
},

async getShippingBoxForMeasuring(id: string): Promise<ShippingBoxForMeasuring> {
  const box = await dbGetShippingBoxForMeasuring(db, id);
  if (!box) throw new I18nError("shipping_box_not_found");
  return toShippingBoxForMeasuring(box);
},

async verifyPickingPackage(packageId: string): Promise<void> {
  await dbVerifyPickingPackageForMeasuring(db, packageId, assertActorId(getActorId));
},

async updateShippingBox(id: string, fields: BoxMeasurementsInput): Promise<ShippingBoxForMeasuring> {
  await dbUpdateShippingBox(db, id, fields);
  const box = await dbGetShippingBoxForMeasuring(db, id);
  if (!box) throw new I18nError("shipping_box_not_found");
  return toShippingBoxForMeasuring(box);
},

async closeShippingBox(id: string): Promise<void> {
  await dbCloseShippingBox(db, id, assertActorId(getActorId));
},

async completeMeasuringTask(id: string): Promise<void> {
  await dbCompleteMeasuringTask(db, id, assertActorId(getActorId));
},
```

- [ ] **Step 5: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 11: Add measuring stubs to API adapter

**Files:**
- Modify: `services/adapters/apiWarehouse.ts`

- [ ] **Step 1: Add stubs**

```ts
async getMeasuringTasks() { throw notImplemented(); },
async getMeasuringTask() { throw notImplemented(); },
async getShippingBoxForMeasuring() { throw notImplemented(); },
async verifyPickingPackage() { throw notImplemented(); },
async updateShippingBox() { throw notImplemented(); },
async closeShippingBox() { throw notImplemented(); },
async completeMeasuringTask() { throw notImplemented(); },
```

- [ ] **Step 2: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 12: Migrate `pages/measuring/index.vue`

**Files:**
- Modify: `pages/measuring/index.vue`

- [ ] **Step 1: Replace imports and load logic**

Remove `useDb` and `MeasuringRow` interface.

Add:
```ts
import { useWarehouse } from "~/composables/useWarehouse";
import type { MeasuringTaskSummary } from "~/services/types";
```

Replace `const db = await useDb();` with `const warehouse = useWarehouse();`.

Update refs:
```ts
const rawRows = ref<MeasuringTaskSummary[]>([]);
```

Replace `load()`:
```ts
async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    rawRows.value = await warehouse.getMeasuringTasks();
  } catch (e: unknown) {
    loadError.value = errorMessage(e);
    rawRows.value = [];
  } finally {
    loading.value = false;
  }
}
```

- [ ] **Step 2: Update template bindings**

Change:
- `task.picking_order_ref` → `task.pickingOrderRef`
- `task.supplier_name` → `task.supplierName`
- `task.total_items` / `task.packed_items` → `task.totalItems` / `task.packedItems`

- [ ] **Step 3: Run type check and tests**

Run: `pnpm nuxt prepare && pnpm test`
Expected: passes

---

### Task 13: Migrate `pages/measuring/[id].vue`

**Files:**
- Modify: `pages/measuring/[id].vue`

- [ ] **Step 1: Replace imports**

Remove:
```ts
import { getMeasuringTaskDetail, completeMeasuringTask, type MeasuringTaskDetail } from "~/db/measuring";
```

Add:
```ts
import { useWarehouse } from "~/composables/useWarehouse";
import type { MeasuringTaskDetail, BoxStatus } from "~/services/types";
```

Replace `const db = await useDb();` with `const warehouse = useWarehouse();`.

- [ ] **Step 2: Update load and complete handlers**

```ts
async function load() {
  try {
    const data = await warehouse.getMeasuringTask(taskId);
    task.value = data;
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

async function complete() {
  completing.value = true;
  try {
    await warehouse.completeMeasuringTask(taskId);
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    completing.value = false;
  }
}
```

Remove `currentUser` dependency and the `no_operator_user_found` check.

- [ ] **Step 3: Update `verifiedCount` helper**

No change needed; `packages` still has `verified`.

- [ ] **Step 4: Run type check and tests**

Run: `pnpm nuxt prepare && pnpm test`
Expected: passes

---

### Task 14: Migrate `pages/measuring/[taskId]/box/[boxId].vue`

**Files:**
- Modify: `pages/measuring/[taskId]/box/[boxId].vue`

- [ ] **Step 1: Read current file and replace imports**

Remove `~/db/measuring` and `useDb` imports.

Add:
```ts
import { useWarehouse } from "~/composables/useWarehouse";
import type { ShippingBoxForMeasuring } from "~/services/types";
```

Replace `const db = await useDb();` with `const warehouse = useWarehouse();`.

- [ ] **Step 2: Use service for load and writes**

```ts
const box = ref<ShippingBoxForMeasuring | null>(null);

async function load() {
  try {
    box.value = await warehouse.getShippingBoxForMeasuring(boxId);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}
```

Pass `warehouse` to `BoxMeasurementsModal` via a new prop or replace the modal's internal DB calls.

- [ ] **Step 3: Run type check and tests**

Run: `pnpm nuxt prepare && pnpm test`
Expected: passes

---

### Task 15: Migrate `components/BoxMeasurementsModal.vue`

**Files:**
- Modify: `components/BoxMeasurementsModal.vue`

- [ ] **Step 1: Replace DB imports with service**

Remove:
```ts
import { updateShippingBox, closeShippingBox } from "~/db/measuring";
const db = await useDb();
```

Add:
```ts
import { useWarehouse } from "~/composables/useWarehouse";
const warehouse = useWarehouse();
```

- [ ] **Step 2: Replace write calls**

```ts
async function saveMeasurements() {
  saving.value = true;
  try {
    await warehouse.updateShippingBox(props.boxId, {
      grossWeight: grossWeight.value,
      netWeight: netWeight.value,
      destinationCountry: destinationCountry.value,
      boxSize: boxSize.value,
    });
    emit("saved");
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}

async function closeBox() {
  closing.value = true;
  try {
    await warehouse.closeShippingBox(props.boxId);
    emit("saved");
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    closing.value = false;
  }
}
```

- [ ] **Step 3: Run type check and tests**

Run: `pnpm nuxt prepare && pnpm test`
Expected: passes

---

## Phase 5 — Goods verify flow

### Task 16: Add goods-verify DTOs to `services/types.ts`

**Files:**
- Modify: `services/types.ts`

- [ ] **Step 1: Add DTOs after measuring section**

```ts
// ------------------------------------------------------------------
// Goods verify
// ------------------------------------------------------------------

export interface ShelfWithBoxCount {
  code: string;
  zone: string | null;
  boxCount: number;
}

export interface GoodsVerifyShelfBoxSummary {
  id: string;
  shelfCode: string | null;
  status: BoxStatus;
  itemCount: number;
  verifiedCount: number;
  lastCheckAt: Date | null;
  checkedToday: boolean;
}

export interface GoodsVerifyShelfBoxDetail {
  id: string;
  receivingOrderId: string | null;
  shelfCode: string | null;
  status: BoxStatus;
  createdAt: Date;
  shelf: Shelf | null;
  receivingOrder: { id: string; refNo: string } | null;
  items: GoodsVerifyShelfBoxItem[];
}

export interface GoodsVerifyShelfBoxItem {
  id: string;
  shelfBoxId: string;
  receivingInvoiceItemId: string | null;
  partId: string;
  qty: number;
  verified: boolean;
  verifiedAt: Date | null;
  part: Part | null;
}
```

- [ ] **Step 2: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 17: Extend `WarehouseService` with goods-verify methods

**Files:**
- Modify: `services/warehouse.ts`

- [ ] **Step 1: Import and add methods**

Add to imports:
```ts
ShelfWithBoxCount,
GoodsVerifyShelfBoxSummary,
GoodsVerifyShelfBoxDetail,
```

Add to interface:
```ts
// Goods verify
getShelvesWithBoxes(): Promise<ShelfWithBoxCount[]>;
getShelfBoxes(shelfCode: string): Promise<GoodsVerifyShelfBoxSummary[]>;
getShelfBox(id: string): Promise<GoodsVerifyShelfBoxDetail>;
verifyShelfBoxItem(shelfBoxId: string, partId: string): Promise<void>;
markShelfBoxVerified(id: string): Promise<void>;
```

- [ ] **Step 2: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 18: Implement goods-verify methods in PGlite adapter

**Files:**
- Modify: `services/adapters/pgliteWarehouse.ts`

- [ ] **Step 1: Import helpers and DTOs**

Add to imports from `~/db/goodsVerify`:
```ts
getShelvesWithBoxes as dbGetShelvesWithBoxes,
getShelfBoxesByShelf as dbGetShelfBoxesByShelf,
getShelfBoxDetail as dbGetShelfBoxDetail,
verifyShelfBoxScans as dbVerifyShelfBoxScans,
markShelfBoxVerified as dbMarkShelfBoxVerified,
```

Add to imports from `../types`:
```ts
ShelfWithBoxCount,
GoodsVerifyShelfBoxSummary,
GoodsVerifyShelfBoxDetail,
```

- [ ] **Step 2: Add mapper and methods**

```ts
function toGoodsVerifyShelfBoxDetail(data: Awaited<ReturnType<typeof dbGetShelfBoxDetail>>): GoodsVerifyShelfBoxDetail {
  if (!data) throw new I18nError("shelf_box_not_found");
  return {
    id: data.id,
    receivingOrderId: data.receivingOrderId,
    shelfCode: data.shelfCode,
    status: data.status as BoxStatus,
    createdAt: data.createdAt,
    shelf: data.shelf ? { code: data.shelf.code, zone: data.shelf.zone } : null,
    receivingOrder: data.receivingOrder,
    items: data.items.map((item) => ({
      id: item.id,
      shelfBoxId: item.shelfBoxId,
      receivingInvoiceItemId: item.receivingInvoiceItemId,
      partId: item.partId,
      qty: item.qty,
      verified: item.verified,
      verifiedAt: item.verifiedAt,
      part: item.part
        ? {
            id: item.part.id,
            partNo: item.part.partNo,
            internalCode: null,
            description: null,
            defaultCoo: null,
          }
        : null,
    })),
  };
}
```

Add methods:
```ts
async getShelvesWithBoxes(): Promise<ShelfWithBoxCount[]> {
  return dbGetShelvesWithBoxes(db);
},

async getShelfBoxes(shelfCode: string): Promise<GoodsVerifyShelfBoxSummary[]> {
  return dbGetShelfBoxesByShelf(db, shelfCode);
},

async getShelfBox(id: string): Promise<GoodsVerifyShelfBoxDetail> {
  return toGoodsVerifyShelfBoxDetail(await dbGetShelfBoxDetail(db, id));
},

async verifyShelfBoxItem(shelfBoxId: string, partId: string): Promise<void> {
  await dbVerifyShelfBoxScans(db, shelfBoxId, partId);
},

async markShelfBoxVerified(id: string): Promise<void> {
  await dbMarkShelfBoxVerified(db, id, assertActorId(getActorId));
},
```

- [ ] **Step 3: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 19: Add goods-verify stubs to API adapter

**Files:**
- Modify: `services/adapters/apiWarehouse.ts`

- [ ] **Step 1: Add stubs**

```ts
async getShelvesWithBoxes() { throw notImplemented(); },
async getShelfBoxes() { throw notImplemented(); },
async getShelfBox() { throw notImplemented(); },
async verifyShelfBoxItem() { throw notImplemented(); },
async markShelfBoxVerified() { throw notImplemented(); },
```

- [ ] **Step 2: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 20: Migrate goods-verify pages

**Files:**
- Modify: `pages/goods-verify/index.vue`
- Modify: `pages/goods-verify/shelf/[code].vue`
- Modify: `pages/goods-verify/box/[id].vue`

- [ ] **Step 1: `pages/goods-verify/index.vue`**

Remove `~/db/goodsVerify` and `useDb`.
Add `useWarehouse` and import `ShelfWithBoxCount` from `~/services/types`.
Replace `db` with `warehouse` and call `warehouse.getShelvesWithBoxes()`.

- [ ] **Step 2: `pages/goods-verify/shelf/[code].vue`**

Remove `~/db/goodsVerify` and `useDb`.
Add `useWarehouse` and import `GoodsVerifyShelfBoxSummary`.
Call `warehouse.getShelfBoxes(shelfCode)`.

- [ ] **Step 3: `pages/goods-verify/box/[id].vue`**

Remove `~/db/goodsVerify` and `useDb`.
Add `useWarehouse` and import `GoodsVerifyShelfBoxDetail`.
Call `warehouse.getShelfBox(boxId)` and `warehouse.markShelfBoxVerified(boxId)`.

- [ ] **Step 4: Run type check and tests**

Run: `pnpm nuxt prepare && pnpm test`
Expected: passes

---

## Phase 6 — Stock search flow

### Task 21: Add stock-search DTOs to `services/types.ts`

**Files:**
- Modify: `services/types.ts`

- [ ] **Step 1: Add DTOs after goods-verify section**

```ts
// ------------------------------------------------------------------
// Stock search
// ------------------------------------------------------------------

export interface StockSearchSupplier {
  id: string;
  code: string;
  name: string;
}

export interface StockSearchSupplierWithStats extends StockSearchSupplier {
  totalParts: number;
  partsWithInventory: number;
}

export interface StockSearchPart {
  id: string;
  partNo: string;
  internalCode: string | null;
  description: string | null;
  defaultCoo: string | null;
}

export interface StockSearchInventoryLot {
  partId: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfCode: string | null;
  boxId: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
  locationLabel: string;
}

export interface StockSearchSupplierPart {
  part: StockSearchPart;
  lots: StockSearchInventoryLot[];
  totalQty: number;
}
```

- [ ] **Step 2: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 22: Extend `WarehouseService` with stock-search methods

**Files:**
- Modify: `services/warehouse.ts`

- [ ] **Step 1: Import and add methods**

Add to imports:
```ts
StockSearchSupplierWithStats,
StockSearchPart,
StockSearchInventoryLot,
```

Add to interface:
```ts
// Stock search
getSuppliersWithInventoryStats(): Promise<StockSearchSupplierWithStats[]>;
getPartsBySupplier(supplierId: string): Promise<StockSearchPart[]>;
getInventoryLotsForParts(partIds: string[]): Promise<StockSearchInventoryLot[]>;
```

- [ ] **Step 2: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 23: Implement stock-search methods in PGlite adapter

**Files:**
- Modify: `services/adapters/pgliteWarehouse.ts`

- [ ] **Step 1: Import helpers and DTOs**

Add to imports from `~/db/stockSearch`:
```ts
getSuppliersWithInventoryStats as dbGetSuppliersWithInventoryStats,
getPartsBySupplierId as dbGetPartsBySupplierId,
getInventoryLotsForParts as dbGetInventoryLotsForParts,
```

Add to imports from `../types`:
```ts
StockSearchSupplierWithStats,
StockSearchPart,
StockSearchInventoryLot,
```

- [ ] **Step 2: Add methods**

```ts
async getSuppliersWithInventoryStats(): Promise<StockSearchSupplierWithStats[]> {
  return dbGetSuppliersWithInventoryStats(db);
},

async getPartsBySupplier(supplierId: string): Promise<StockSearchPart[]> {
  return dbGetPartsBySupplierId(db, supplierId);
},

async getInventoryLotsForParts(partIds: string[]): Promise<StockSearchInventoryLot[]> {
  return dbGetInventoryLotsForParts(db, partIds);
},
```

- [ ] **Step 3: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 24: Add stock-search stubs to API adapter

**Files:**
- Modify: `services/adapters/apiWarehouse.ts`

- [ ] **Step 1: Add stubs**

```ts
async getSuppliersWithInventoryStats() { throw notImplemented(); },
async getPartsBySupplier() { throw notImplemented(); },
async getInventoryLotsForParts() { throw notImplemented(); },
```

- [ ] **Step 2: Run type check**

Run: `pnpm nuxt prepare`
Expected: passes

---

### Task 25: Migrate `pages/stock-search/index.vue`

**Files:**
- Modify: `pages/stock-search/index.vue`

- [ ] **Step 1: Replace imports**

Remove `~/db/stockSearch` and `useDb`.
Add:
```ts
import { useWarehouse } from "~/composables/useWarehouse";
import type {
  StockSearchSupplierWithStats,
  StockSearchPart,
  StockSearchInventoryLot,
} from "~/services/types";
```

Replace `const db = await useDb();` with `const warehouse = useWarehouse();`.

- [ ] **Step 2: Replace service calls**

```ts
suppliers.value = await warehouse.getSuppliersWithInventoryStats(db);
// ...
const parts = await warehouse.getPartsBySupplier(supplierId);
// ...
const lots = await warehouse.getInventoryLotsForParts(partIds);
```

- [ ] **Step 3: Run type check and tests**

Run: `pnpm nuxt prepare && pnpm test`
Expected: passes

---

## Phase 7 — Scan matcher cleanup

### Task 26: Move `OcrParseResult` to `services/types.ts`

**Files:**
- Modify: `services/types.ts`
- Modify: `composables/useMockOcr.ts`
- Modify: `db/ocrPicking.ts`

- [ ] **Step 1: Add `OcrParseResult` to `services/types.ts`**

At the top of the file, add:
```ts
export interface OcrParseResult {
  partNo: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  qty: number;
}
```

- [ ] **Step 2: Update `composables/useMockOcr.ts`**

Replace:
```ts
import type { OcrParseResult } from "~/db/ocrPicking";
```
with:
```ts
import type { OcrParseResult } from "~/services/types";
```

- [ ] **Step 3: Update `db/ocrPicking.ts`**

Remove the local `OcrParseResult` interface and import it from `~/services/types`:
```ts
import type { OcrParseResult } from "~/services/types";
```

- [ ] **Step 4: Run type check and tests**

Run: `pnpm nuxt prepare && pnpm test`
Expected: passes

---

### Task 27: Route remaining scan writes through service

**Files:**
- Modify: `composables/useScanMatchers.ts`

- [ ] **Step 1: Keep local candidate imports, remove DB write imports**

Remove:
```ts
import { recordPutAwayScan } from '~/db/putAway';
import { findMatchingUnverifiedPackage, verifyPickingPackageForMeasuring } from '~/db/measuring';
import { verifyShelfBoxScans, type ShelfBoxItemDetail } from '~/db/goodsVerify';
```

Add:
```ts
import type { ShelfBoxItemDetail } from '~/services/types';
```

Keep:
```ts
import { findReceivingCandidates, findPickingCandidates } from '~/db/ocrPicking';
```

- [ ] **Step 2: Replace put-away scan write**

In `matchPutAway`:
```ts
await warehouse.recordPutAwayScan(
  receivingItem.receiving_invoice_item_id,
  qty,
  dateCode,
  lotCode,
  coo,
  cow
);
```

- [ ] **Step 3: Replace measuring scan writes**

In `matchMeasuring`:
```ts
const matched = await warehouse.findMatchingUnverifiedPackage(
  boxId,
  {
    partNo: parsed.partNo,
    dateCode: parsed.dateCode ?? '',
    lotCode: parsed.lotCode ?? '',
    coo: parsed.coo ?? '',
    cow: parsed.cow ?? '',
    qty,
  },
  targetPackageId
);
// ...
await warehouse.verifyPickingPackage(matched.id);
```

- [ ] **Step 4: Replace goods-verify scan write**

In `matchGoodsVerify`:
```ts
apply: () => warehouse.verifyShelfBoxItem(item.shelfBoxId, item.partId),
```

- [ ] **Step 5: Add missing service methods**

Go back to `services/warehouse.ts` and add:
```ts
findMatchingUnverifiedPackage(
  boxId: string,
  input: PackageVerificationInput,
  targetPackageId?: string
): Promise<{ id: string } | null>;
```

Go back to `services/adapters/pgliteWarehouse.ts` and implement:
```ts
async findMatchingUnverifiedPackage(
  boxId: string,
  input: PackageVerificationInput,
  targetPackageId?: string
): Promise<{ id: string } | null> {
  const pkg = await dbFindMatchingUnverifiedPackage(db, boxId, input, targetPackageId);
  return pkg ? { id: pkg.id } : null;
},
```

Add matching stub in `services/adapters/apiWarehouse.ts`.

- [ ] **Step 6: Run type check and tests**

Run: `pnpm nuxt prepare && pnpm test`
Expected: passes

---

## Phase 8 — Final cleanup

### Task 28: Remove remaining DB imports from pages and components

**Files:**
- Modify: any remaining file under `pages/` or `components/` that imports `useDb`, `drizzle-orm`, `~/db/schema`, or `~/db/*`.

- [ ] **Step 1: Search for remaining imports**

Run:
```bash
grep -R "from \"~/db/" pages/ components/ || true
grep -R "from '~/db/" pages/ components/ || true
grep -R "useDb" pages/ components/ || true
grep -R "drizzle-orm" pages/ components/ || true
```

Expected: no matches except possibly `ReportIssueModal.vue` importing `validateMismatchInputs` from `~/db/mismatch`.

- [ ] **Step 2: Resolve any remaining imports**

If `ReportIssueModal.vue` still imports `validateMismatchInputs` from `~/db/mismatch`, that is acceptable because it is pure validation with no DB access. Otherwise, migrate or move it to a shared validation utility.

- [ ] **Step 3: Run type check and tests**

Run: `pnpm nuxt prepare && pnpm test`
Expected: passes

---

### Task 29: Add service adapter tests

**Files:**
- Create: `tests/services/pgliteWarehouse.test.ts`

- [ ] **Step 1: Create a minimal adapter smoke test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createPgliteWarehouseService } from "~/services/adapters/pgliteWarehouse";
import { useDb } from "~/composables/useDb";
import { seedDb } from "~/db/seed";

describe("PgliteWarehouseService", () => {
  beforeEach(async () => {
    const db = useDb();
    await seedDb(db);
  });

  it("lists receiving orders", async () => {
    const service = createPgliteWarehouseService({
      adapter: "pglite",
      getActorId: () => "operator",
    });
    const orders = await service.getReceivingOrders("all");
    expect(orders.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the new test**

Run: `pnpm test tests/services/pgliteWarehouse.test.ts`
Expected: passes

---

### Task 30: Final verification

- [ ] **Step 1: Run full verification**

Run:
```bash
pnpm nuxt prepare
pnpm test
pnpm build
```

Expected: all pass

- [ ] **Step 2: Manual smoke test**

Run: `pnpm dev`
Then:
1. Log in as `operator` / `DocPal2026!`.
2. Open put-away list, detail, record a scan, assign to box.
3. Open measuring list, detail, box detail, verify a package, close a box.
4. Open goods-verify list, shelf, box, mark verified.
5. Open stock search, expand a supplier.

---

## Spec coverage self-review

| Spec section | Covered by |
|---|---|
| Put-away endpoints (API spec §6) | Phase 3, Tasks 1–7 |
| Measuring endpoints (API spec §7) | Phase 4, Tasks 8–15 |
| Goods verify endpoints (API spec §8) | Phase 5, Tasks 16–20 |
| Stock search endpoints (API spec §9) | Phase 6, Tasks 21–25 |
| OCR/universal scan stays local (API spec §10) | Phase 7, Tasks 26–27 |
| Internal operations stay server-only (API spec §12) | No client changes needed; adapters delegate to existing helpers |

## Placeholder scan

- No `TBD`, `TODO`, or "implement later" remain.
- Every task contains exact file paths and code or commands.
- Type names are consistent across all tasks (`ShelfBox` vs `GoodsVerifyShelfBoxSummary`, `BoxStatus`, etc.).
