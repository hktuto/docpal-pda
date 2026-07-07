# API Endpoint Design — Warehouse PDA Demo

**Date:** 2026-07-07  
**Status:** Draft / starting point for backend API design  
**Goal:** List the HTTP endpoints needed to replace the self-hosted PGlite database with a real backend API, derived from the existing `db/*` helpers and direct page queries.

## Conventions

- Base path: `/api/v1`
- Authentication: session cookie or `Authorization: Bearer <token>` (TBD by backend). The client must send credentials on login; the server resolves `actorId` from the session for all write operations.
- All write endpoints are transactional on the server. The client must not send `actorId` in request bodies.
- Error responses use the same i18n error codes the frontend already understands (`errors.<code>`).
- List endpoints support the filtering/sorting already present in the demo (e.g. exclude finished picking orders, order by status).

---

## 1. Auth

| Method | Path | Purpose | Notes |
|--------|------|---------|-------|
| `POST` | `/auth/login` | Login | Body: `{ username, password }`. Returns user + token/session. |
| `POST` | `/auth/logout` | Logout | Clears session. |
| `GET`  | `/auth/me` | Current user | Used on app startup to restore session (replaces `useAuth().restore`). |

**Request/Response:**

```ts
// POST /auth/login
interface LoginRequest { username: string; password: string; }
interface LoginResponse { user: User; }

// GET /auth/me
interface MeResponse { user: User | null; }
```

---

## 2. Receiving Orders

| Method | Path | Purpose | Maps to |
|--------|------|---------|---------|
| `GET`  | `/receiving-orders` | List all receiving orders with supplier | `pages/receiving/index.vue` raw SQL, `getReceivingOrdersWithSupplier` |
| `GET`  | `/receiving-orders/:id` | Full detail (order + invoices + items + computed counts/allocations/logs) | `pages/receiving/[id].vue` aggregated queries, `getReceivingOrderDetail` |
| `POST` | `/receiving-orders/:id/arrive` | Mark order as arrived / in-hand | `confirmReceivingOrderArrived` |

**Response notes:**

- `GET /receiving-orders/:id` should return a single aggregated object that includes:
  - order + supplier
  - invoices + items + parts
  - active mismatches per item
  - allocated qty per item
  - picking orders linked to this receiving order
  - transition logs for picking items
  - shipping boxes for those picking orders

---

## 3. Receiving Item Mismatches

| Method | Path | Purpose | Maps to |
|--------|------|---------|---------|
| `GET`  | `/receiving-invoice-items/:id/mismatch` | Get active mismatch for an item | `getActiveMismatchForItem` |
| `POST` | `/receiving-invoice-items/:id/mismatch` | Report a mismatch | `reportReceivingItemMismatch` |
| `PATCH`| `/mismatches/:id` | Edit a pending mismatch | `editReceivingItemMismatch` |
| `POST` | `/mismatches/:id/confirm` | Confirm a pending mismatch | `confirmReceivingItemMismatch` |
| `POST` | `/mismatches/:id/cancel` | Cancel a pending mismatch | `cancelReceivingItemMismatch` |

**Request bodies:**

```ts
// POST /receiving-invoice-items/:id/mismatch
interface ReportMismatchRequest {
  reason: MismatchReason;      // not_found | damaged | qty_mismatch | wrong_part | over_shipment | quality_rejection
  mismatchQty?: number | null;
  wrongPartNo?: string | null;
  note?: string;
}

// PATCH /mismatches/:id
interface EditMismatchRequest extends ReportMismatchRequest {}
```

---

## 4. Picking Orders

| Method | Path | Purpose | Maps to |
|--------|------|---------|---------|
| `GET`  | `/picking-orders` | List picking orders with supplier and totals | `pages/picking/index.vue` raw SQL, `getPickingOrdersWithSupplier` |
| `GET`  | `/picking-orders/:id` | Full picking order detail | `getPickingOrderDetail` |
| `POST` | `/picking-orders/:id/finish` | Manually finish a picking order | `finishPickingOrder` |
| `POST` | `/picking-orders/issues` | Report issues on one or more orders | `reportPickingOrderIssues` |
| `GET`  | `/picking-items/transition-logs?ids=...` | Batch transition logs for picking items | `getPickingItemTransitionLogs` |

**Request bodies:**

```ts
// POST /picking-orders/issues
interface ReportPickingIssuesRequest {
  entries: { orderId: string; remark?: string | null }[];
  input: {
    reason: PickingIssueReason; // insufficient_stock | cannot_divide | merge | other
    qty?: number | null;
    packSize?: number | null;
    note?: string | null;
  };
}
```

---

