# Implementation Plan — Frontend Service / Repository Layer

**Date:** 2026-07-07  
**Goal:** Decouple the Nuxt UI from PGlite/Drizzle by introducing a typed service layer, so the app can run against either the local demo DB or a real backend API without changing pages/components.

**Depends on:** `docs/superpowers/specs/2026-07-07-api-endpoints-design.md`

---

## 1. Design decisions

### 1.1 Service vs. repository

Use a single **service interface** per domain. The service is the only thing pages/components/composables call. Behind it we keep **adapter** implementations:

- `PgliteWarehouseService` — uses the existing `db/*.ts` helpers and PGlite transactions.
- `ApiWarehouseService` — uses `$fetch` to call the backend endpoints from the API spec.

This is simpler than separate repository + service layers and matches the project’s preference for explicit, readable code.

### 1.2 Plain TypeScript services, thin Vue composables

- `services/warehouse.ts` — interface + factory.
- `services/adapters/pgliteWarehouse.ts` and `services/adapters/apiWarehouse.ts` — implementations.
- `composables/useWarehouse.ts` — thin composable that picks the adapter from runtime config and injects the current user resolver.

Pages should import service methods either directly or via `useWarehouse()`.

### 1.3 Auth is its own service

`useAuth` currently talks to PGlite directly. Split it:

- `services/auth.ts` — `AuthService` interface.
- `services/adapters/pgliteAuth.ts` — local demo login.
- `services/adapters/apiAuth.ts` — login/logout/me against the API.
- `composables/useAuth.ts` — becomes a thin wrapper around `AuthService` plus `localStorage` session storage.

### 1.4 No Drizzle types in the UI

- Move all page-level DTO types into `services/types.ts`.
- Remove `import { sql } from "drizzle-orm"`, `import * as schema from "~/db/schema"`, and `import { useDb } from "~/composables/useDb"` from pages/components.
- `db/*.ts` helpers are still used, but only inside the PGlite adapter and server-side logic.

### 1.5 actorId comes from auth state, not request bodies

Service implementations receive a `getActorId: () => string | undefined` callback. The `useWarehouse()` composable passes `() => useAuth().currentUser.value?.id`. This keeps actor resolution in one place and prevents the UI from passing it around.

### 1.6 Scan matcher stays local

The OCR/universal scan matcher (`composables/useScanMatchers.ts`) does **not** become an API call. It will continue to run on-device, using data already loaded from the service (e.g. receiving order detail, put-away lots). The write actions it triggers still go through the warehouse service.

> Gotcha: in API-only mode, the matcher needs the relevant order/item data available locally before scanning. We will preload the detail page data; no separate scan-search endpoints are needed.

---

## 2. File structure

```
services/
  types.ts                 # Shared DTOs (replaces page-local interfaces)
  warehouse.ts             # WarehouseService interface + createWarehouseService()
  auth.ts                  # AuthService interface + createAuthService()
  adapters/
    pgliteWarehouse.ts     # Local DB adapter
    apiWarehouse.ts        # HTTP adapter (stubbed until backend is ready)
    pgliteAuth.ts          # Local demo auth
    apiAuth.ts             # API auth
composables/
  useWarehouse.ts          # Returns configured WarehouseService
  useAuth.ts               # Rewritten to use AuthService
```

Existing files to keep but narrow their scope:

- `db/*.ts` — business logic used only by `PgliteWarehouseService` and tests.
- `plugins/pglite.client.ts` — still bootstraps the local DB for PGlite mode.
- `composables/useDb.ts` — still used by `PgliteWarehouseService` and tests; removed from pages.

---

## 3. Runtime configuration

Add to `nuxt.config.ts`:

```ts
runtimeConfig: {
  public: {
    warehouseAdapter: "pglite", // "pglite" | "api"
    apiBaseUrl: "",             // e.g. "https://warehouse-api.example.com/api/v1"
  },
},
```

This lets us switch modes with env vars at build time:

```bash
NUXT_PUBLIC_WAREHOUSE_ADAPTER=api
NUXT_PUBLIC_API_BASE_URL=https://...
```

---

## 4. Core interfaces (outline)

### 4.1 `services/types.ts`

Define plain DTOs such as:

- `User`
- `ReceivingOrderSummary`, `ReceivingOrderDetail`
- `ReceivingItem`, `ReceivingItemMismatch`
- `PickingOrderSummary`, `PickingOrderDetail`
- `PickingItem`, `PickingAllocation`, `PickingPackage`, `ShippingBox`
- `PutAwayCandidate`, `PutAwayLot`, `PutAwayScan`
- `Shelf`, `ShelfBoxSummary`, `ShelfBoxDetail`, `ShelfBoxItem`
- `MeasuringTaskSummary`, `MeasuringTaskDetail`
- `StockSearchSupplier`, `StockSearchPart`, `StockSearchInventoryLot`
- `TransitionLog`

These should mirror the shapes the UI already expects, but without Drizzle-specific types.

### 4.2 `services/warehouse.ts`