## 5. Picking Scanning / Packages / Shipping Boxes

| Method | Path | Purpose | Maps to |
|--------|------|---------|---------|
| `POST` | `/allocations/:id/materialize` | Convert a receiving allocation into a real inventory lot | `materializeReceivingAllocation` |
| `POST` | `/allocations/:id/scan` | Scan an allocation into a package | `scanAllocationToPackage` |
| `POST` | `/packages/:id/remove` | Remove a scanned package and restore stock | `removeScannedPackage` |
| `POST` | `/packages/:id/add-to-box` | Move a package into a shipping box | `addPackageToBox` |
| `POST` | `/packages/:id/remove-from-box` | Remove a package from its shipping box | `removePackageFromBox` |
| `POST` | `/shipping-boxes/:id/add-all-unboxed` | Add all unboxed packages for the order into this box | `addAllUnboxedPackagesToBox` |
| `POST` | `/picking-orders/:id/shipping-boxes` | Create a new shipping box for the order | `createShippingBoxForPickingOrder` |
| `DELETE`| `/shipping-boxes/:id` | Cancel an empty, open shipping box | `cancelShippingBox` |

**Request bodies:**

```ts
// POST /allocations/:id/materialize
interface MaterializeAllocationRequest {
  qty: number;
  dateCode?: string | null;
  lotCode?: string | null;
  coo?: string | null;
  cow?: string | null;
}

// POST /allocations/:id/scan
// POST /packages/:id/remove
// (actorId from session; no body required)

// POST /packages/:id/add-to-box
interface AddPackageToBoxRequest { shippingBoxId: string; }
```

---

## 6. Put-away

| Method | Path | Purpose | Maps to |
|--------|------|---------|---------|
| `GET`  | `/put-away/candidates` | List receiving orders available for put-away | `getPutAwayCandidates` |
| `GET`  | `/receiving-orders/:id/put-away-lots` | Lots available to put away for an order | `getPutAwayLots` |
| `GET`  | `/receiving-orders/:id/put-away-scans` | Existing put-away scans for an order | `getPutAwayScansForReceivingOrder` |
| `GET`  | `/receiving-orders/:id/shelf-boxes` | Shelf boxes created for an order | `getShelfBoxesForReceivingOrder` |
| `GET`  | `/shelves` | List all shelves | `db.query.shelves.findMany()` in `pages/put-away/[id].vue` |
| `POST` | `/put-away/scans` | Record a new put-away scan | `recordPutAwayScan` |
| `POST` | `/put-away/scans/:id/assign-to-box` | Assign an unboxed scan to a shelf box | `assignScanToBox` |
| `POST` | `/put-away/scans/:id/remove-from-box` | Move a scan out of its shelf box | `removeScanFromBox` |
| `POST` | `/put-away/scans/:id/remove-piece` | Remove one piece/qty from a scan | `removeScannedPiece` |
| `POST` | `/receiving-orders/:id/shelf-boxes` | Create a new shelf box | `createShelfBox` |
| `DELETE`| `/shelf-boxes/:id` | Cancel an empty shelf box | `cancelShelfBox` |
| `POST` | `/shelf-boxes/:id/close` | Close a shelf box | `closeShelfBox` |

**Request bodies:**

```ts
// POST /put-away/scans
interface RecordPutAwayScanRequest {
  receivingInvoiceItemId: string;
  qty: number;
  dateCode?: string | null;
  lotCode?: string | null;
  coo?: string | null;
  cow?: string | null;
}

// POST /put-away/scans/:id/assign-to-box
interface AssignScanToBoxRequest { shelfBoxId: string; }

// POST /put-away/scans/:id/remove-piece
interface RemoveScannedPieceRequest { qty: number; }
```

---

## 7. Measuring

| Method | Path | Purpose | Maps to |
|--------|------|---------|---------|
| `GET`  | `/measuring-tasks` | List pending measuring tasks with totals | `pages/measuring/index.vue` raw SQL, `getMeasuringTasks` |
| `GET`  | `/measuring-tasks/:id` | Full task detail with boxes and packages | `getMeasuringTaskDetail` |
| `GET`  | `/shipping-boxes/:id/for-measuring` | Box detail for the measuring screen | `getShippingBoxForMeasuring` |
| `POST` | `/shipping-boxes/:id/verify-package` | Verify a package inside a box | `verifyPickingPackageForMeasuring` |
| `PATCH`| `/shipping-boxes/:id` | Update box measurements | `updateShippingBox` |
| `POST` | `/shipping-boxes/:id/close` | Close a verified, measured box | `closeShippingBox` |
| `POST` | `/measuring-tasks/:id/complete` | Complete the measuring task | `completeMeasuringTask` |

**Request bodies:**

```ts
// POST /shipping-boxes/:id/verify-package
interface VerifyPackageRequest { packageId: string; }

// PATCH /shipping-boxes/:id
interface UpdateShippingBoxRequest {
  grossWeight?: number | string | null;
  netWeight?: number | string | null;
  destinationCountry?: string | null;
  boxSize?: string | null;
}
```

---

## 8. Goods Verify

| Method | Path | Purpose | Maps to |
|--------|------|---------|---------|
| `GET`  | `/shelves/with-box-counts` | List shelves with box counts | `getShelvesWithBoxes` |
| `GET`  | `/shelves/:code/boxes` | Boxes on a shelf with verification stats | `getShelfBoxesByShelf` |
| `GET`  | `/shelf-boxes/:id` | Full shelf box detail | `getShelfBoxDetail` |
| `POST` | `/shelf-boxes/:id/verify-item` | Mark a shelf box item as verified | `verifyShelfBoxScans` / `verifyShelfBoxItem` |
| `POST` | `/shelf-boxes/:id/mark-verified` | Mark the whole box verified | `markShelfBoxVerified` |

**Request body:**

```ts
// POST /shelf-boxes/:id/verify-item
interface VerifyShelfBoxItemRequest { shelfBoxItemId: string; }
```

---

## 9. Stock Search

| Method | Path | Purpose | Maps to |
|--------|------|---------|---------|
| `GET`  | `/suppliers/with-inventory-stats` | Suppliers + part/inventory counts | `getSuppliersWithInventoryStats` |
| `GET`  | `/suppliers/:id/parts` | Parts for a supplier | `getPartsBySupplierId` |
| `POST` | `/inventory-lots/query` | Inventory lots for a list of part IDs | `getInventoryLotsForParts` |

**Request/Response:**

```ts
// POST /inventory-lots/query
interface InventoryLotsQueryRequest { partIds: string[]; }
interface InventoryLotsQueryResponse { lots: StockSearchInventoryLot[]; }
```

---

## 10. OCR / Universal Scan — client-side only

No API endpoints are required for the scan matcher. The matcher runs locally on the Android device:

- `composables/useScanMatchers.ts` calls `findReceivingCandidates`, `findPickingCandidates`, and `applyOcrPick`.
- These depend on local data (receiving lots, picking allocations) that the device already has while performing a scan.
- The results are immediate and should stay on-device to avoid network latency during scanning.

The underlying write actions (e.g. creating a picking package after a successful scan) still go through the normal API endpoints listed above (`POST /allocations/:id/scan`, `POST /put-away/scans`, etc.).

---

## 11. Reference Data

| Method | Path | Purpose | Notes |
|--------|------|---------|-------|
| `GET`  | `/suppliers` | List suppliers | May be absorbed by `/suppliers/with-inventory-stats` |
| `GET`  | `/shelves` | List shelves | Also listed under Put-away |

---

## 12. Internal / server-only operations (no public endpoint needed)

These should happen automatically on the server:

- `allocatePendingPickingOrders` / `allocatePickingOrder` — trigger after a receiving order is marked arrived, or run on a schedule/job.
- `tryMarkReceivingOrderClear` / `tryMarkReceivingOrderInHand` — internal state transitions after picking/put-away changes.
- `maybeAutoFinishPickingOrder` — internal side effect of adding the last package to a box.
- `seedDb` / `ensureDemoPasswords` — server-side seeding/migration, not client API.

---

## Open questions for backend design

1. **Authentication mechanism** — JWT in `Authorization` header vs. session cookie vs. Capacitor-native token storage.
2. **Offline support** — Will the PDA need offline queueing? If yes, the client may keep a local cache plus an outbox; this spec assumes online-first.
3. **Large list pagination** — Current demo loads everything. API should probably add `limit`/`offset` or cursor pagination.
4. **File uploads** — The native `RectangleDetection.scanLabel()` flow may produce images; decide if those go to the API or stay on-device.
5. **Error mapping** — Ensure the backend returns i18n-compatible error codes so existing `useErrorMessage()` keeps working.
6. **Permissions** — Some actions (e.g. confirming mismatches) require a different user than the reporter. The backend should enforce this.

---

## Recommended next step

Use this endpoint list as the contract for the **service/repository layer** refactor on the frontend:

1. Create a `WarehouseService` interface that matches these endpoints.
2. Implement a `PgliteWarehouseService` that delegates to the existing `db/*` functions.
3. Update pages/components to call the service instead of `useDb()`.
4. Once the UI is fully decoupled from Drizzle, implement the real `ApiWarehouseService` that calls these endpoints.