```ts
export interface WarehouseService {
  // Receiving
  getReceivingOrders(filter: ReceivingFilter): Promise<ReceivingOrderSummary[]>;
  getReceivingOrder(id: string): Promise<ReceivingOrderDetail>;
  confirmReceivingOrderArrived(id: string): Promise<void>;

  // Mismatches
  getActiveMismatch(itemId: string): Promise<ReceivingItemMismatch | null>;
  reportMismatch(itemId: string, input: ReportMismatchInput): Promise<void>;
  editMismatch(mismatchId: string, input: ReportMismatchInput): Promise<void>;
  confirmMismatch(mismatchId: string): Promise<void>;
  cancelMismatch(mismatchId: string): Promise<void>;

  // Picking
  getPickingOrders(): Promise<PickingOrderSummary[]>;
  getPickingOrder(id: string): Promise<PickingOrderDetail>;
  finishPickingOrder(id: string): Promise<void>;
  reportPickingOrderIssues(entries: IssueEntry[], input: IssueInput): Promise<ReportIssueResult>;

  // Picking scanning / packages / boxes
  materializeAllocation(id: string, input: MaterializeInput): Promise<string>;
  scanAllocation(id: string, qty: number): Promise<string>;
  removeScannedPackage(id: string): Promise<void>;
  addPackageToBox(packageId: string, boxId: string): Promise<void>;
  removePackageFromBox(id: string): Promise<void>;
  addAllUnboxedPackagesToBox(boxId: string): Promise<number>;
  createShippingBox(pickingOrderId: string): Promise<string>;
  cancelShippingBox(id: string): Promise<void>;

  // Put-away
  getPutAwayCandidates(): Promise<PutAwayCandidate[]>;
  getPutAwayLots(receivingOrderId: string): Promise<PutAwayLot[]>;
  getPutAwayScans(receivingOrderId: string): Promise<PutAwayScan[]>;
  getShelfBoxesForReceivingOrder(id: string): Promise<ShelfBoxSummary[]>;
  getShelves(): Promise<Shelf[]>;
  recordPutAwayScan(input: RecordPutAwayScanInput): Promise<PutAwayScan>;
  assignPutAwayScanToBox(scanId: string, boxId: string): Promise<void>;
  removeScanFromBox(scanId: string): Promise<void>;
  removeScannedPiece(scanId: string, qty: number): Promise<void>;
  createShelfBox(receivingOrderId: string): Promise<string>;
  cancelShelfBox(id: string): Promise<void>;
  closeShelfBox(id: string): Promise<void>;

  // Measuring
  getMeasuringTasks(): Promise<MeasuringTaskSummary[]>;
  getMeasuringTask(id: string): Promise<MeasuringTaskDetail>;
  getShippingBoxForMeasuring(id: string): Promise<ShippingBoxForMeasuring>;
  verifyPickingPackage(packageId: string): Promise<void>;
  updateShippingBox(id: string, fields: BoxMeasurementsInput): Promise<ShippingBox>;
  closeShippingBox(id: string): Promise<void>;
  completeMeasuringTask(id: string): Promise<void>;

  // Goods verify
  getShelvesWithBoxes(): Promise<ShelfWithBoxCount[]>;
  getShelfBoxes(shelfCode: string): Promise<ShelfBoxSummary[]>;
  getShelfBox(id: string): Promise<ShelfBoxDetail>;
  verifyShelfBoxItem(shelfBoxId: string, itemId: string): Promise<void>;
  markShelfBoxVerified(id: string): Promise<void>;

  // Stock search
  getSuppliersWithInventoryStats(): Promise<StockSearchSupplier[]>;
  getPartsBySupplier(supplierId: string): Promise<StockSearchPart[]>;
  getInventoryLotsForParts(partIds: string[]): Promise<StockSearchInventoryLot[]>;

  // Logs / helpers
  getPickingItemTransitionLogs(ids: string[]): Promise<TransitionLog[]>;
}
```

### 4.3 `services/auth.ts`

```ts
export interface AuthService {
  login(username: string, password: string): Promise<User>;
  logout(): Promise<void>;
  getCurrentUser(): Promise<User | null>;
}
```

---

## 5. Migration phases

### Phase 1 — Bootstrap the service layer (no UI changes)

Files to create:

- `services/types.ts`
- `services/warehouse.ts`
- `services/auth.ts`
- `services/adapters/pgliteAuth.ts`
- `services/adapters/pgliteWarehouse.ts` — implement a few methods, throw `not implemented` for the rest.
- `composables/useWarehouse.ts`
- Update `nuxt.config.ts` with runtime config.

Update:

- `composables/useAuth.ts` — wrap `AuthService` from `createAuthService()`.
- `pages/login.vue` — use `useAuth().login()` (interface stays the same).

Verification: app still runs in PGlite mode; login and one page still work.

### Phase 2 — Receiving flow end-to-end

Move all receiving-related DB calls behind the service:

- `services/adapters/pgliteWarehouse.ts`:
  - Implement receiving list/detail using `getReceivingOrdersWithSupplier`, `getReceivingOrderDetail`, and the raw aggregations currently in `pages/receiving/index.vue` and `pages/receiving/[id].vue`.
- Update `pages/receiving/index.vue`:
  - Remove `useDb`, `drizzle-orm/sql`, `availableReceivingQtySql`, `allocationsCte`.
  - Use `warehouse.getReceivingOrders(filter)`.
- Update `pages/receiving/[id].vue`:
  - Remove raw SQL queries; call `warehouse.getReceivingOrder(id)` which returns the fully aggregated detail.
- Update mismatch reporting/confirmation in the receiving detail to use service methods.

Verification: receiving list, detail, arrive, mismatch report/confirm all still work.

### Phase 3 — Picking flow

- Move `pages/picking/index.vue` raw SQL into `getPickingOrders()`.
- Move `pages/picking/[id].vue` detail/scans/box actions into service methods.
- Implement scanning/package/box methods in the PGlite adapter using existing `db/picking.ts` helpers.

Verification: picking list, detail, scan, box create/cancel/add/remove, finish, issue report all work.

### Phase 4 — Put-away flow

- Move `pages/put-away/index.vue` and `pages/put-away/[id].vue` DB calls into service methods.
- Implement put-away scan/shelf-box methods using `db/putAway.ts` helpers.

Verification: put-away candidates, scan, assign to box, create/close/cancel shelf boxes all work.

### Phase 5 — Measuring and goods-verify

- Move `pages/measuring/*.vue` into service methods using `db/measuring.ts`.
- Move `pages/goods-verify/*.vue` into service methods using `db/goodsVerify.ts`.

Verification: measuring tasks, box measurements, verify/close/complete, goods verify shelves/boxes all work.

### Phase 6 — Stock search

- Move `pages/stock-search/index.vue` queries into service methods using `db/stockSearch.ts`.

Verification: supplier list, parts, inventory lots all display.

### Phase 7 — Remove UI-side Drizzle imports

- Search the `pages/` and `components/` directories for remaining `useDb()`, `db.execute`, `drizzle-orm` imports, and `db/schema` imports.
- Move any leftover logic into the PGlite adapter.
- Delete page-local DTO interfaces that are now in `services/types.ts`.

### Phase 8 — API adapter

Once the backend implements the endpoints from the API spec:

- Implement `services/adapters/apiWarehouse.ts` using `$fetch`.
- Implement `services/adapters/apiAuth.ts`.
- Switch `NUXT_PUBLIC_WAREHOUSE_ADAPTER=api` and test end-to-end.

### Phase 9 — Cleanup

- Remove `composables/useDb.ts` if it is no longer imported by any UI code (keep for tests if useful).
- Remove or disable `plugins/pglite.client.ts` for API-only builds.
- Update tests to use the service layer or keep direct DB tests for `db/*.ts` logic.

---

## 6. Testing strategy

1. **Keep existing `db/*.ts` tests.** They validate the business logic and remain valid as long as the PGlite adapter uses those helpers.
2. **Add service adapter tests** for `PgliteWarehouseService` using the existing test DB setup. One or two tests per domain are enough to prove the adapter wires correctly.
3. **Add API adapter tests** only after the backend exists; mock `$fetch` responses.
4. **Manual verification:** after each phase, log in as `operator` / `DocPal2026!` and exercise the affected flow.

---

## 7. Risks and gotchas

1. **Scan matcher data availability.** In API mode, the matcher needs receiving order detail / put-away lots / shelf box items already loaded. Ensure detail pages fetch everything the matcher needs.
2. **Transactions across service calls.** Some UI flows today do multiple DB calls in sequence (e.g. `pages/receiving/[id].vue`). The service should expose aggregated endpoints where consistency matters; the PGlite adapter can use existing transactions inside single methods.
3. **Large raw SQL moves.** `pages/receiving/index.vue` has a complex SQL query. Moving it into `PgliteWarehouseService` is mechanical but must preserve exact behavior.
4. **Auth restore on startup.** `useAuth().restore()` currently needs a DB. With API mode, replace with `authService.getCurrentUser()` and a stored token.
5. **Type drift.** Keep `services/types.ts` in sync with both the UI and the API spec. Avoid reusing Drizzle-generated types in DTOs.
6. **Demo seeding.** In PGlite mode the app still seeds itself. In API mode, seeding is server-side; the client should not call seed functions.

---

## 8. Immediate next step

Create the skeleton:

1. `services/types.ts`
2. `services/warehouse.ts`
3. `services/auth.ts`
4. `services/adapters/pgliteAuth.ts`
5. `services/adapters/pgliteWarehouse.ts` (with receiving methods only)
6. `composables/useWarehouse.ts`
7. Update `composables/useAuth.ts` and `nuxt.config.ts`
8. Migrate `pages/receiving/index.vue` and `pages/receiving/[id].vue` to prove the pattern.

This gives a working pilot before touching the rest of the app.
