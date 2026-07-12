# Native Android Rewrite — Phase 3 (Put-away) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the put-away flow to the native Android app: receiving-order candidate list → detail with lots panel (scan pieces into shelf boxes), shelf-boxes panel (create/assign/add-all/close/cancel), inventory-lot materialization, and auto-clear of the receiving order — reproducible end-to-end on device.

**Architecture:** Follow the Phase 1/2 conventions exactly: suspend repositories over Room DAOs (`withContext(Dispatchers.IO)` + `db.runInTransaction`), `LocalizedException(code, params)` errors rendered by `ErrorText`, source-interface VM seams with fakes in tests, per-orderId `provideFactory`, `OnResumeEffect` reloads, reusable composables in `ui/components/`, strings ×3 locales with `StringsParityTest`. The scan pipeline (camera launcher, QR-first parser seam, generalized `ui/scan/LabelScanReviewDialog`, `ScanMatcher`) is reused as-is; a `matchPutAway` sibling joins `matchReceiving`/`matchPicking`. Web parity reference is the **API** behavior (`apps/api/src/db/putAway.ts` + `apps/api/src/routes/putAway.ts`) with pglite error codes (`apps/web/db/putAway.ts`) since Android uses i18n error codes; deliberate deviations are called out per task.

**Tech Stack:** Kotlin, Jetpack Compose, Room (in-memory for tests via Robolectric `@Config(sdk=[34])`), `node:test`-style JUnit4 JVM tests, existing Gradle commands.

**Starting state:** master at `bda72c0` (Phase 2 complete). 199 JVM tests green. Device `MFM5PRE526010002` available for the walkthrough. Conventions and gotchas (staging, seed.sql, zh-rHK dir, fixture patterns) are in `AGENTS.md` and the Phase 2 plan's handoff notes — the orchestrator briefs each implementer.

**Phase exit criteria (spec):** "Put-away flow reproducible" — on device: scan pieces from a lot card, assign to a shelf box, close the box, order auto-clears and leaves the list.

---

## Reference facts (verified during exploration)

- Web list: `apps/web/pages/put-away/index.vue` — **no search, no filter**; rows show refNo, receiving status badge (`in_hand`), supplier (fallback `common.noSupplier`), footer `"{count} available"`; whole card navigates; empty `common.noReceivingOrdersNeedPutAway`; hint `putAway.hint`. Candidates: `ro.status = 'in_hand'` with `SUM(available) > 0 OR unboxed scans > 0`, ordered by ref_no (`apps/api/src/routes/putAway.ts:71-90`).
- Web detail: `apps/web/pages/put-away/[id].vue` + `components/put-away/ShelfBoxesPanel.vue` + `PutAwayLotsPanel.vue` + `components/SelectShelfDialog.vue`.
- Lots panel: one card per invoice item with `available > 0 OR unboxed scans > 0`, **only while order is `in_hand`**, ordered by `part_no, date_code` (`apps/api/src/routes/putAway.ts:92-111`). Card: Part / Date-Lot / COO-COW / Total / Scanned / Boxed + Scan button + expandable scan list.
- Scan rows: `{qty} pcs`, per-scan date/lot/coo/cow (`—` when null), `In box {id}` or `Unboxed`. Unboxed → open-box `<select>` + Add to box + Remove scan. Boxed in open box → Remove from box. Boxed in closed box → no actions.
- Boxes panel: grouped by shelf (`{code} — {zone}`, `common.unassigned` fallback), collapsible, New box (when order not `clear`), per box: id, box status badge, `{n} lines · {qty} pcs`, expandable contents (per-part qty). Ordering: open first, then `created_at DESC`. Open-box actions: Add all (disabled when `unboxedCount == 0`, `window.confirm` with count), Close box (only when box has items), Cancel box (only when empty, hard delete).
- Shelf boxes are **created, never scanned** — box id is server-generated; shelf chosen from a dropdown of all shelves (`SelectShelfDialog`).
- Mutations (API reference, `apps/api/src/db/putAway.ts`): `recordPutAwayScan` :53-74, `createShelfBox` :30-42 (+ `nextShelfBoxId` :17-28 — `SBOX-` + zero-padded-4 max+1 over `shelf_boxes` **and** `transition_logs`, cancelled ids never reissued), `cancelShelfBox` :44-51, `assignScanToBox` :129-181, `addAllUnboxedToBox` :183-195 (oldest first), `removeScanFromBox` :197-240 (refuses when lot has pick allocations), `removeScannedPiece` :76-83, `closeShelfBox` :256-263, `tryMarkReceivingOrderClear` :110-127 (called from assign/remove-from-box/close; unboxed scans count as consumed).
- **`scheduleCycleCount` NOT ported** (API-only side effect: `verification_tasks` rows + `verified` resets). Android has no `verification_tasks` table; goods-verify (Phase 4) will list boxes directly. Recorded as a deliberate deviation.
- Matcher: `matchPutAway` at `apps/web/composables/useScanMatchers.ts:225-264` — pinned-lot part equality (normalized), positive integer qty, `qty <= availableQty`; errors `scanned_part_does_not_match_item`, `qty_must_be_positive_integer`, `invalid_receiving_item`, `quantity_exceeds_available`. Date/lot/coo/cow taken from the label as-is (`rawCode`: trimmed or null). Apply → `recordPutAwayScan`. Single match **auto-applies** (no confirm). Web put-away has **no wedge scanner** and **no manual-entry button** — camera scan from the per-lot button only.
- Auto-clear: when every invoice item's remaining (`received - picked - putAway - allocated - unboxedScans`) ≤ 0 → `in_hand → clear` + transition log. Once `clear`, lots panel shows nothing (web parity) and the order leaves the list. Remove-from-box does NOT flip clear back to in_hand (web parity).
- Android existing state: `PutAwayScanEntity` (`data/db/MeasuringEntities.kt:53-73`, has `part_id`, no `receiving_order_id` — reach via invoice item join), `ShelfBoxEntity` (:38-51, no writers anywhere), `ShelfEntity` (`ReferenceEntities.kt:45-49`, code PK + zone), `InventoryLotEntity` (`InventoryEntities.kt:8-35`, unique index on `(part_id, date_code, coo, cow, shelf_code, box_id)` — **lot_code is NOT in the index**, so the upsert merge key must be exactly the index columns), `InventoryLotSourceEntity` (:37-49, unique `(inventory_lot_id, receiving_invoice_item_id)`), `ReceivingInvoiceItemEntity.put_away_qty` (`ReceivingEntities.kt:48`, no writer yet). Unboxed-scan read math already exists (`ReceivingDao.unboxedPutAwayScanTotals()` :40-48 + `AllocationDistributor.distribute` — availability shrinks automatically once scans are written).
- Availability is computed live on Android (no maintained `available_qty` column): `ReceivingRepository.availabilityByItem` + `AllocationDistributor.distribute(items, totals, unboxed)`. Do not duplicate the distribution math — share it (see Task 3).
- Seed: one `in_hand` receiving order (ref `04958166`, supplier KOA), 264 invoice items with full availability, 11 shelves (`A-01-01`…`A-01-08`, `B-01-01`, `B-02-01`, `B-02-02`), zero shelf_boxes/put_away_scans/inventory_lots. Tests must be seed-agnostic (synthetic fixtures; business-key lookups only).
- Existing reusable pieces: `ui/scan/LabelScanReviewDialog.kt` + `ScanReviewUiState` (+ `LabelScanParser` seam), `ui/receiving/ScanLaunchers.kt` (`rememberCameraScanLauncher`), `domain/scan/HardwareKeyBuffer`, `domain/scan/ScanMatcher.kt`, `ScanPrimitives` (`OcrInput`/`parseManual`/`normalize`/`normalizeCode`), `ui/components/` (`StatusBadge` families receiving/picking/box/measuring, `DetailRow`, `EmptyState`, `ErrorText`, `OnResumeEffect`), `SessionSource` in `ui/receiving/ReceivingDetailViewModel.kt:54-56` (import, don't duplicate). Test fixture `app/src/test/java/com/docpal/warehousepda/domain/PickingDbFixture.kt` (internal top-level `exec`/`intQuery`/`stringQuery`/`expectCode` + insert helpers, same package = reusable).
- ErrorText resolves `error_<code>` via `getIdentifier` (`ui/components/ErrorText.kt:19-33`) — new error codes only need `error_<code>` strings ×3 locales.

---

## Task 1: i18n strings for the put-away flow

**Files:**
- Modify: `apps/android/app/src/main/res/values/strings.xml`
- Modify: `apps/android/app/src/main/res/values-zh-rCN/strings.xml`
- Modify: `apps/android/app/src/main/res/values-zh-rHK/strings.xml`

Add these keys to all three locale files (en values below; zh-CN/zh-HK translations follow the existing file's style — mirror wording used for the same concepts in receiving/picking strings). Verify first which already exist (`common_no_boxes`, `common_scan_success`, `error_qty_must_be_positive_integer`, `error_operator_not_signed_in`, `error_receiving_order_not_found`, `common_no_supplier`, `common_no_data`, `common_pcs` exist from Phases 1-2 — do not duplicate):

```
put_away_title                 "Put-away"
put_away_hint                  "Receiving orders with stock still in the receiving area."
put_away_available             "%1$d available"
put_away_detail_supplier       "Supplier"
put_away_detail_delivery_date  "Delivery date"
put_away_boxes_title           "Shelf boxes"
put_away_new_box               "New box"
put_away_box_lines_qty         "%1$d lines · %2$d pcs"
put_away_add_all               "Add all"
put_away_add_all_confirm       "Add %1$d unboxed scan(s) to this box?"
put_away_close_box             "Close box"
put_away_cancel_box            "Cancel box"
put_away_lots_title            "Lots"
put_away_part                  "Part"
put_away_total_qty             "Total"
put_away_scanned_qty           "Scanned"
put_away_boxed_qty             "Boxed"
put_away_date_lot              "Date / Lot"
put_away_coo_cow               "COO / COW"
put_away_no_scans              "No scans yet"
put_away_select_box            "Select box"
put_away_add_to_box            "Add to box"
put_away_remove_from_box       "Remove from box"
put_away_remove_scan           "Remove scan"
put_away_scan_piece            "Scan piece"
put_away_show_scans            "Show scans (%1$d)"
put_away_hide_scans            "Hide scans"
select_shelf_title             "Select shelf"
select_shelf_label             "Shelf"
select_shelf_default           "Choose a shelf…"
common_no_receiving_orders_need_put_away  "No receiving orders need put-away."
common_no_lots                 "No lots available for put-away."
common_in_box                  "In box %1$s"
common_unboxed                 "Unboxed"
common_unassigned              "Unassigned"
common_shelf_format            "%1$s — %2$s"
error_invoice_item_not_found             "Invoice item not found."
error_scanned_qty_exceeds_total          "Scanned qty exceeds the remaining qty."
error_put_away_scan_not_found            "Put-away scan not found."
error_put_away_scan_already_boxed        "Scan is already in a box."
error_put_away_scan_not_boxed            "Scan is not in a box."
error_shelf_box_not_found                "Shelf box not found."
error_shelf_box_is_not_open              "Shelf box is not open."
error_shelf_box_is_not_empty             "Shelf box is not empty."
error_cannot_close_empty_shelf_box       "Cannot close an empty shelf box."
error_shelf_not_found                    "Shelf not found."
error_item_does_not_belong_to_receiving_order  "Scan and box belong to different receiving orders."
error_lot_has_pick_allocations           "Lot has pick allocations."
error_quantity_exceeds_available         "Quantity exceeds available."
error_scanned_part_does_not_match_item   "Scanned part does not match the item."
error_invalid_receiving_item             "Invalid receiving item."
```

- [ ] **Step 1:** Add the keys to `values/strings.xml`, then the translations to `values-zh-rCN/strings.xml` and `values-zh-rHK/strings.xml` (identical key sets — `StringsParityTest` enforces this).
- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*StringsParityTest"` — green. Then the full suite (baseline 199, unchanged count).
- [ ] **Step 3:** Commit: `git add apps/android/app/src/main/res && git commit -m "android phase3: put-away i18n strings"`

---

## Task 2: Wedge Enter-KeyUp propagation fix

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/picking/PickingDetailScreen.kt` (~:140-155)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/receiving/ReceivingDetailScreen.kt` (~:140-152)

Phase 2 walkthrough finding: the Scaffold `onPreviewKeyEvent` consumes the Enter **KeyDown** for the wedge buffer flush, but the **KeyUp falls through** and — outside touch mode — activates the app-bar back button, popping the detail screen right after a hardware scan. Both screens carry the same block (line-for-line identical): `event.type != KeyEventType.KeyDown -> false`.

Fix in both files: when `keyBuffer.enabled` is true, consume Enter in **both** directions — keep the existing KeyDown handling (flush on Enter KeyDown) and add a KeyUp branch that returns `true` for `Key.Enter` while the buffer is enabled. The buffer is disabled while dialogs are open (`SideEffect { keyBuffer.enabled = !wedgeDisabled }`), so dialog text fields are unaffected. Do not change any other behavior; do not deduplicate the two blocks (Phase 3+ cleanup).

There is no practical JVM test for Compose key dispatch — verification is assemble + the device walkthrough (Task 11 injects a wedge payload via adb and confirms the detail no longer pops).

- [ ] **Step 1:** Apply the fix to both screens, with a one-line comment citing the Phase 2 walkthrough finding.
- [ ] **Step 2:** Run the full suite (199 green, unchanged) + `./gradlew :app:assembleDebug`.
- [ ] **Step 3:** Commit: `git add apps/android/app/src/main/java && git commit -m "android phase3: consume wedge Enter KeyUp on detail screens"`

---

## Task 3: Put-away list data layer

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/PutAwayDao.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/PutAwayRepository.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/AppDatabase.kt` (register DAO)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/ReceivingRepository.kt` (share availability math — see below)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/PutAwayDbFixture.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/data/PutAwayListRepositoryTest.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/AppContainer.kt` (lazy `putAwayRepository`)

Model (`PutAwayRepository.kt` or a small `domain/model` file — follow where Phase 2 put `PickingOrderSummary`):

```kotlin
data class PutAwayCandidate(
    val orderId: String,
    val refNo: String,
    val status: String,           // always "in_hand" from the query
    val supplierName: String?,
    val availableQty: Int,        // sum of per-item availability (live-computed)
)
```

`PutAwayDao` (flat rows with `@ColumnInfo`, Phase 2 style):

```kotlin
@Query("""
    SELECT ro.id, ro.ref_no AS refNo, ro.status, s.name AS supplierName
    FROM receiving_orders ro
    LEFT JOIN suppliers s ON s.id = ro.supplier_id
    WHERE ro.status = 'in_hand'
    ORDER BY ro.ref_no
""")
fun inHandOrderRows(): List<InHandOrderRow>
```

(Verify actual table/column names against `data/db/ReceivingEntities.kt` and `ReceivingDao.kt` — adapt the SQL to the real schema.)

`PutAwayRepository` (suspend + `withContext(Dispatchers.IO)`, takes `AppDatabase`):

```kotlin
suspend fun listCandidates(): List<PutAwayCandidate>
```

- Loads in-hand rows.
- Computes per-order availability with the **existing** distribution math: read `ReceivingRepository.availabilityByItem` (used by `listOrders`/`getOrderDetail`) — if it is private, extract the minimal shared computation (items + allocation totals + unboxed put-away totals → per-item available via `AllocationDistributor.distribute`) into an `internal` helper (e.g. `ReceivingAvailability` in `data/` or a companion), keeping `ReceivingRepository` behavior byte-for-byte identical (its existing tests must pass untouched). Do NOT copy-paste the allocation-distribution logic.
- A candidate is kept when `sum(available) > 0` OR the order has any unboxed put-away scans (web `HAVING` parity — the unboxed totals feed the same availability helper; an order fully scanned-but-unboxed has availability 0 but must still appear).
- `availableQty` on the row = sum of per-item availability (clamped ≥ 0 per item, matching however `availabilityByItem` handles clamps — check and mirror).

`PutAwayDbFixture.kt` — same package as `PickingDbFixture.kt` so it reuses the internal `exec`/`intQuery`/`stringQuery`/`expectCode` helpers; add insert helpers as needed (check what already exists — `insertReceivingOrder`, `insertPart` exist; add if missing):

```kotlin
fun insertReceivingInvoice(db: SupportSQLiteDatabase, id: String, orderId: String, supplierInvoiceNo: String = "INV-$id")
fun insertReceivingInvoiceItem(
    db: SupportSQLiteDatabase, id: String, invoiceId: String, partId: String,
    qty: Int, receivedQty: Int = qty, pickedQty: Int = 0, putAwayQty: Int = 0,
    dateCode: String? = null, lotCode: String? = null, coo: String? = null, cow: String? = null,
)
fun insertPutAwayScan(
    db: SupportSQLiteDatabase, id: String, itemId: String, partId: String, qty: Int,
    shelfBoxId: String? = null, dateCode: String? = null, lotCode: String? = null,
    coo: String? = null, cow: String? = null,
)
fun insertShelfBox(db: SupportSQLiteDatabase, id: String, orderId: String, shelfCode: String?, status: String = "open")
```

(Verify column names/NOT-NULL constraints against the entity classes; `sqlQuote` already escapes single quotes.)

- [ ] **Step 1: Write the failing tests** — `PutAwayListRepositoryTest.kt` (Robolectric `@Config(sdk=[34])`, in-memory DB via `DbTestSupport`, `runBlocking`):

```kotlin
@Test fun `in hand order with availability is a candidate`()
    // synthetic order in_hand + 1 invoice + 1 item received 10 -> 1 candidate, availableQty == 10
@Test fun `order fully allocated and put away is not a candidate`()
    // item received 10, put_away_qty 10 -> no candidates
@Test fun `order with only unboxed scans is still a candidate`()
    // item received 10 + allocation rows consuming all 10 (insertAllocation coarse against the order,
    // mirroring how ReceivingRepositoryTest seeds allocations) + unboxed scan 10 -> candidate, availableQty == 0
@Test fun `pending and clear orders are excluded`()
    // one pending order + one clear order with availability -> empty list
```

(For the allocation-consuming case, check how `ReceivingRepositoryTest` constructs allocations against a receiving order and mirror it; if that proves heavy, a simpler equivalent is fine: `picked_qty = 10` also zeroes availability — but prefer the allocation path since it exercises the shared math.)

- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*PutAwayListRepositoryTest"` — verify failure.
- [ ] **Step 3:** Implement DAO + repository + fixture + AppContainer wiring.
- [ ] **Step 4:** Full suite green (199 → 203).
- [ ] **Step 5:** Commit: `git add apps/android/app/src/main/java apps/android/app/src/test && git commit -m "android phase3: put-away list data layer"`

---

## Task 4: Put-away detail read model

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/model/PutAwayModels.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/PutAwayDao.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/PutAwayRepository.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/data/PutAwayDetailRepositoryTest.kt`

Models (verify field types against entities; dates are ISO strings like the rest of the app):

```kotlin
data class PutAwayOrderHeader(
    val id: String, val refNo: String, val status: String,
    val supplierName: String?, val supplierCode: String?, val deliveryDate: String?,
)

data class PutAwayLotDetail(
    val receivingInvoiceItemId: String,
    val partNo: String?,
    val dateCode: String?, val lotCode: String?, val coo: String?, val cow: String?,
    val totalQty: Int,        // invoice item qty
    val availableQty: Int,    // live-computed: received - picked - putAway - allocated - unboxedScans
    val scannedQty: Int,      // Σ all put_away_scans qty for this item
    val boxedQty: Int,        // Σ scan qty where shelf_box_id IS NOT NULL
)

data class PutAwayScanDetail(
    val id: String,
    val receivingInvoiceItemId: String,
    val qty: Int,
    val dateCode: String?, val lotCode: String?, val coo: String?, val cow: String?,
    val shelfBoxId: String?,
)

data class PutAwayBoxDetail(
    val id: String,
    val shelfCode: String?,
    val zone: String?,
    val status: String,
    val createdAt: Long,
    val lineCount: Int,       // scans in box
    val totalQty: Int,        // Σ scan qty in box
    val contents: List<PutAwayBoxContent>,   // per-part aggregation, filled by repository
)

data class PutAwayBoxContent(val partNo: String?, val qty: Int)

data class ShelfOption(val code: String, val zone: String?)

data class PutAwayDetail(
    val header: PutAwayOrderHeader,
    val lots: List<PutAwayLotDetail>,        // empty unless header.status == "in_hand" (web parity)
    val scans: List<PutAwayScanDetail>,
    val boxes: List<PutAwayBoxDetail>,
    val shelves: List<ShelfOption>,
)
```

DAO queries (flat rows; verify table/column names against the entities — invoice items reach the order via `receiving_invoices`):

```sql
-- header
SELECT ro.id, ro.ref_no AS refNo, ro.status, s.name AS supplierName, s.code AS supplierCode, ro.delivery_date AS deliveryDate
FROM receiving_orders ro LEFT JOIN suppliers s ON s.id = ro.supplier_id WHERE ro.id = :orderId

-- lot rows (availability inputs; repository merges the allocated part from the shared availability helper)
SELECT rii.id AS itemId, p.part_no AS partNo, rii.date_code AS dateCode, rii.lot_code AS lotCode,
       rii.coo AS coo, rii.cow AS cow, rii.qty AS totalQty,
       COALESCE(sc.scannedQty, 0) AS scannedQty, COALESCE(sc.boxedQty, 0) AS boxedQty
FROM receiving_invoice_items rii
JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
LEFT JOIN parts p ON p.id = rii.part_id
LEFT JOIN (
    SELECT receiving_invoice_item_id AS itemId, SUM(qty) AS scannedQty,
           SUM(CASE WHEN shelf_box_id IS NOT NULL THEN qty ELSE 0 END) AS boxedQty
    FROM put_away_scans GROUP BY receiving_invoice_item_id
) sc ON sc.itemId = rii.id
WHERE ri.receiving_order_id = :orderId
ORDER BY p.part_no, rii.date_code

-- scans for the order
SELECT pas.id, pas.receiving_invoice_item_id AS receivingInvoiceItemId, pas.qty,
       pas.date_code AS dateCode, pas.lot_code AS lotCode, pas.coo AS coo, pas.cow AS cow,
       pas.shelf_box_id AS shelfBoxId
FROM put_away_scans pas
JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
WHERE ri.receiving_order_id = :orderId
ORDER BY pas.created_at, pas.id

-- boxes for the order (open first, then created_at DESC — web parity)
SELECT sb.id, sb.shelf_code AS shelfCode, sh.zone AS zone, sb.status, sb.created_at AS createdAt,
       COUNT(pas.id) AS lineCount, COALESCE(SUM(pas.qty), 0) AS totalQty
FROM shelf_boxes sb
LEFT JOIN shelves sh ON sh.code = sb.shelf_code
LEFT JOIN put_away_scans pas ON pas.shelf_box_id = sb.id
WHERE sb.receiving_order_id = :orderId
GROUP BY sb.id
ORDER BY CASE WHEN sb.status = 'open' THEN 0 ELSE 1 END, sb.created_at DESC, sb.id

-- box contents (per-part aggregation done in Kotlin from this flat row)
SELECT pas.shelf_box_id AS boxId, p.part_no AS partNo, SUM(pas.qty) AS qty
FROM put_away_scans pas
JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
LEFT JOIN parts p ON p.id = pas.part_id
WHERE ri.receiving_order_id = :orderId AND pas.shelf_box_id IS NOT NULL
GROUP BY pas.shelf_box_id, p.part_no
ORDER BY p.part_no

-- shelves
SELECT code, zone FROM shelves ORDER BY code
```

Repository:

```kotlin
suspend fun getPutAwayDetail(orderId: String): PutAwayDetail?
```

- Loads header (null → return null), lot rows, scans, boxes, contents, shelves.
- `availableQty` per lot = per-item available from the shared availability helper (Task 3) for this order.
- Lots kept when `availableQty > 0 || (scannedQty - boxedQty) > 0` (web `HAVING available > 0 OR unboxed scans > 0`), and only when `header.status == "in_hand"` (otherwise `lots = emptyList()` — web parity: panel shows `common_no_lots`).
- `contents` grouped per box from the contents row list.

- [ ] **Step 1: Write the failing tests** — `PutAwayDetailRepositoryTest.kt`:

```kotlin
@Test fun `loads header lots scans and boxes`()
    // synthetic in_hand order, 2 items (one with available, one fully consumed), 1 unboxed scan + 1 boxed scan
    // in one open box on shelf A-01-01 -> header fields, 1 lot (filter), scans ordered, box lineCount/totalQty/contents
@Test fun `lots are empty when order is clear`()
    // same fixture but order status 'clear' -> lots empty, scans/boxes still returned
@Test fun `lot with only unboxed scans is kept`()
    // item fully allocated (available 0) with an unboxed scan -> lot present with availableQty == 0
@Test fun `box ordering is open first then newest first`()
    // two closed boxes (older/newer) + one open -> open first, then closed newest-first
```

- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*PutAwayDetailRepositoryTest"` — verify failure.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full suite green (203 → 207).
- [ ] **Step 5:** Commit: `git add apps/android/app/src/main/java apps/android/app/src/test && git commit -m "android phase3: put-away detail read model"`

---

## Task 5: Record scans, create boxes, remove unboxed scans

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/PutAwayDao.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/PutAwayRepository.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/data/PutAwayScanAndBoxTest.kt`

Three mutations on `PutAwayRepository` (suspend + `withContext(Dispatchers.IO)` + `db.runInTransaction { … }` with `var` capture, Phase conventions; ids via `java.util.UUID.randomUUID().toString()` — check how Phase 1/2 repos generate ids and match):

```kotlin
suspend fun recordPutAwayScan(
    receivingInvoiceItemId: String, qty: Int,
    dateCode: String?, lotCode: String?, coo: String?, cow: String?,
): String   // new scan id
```

Validation order (web `recordPutAwayScan`, `apps/api/src/db/putAway.ts:53-74` + pglite error codes `apps/web/db/putAway.ts`):
1. Item exists (join parts for `part_id`) → else `LocalizedException("invoice_item_not_found")`.
2. `qty` is a positive integer (Int param, so `qty <= 0`) → `qty_must_be_positive_integer`.
3. `remaining = per-item available` (shared availability helper for that item) — `qty > remaining` → `scanned_qty_exceeds_total`.

Insert `put_away_scans` (`shelf_box_id = NULL`, per-scan date/lot/coo/cow as passed, `verified = 0`, `created_at = now`, `part_id` from the item). No status changes, no clear check.

```kotlin
suspend fun createShelfBox(orderId: String, shelfCode: String, actorId: String): String   // new box id
```

Validation (`createShelfBox`, `apps/api/src/db/putAway.ts:30-42`):
1. Order exists → `receiving_order_not_found`.
2. Shelf exists → `shelf_not_found`.

Id = `nextShelfBoxId()`: `"SBOX-" + (max + 1).toString().padStart(4, '0')` where max is the max numeric suffix over `shelf_boxes.id LIKE 'SBOX-%'` **and** `transition_logs.entity_id LIKE 'SBOX-%'` (cancelled ids never reissued — API parity, `nextShelfBoxId` :17-28). Two MAX queries:

```sql
SELECT MAX(CAST(SUBSTR(id, 6) AS INTEGER)) FROM shelf_boxes WHERE id LIKE 'SBOX-%'
SELECT MAX(CAST(SUBSTR(entity_id, 6) AS INTEGER)) FROM transition_logs WHERE entity_id LIKE 'SBOX-%'
```

Insert `shelf_boxes` (`status = 'open'`, `created_at = now`) + transition log (`entity_type = 'shelf_box'`, `entity_id = boxId`, `from_status = NULL`, `to_status = 'open'`, actor). Verify the transition-log column names against `TransitionLogEntity` and how `ReceivingRepository` writes logs — mirror them.

```kotlin
suspend fun removeScannedPiece(scanId: String)   // hard delete, unboxed only
```

Validation (`removeScannedPiece`, :76-83): scan exists → `put_away_scan_not_found`; `shelf_box_id IS NULL` → else `put_away_scan_already_boxed`. Hard delete. No clear check.

- [ ] **Step 1: Write the failing tests** — `PutAwayScanAndBoxTest.kt`:

```kotlin
@Test fun `record scan inserts unboxed row with item part`()
@Test fun `record scan rejects non positive qty`()               // expectCode("qty_must_be_positive_integer")
@Test fun `record scan rejects qty above remaining`()            // received 5, scan 6 -> expectCode("scanned_qty_exceeds_total")
@Test fun `record scan unknown item throws`()                    // expectCode("invoice_item_not_found")
@Test fun `create shelf box assigns sequential SBOX id and logs`()
    // pre-insert SBOX-0003 (open) and a cancelled-in-log SBOX-0005 -> new id == "SBOX-0006", status open, transition row written
@Test fun `create shelf box validates order and shelf`()         // shelf_not_found / receiving_order_not_found
@Test fun `remove scanned piece deletes unboxed only`()          // unboxed deleted; boxed -> expectCode("put_away_scan_already_boxed")
```

- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*PutAwayScanAndBoxTest"` — verify failure.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full suite green (207 → 214).
- [ ] **Step 5:** Commit: `git add apps/android/app/src/main/java apps/android/app/src/test && git commit -m "android phase3: put-away scan + box creation mutations"`

---

## Task 6: Box assignment, removal, close/cancel, auto-clear

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/PutAwayDao.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/PutAwayRepository.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/data/PutAwayBoxAssignmentTest.kt`

Five mutations on `PutAwayRepository` (same conventions as Task 5).

```kotlin
suspend fun assignScanToBox(scanId: String, boxId: String, actorId: String)
```

Validation order (`apps/api/src/db/putAway.ts:129-181`):
1. Scan exists → `put_away_scan_not_found`.
2. Scan unboxed → else `put_away_scan_already_boxed`.
3. Box exists → `shelf_box_not_found`; box `status == 'open'` → else `shelf_box_is_not_open`.
4. Item exists → `invoice_item_not_found`; `box.receiving_order_id == item.orderId` → else `item_does_not_belong_to_receiving_order`.

Effects (all in one transaction):
1. `put_away_scans.shelf_box_id = boxId`.
2. **Lot materialization** — upsert `inventory_lots` keyed on exactly the unique-index columns `(part_id, date_code, coo, cow, shelf_code, box_id)` (`InventoryEntities.kt:13-17` — `lot_code` is NOT part of the merge key; add a comment saying so): matching row → `total_qty += qty`, `available_qty += qty`; else insert (`allocated_qty = 0`, `total_qty = available_qty = qty`, `lot_code` from the scan, `shelf_code = box.shelfCode`, `box_id = boxId`). Id: UUID.
3. **Lot source** — upsert `inventory_lot_sources` on `(inventory_lot_id, receiving_invoice_item_id)`: `qty += scan.qty` or insert.
4. `receiving_invoice_items.put_away_qty += qty`.
5. `tryMarkReceivingOrderClear(orderId, actorId)` (below).

**Not ported (deliberate):** `scheduleCycleCount` (verification_tasks don't exist on Android — Phase 4 lists boxes directly). The scan's `verified` flag stays 0 until goods-verify.

```kotlin
suspend fun addAllUnboxedToBox(boxId: String, actorId: String): Int   // assigned count
```

Box open check (`shelf_box_not_found` / `shelf_box_is_not_open`), then `assignScanToBox` for every unboxed scan of the box's receiving order, **oldest first (`created_at ASC, id`)** (:183-195). Single transaction: if any assign throws, everything rolls back.

```kotlin
suspend fun removeScanFromBox(scanId: String, actorId: String)
```

Validation (:197-240): scan exists → `put_away_scan_not_found`; boxed → else `put_away_scan_not_boxed`; box open → else `shelf_box_is_not_open`. **Allocation guard (API parity):** if the materialized lot has any `allocations` rows (`inventory_lot_id = lot.id`) → `LocalizedException("lot_has_pick_allocations")` (the web API's unmapped 409 — Android maps it properly).

Effects: scan `shelf_box_id = NULL`, `verified = 0`; reverse lot source (`qty -= scan.qty`, delete at 0); reverse lot (`total_qty -= qty`, `available_qty -= qty`, delete at 0); `put_away_qty -= qty`; `tryMarkReceivingOrderClear` (parity — practically a no-op since removal only restores availability; web never flips clear→in_hand, and neither do we).

```kotlin
suspend fun closeShelfBox(boxId: String, actorId: String)
```

Box exists → open → `COUNT(put_away_scans) > 0` else `cannot_close_empty_shelf_box` (:256-263). `status = 'closed'` + transition log (`open → closed`) + `tryMarkReceivingOrderClear`.

```kotlin
suspend fun cancelShelfBox(boxId: String, actorId: String)
```

Box exists → open → zero scans else `shelf_box_is_not_empty` (:44-51). Transition log (`open → cancelled`), then **hard delete** the box row (id never reissued thanks to the log — Task 5 id query).

```kotlin
internal fun tryMarkReceivingOrderClear(orderId: String, actorId: String)  // called inside the mutations' transactions
```

Port of `tryMarkReceivingOrderClear` (`apps/api/src/db/putAway.ts:110-127`) using the shared availability helper: only when order `status == 'in_hand'` and **every** invoice item's available ≤ 0 (unboxed scans already subtracted — web parity: unboxed scans count as consumed) → `status = 'clear'` + transition log (`in_hand → clear`, `entity_type = 'receiving_order'`). Mirror `ReceivingRepository.tryMarkClear`'s log-writing shape; do not modify `ReceivingRepository`.

- [ ] **Step 1: Write the failing tests** — `PutAwayBoxAssignmentTest.kt`:

```kotlin
@Test fun `assign scan to box materializes lot and source and bumps put away qty`()
    // scan 4 of part P (date/lot/coo/cow set) -> box on A-01-01; assert scan boxed, lot row
    // (part, A-01-01, box, attrs, total 4, available 4), source row qty 4, item put_away_qty 4
@Test fun `assign merges into existing lot on the index columns`()
    // existing lot (same part/date/coo/cow/shelf/box, different lot_code) qty 3 + scan 2 -> single lot qty 5
@Test fun `assign rejects wrong order box and closed box`()        // item_does_not_belong_to_receiving_order; shelf_box_is_not_open
@Test fun `add all assigns oldest first and returns count`()       // 3 unboxed scans -> all boxed, count 3, add to closed box throws
@Test fun `remove from box reverses lot source and put away qty`() // assign then remove -> lot+source deleted, put_away_qty 0, scan unboxed
@Test fun `remove from box refuses when lot has allocations`()     // insert allocation on the lot -> expectCode("lot_has_pick_allocations")
@Test fun `close box requires items and logs`()                    // empty -> cannot_close_empty_shelf_box; with scan -> closed + transition row
@Test fun `cancel box hard deletes with cancelled log`()           // empty open box deleted, transition row open->cancelled; non-empty -> shelf_box_is_not_empty
@Test fun `order auto clears when last item put away`()
    // two items: one already consumed, other scanned+assigned -> order status 'clear' + receiving_order transition log
@Test fun `assign rollback on mid-transaction failure`()
    // addAll over 2 scans where the box closes between (simulate by pre-closing? simplest: addAll against a box that
    // fails the second assign via item-order mismatch fixture) -> first scan's assignment rolled back (mutation-proven)
```

(For the rollback test, construct a fixture where the first unboxed scan belongs to the box's order and the second to a different order — `item_does_not_belong_to_receiving_order` on the second — then assert the first scan is still unboxed.)

- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*PutAwayBoxAssignmentTest"` — verify failure.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full suite green (214 → 224).
- [ ] **Step 5:** Commit: `git add apps/android/app/src/main/java apps/android/app/src/test && git commit -m "android phase3: put-away box assignment + auto-clear"`

---

## Task 7: Put-away scan matcher (domain)

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/scan/ScanMatcher.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/scan/MatchPutAwayTest.kt`

Port `matchPutAway` (`apps/web/composables/useScanMatchers.ts:225-264`). Pure function over the pinned lot — no DAO, no new constructor seams. Add to `ScanMatcher.kt`:

```kotlin
/** A pinned put-away target: one receiving invoice item (lot card). */
data class PinnedPutAwayItem(
    val receivingInvoiceItemId: String,
    val partNo: String,               // normalized (ScanPrimitives.normalize)
    val availableQty: Int,            // live-computed remaining for this item
)

sealed class PutAwayMatchResult {
    data class Single(val item: PinnedPutAwayItem, val qty: Int) : PutAwayMatchResult()
    data class Error(val key: String) : PutAwayMatchResult()
}

/** Port of useScanMatchers.matchPutAway: validates parsed fields against the pinned lot. */
fun matchPutAway(
    item: PinnedPutAwayItem?,
    parsed: ScanPrimitives.OcrInput,
    actorId: String?,
): PutAwayMatchResult {
    if (actorId == null) return PutAwayMatchResult.Error("operator_not_signed_in")
    if (item == null) return PutAwayMatchResult.Error("invalid_receiving_item")
    val p = try {
        ScanPrimitives.parseManual(parsed)      // throws qty_must_be_positive_integer
    } catch (e: LocalizedException) {
        return PutAwayMatchResult.Error(e.code)
    }
    if (p.partNo != item.partNo) return PutAwayMatchResult.Error("scanned_part_does_not_match_item")
    if (p.qty > item.availableQty) return PutAwayMatchResult.Error("quantity_exceeds_available")
    return PutAwayMatchResult.Single(item, p.qty)
}
```

Notes:
- Validation order follows the Android `matchPicking` precedent (actor → target → parse → part → qty bound), not the web's part-before-qty order — behaviorally identical for all specified cases; the web's empty-part `none` result maps to `scanned_part_does_not_match_item`, which opens the same review dialog (Phase 2 precedent).
- Web checks `receivingItem.receivingInvoiceItemId` presence with `invalid_receiving_item`; in Android the pin carries the id, so a null pin is the equivalent guard.
- Date/lot/coo/cow are NOT validated (web parity — taken from the label as-is at apply time).
- `Single` carries the validated qty (Task 6-of-Phase-2 precedent — consumer must not re-parse).

- [ ] **Step 1: Write the failing tests** — `MatchPutAwayTest.kt` (plain JVM, `ScanMatcherTest`/`MatchPickingTest` style; construct `ScanMatcher` with `{ emptyList() }` stub lambdas):

```kotlin
private val pin = ScanMatcher.PinnedPutAwayItem("rii-1", "RK73H1JTTD6201F", 10)
private fun input(partNo: String = "RK73H1JTTD6201F", qty: String = "4") =
    ScanPrimitives.OcrInput(partNo, "", "", "", "", qty)
```

(Verify `OcrInput`'s real constructor and adjust the helper — partNo first, qty last.)

- `single when fields match pin` → `Single(pin, 4)`
- `part mismatch` → `Error("scanned_part_does_not_match_item")`
- `qty exceeds available` (qty "11") → `Error("quantity_exceeds_available")`
- `non positive qty` (qty "0") → `Error("qty_must_be_positive_integer")`
- `missing pin` → `Error("invalid_receiving_item")`
- `not signed in` → `Error("operator_not_signed_in")`

- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*MatchPutAwayTest"` — verify failure.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full suite green (224 → 230).
- [ ] **Step 5:** Commit: `git add apps/android/app/src/main/java apps/android/app/src/test && git commit -m "android phase3: put-away scan matcher"`

---

## Task 8: Put-away list screen + nav

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/putaway/PutAwayListViewModel.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/putaway/PutAwayListScreen.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/navigation/AppNav.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/home/HomeScreen.kt` (Put Away card navigates)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/AppContainer.kt` (factory entry)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/ui/putaway/PutAwayListViewModelTest.kt`

Web reference: `apps/web/pages/put-away/index.vue`. Behavior:

- **No search, no filter chips** (web parity — unlike receiving/picking lists). Hint text `put_away_hint` under the title.
- Rows: whole card clickable → detail; refNo + receiving status badge (`StatusBadge(status, family = "receiving")` — `in_hand`) + supplier (`common_no_supplier` fallback) + footer `put_away_available` with the order's availableQty.
- Empty: `common_no_receiving_orders_need_put_away`; spinner on first load; reload via `OnResumeEffect`; error via `ErrorText`.

VM (constructor: `PutAwayListSource` interface { `suspend fun listCandidates(): List<PutAwayCandidate>` } — `PutAwayRepository` opts in; `io` dispatcher):

```kotlin
data class PutAwayListUiState(
    val loading: Boolean = true,
    val orders: List<PutAwayCandidate> = emptyList(),
    val errorKey: String? = null,
    val errorArgs: List<String> = emptyList(),
)
```

Race-safe `loadJob` reload (Phase 1 pattern).

`AppNav.kt`:

```kotlin
const val PUT_AWAY_LIST = "put-away"
const val PUT_AWAY_DETAIL = "put-away/{orderId}"
fun putAwayDetail(orderId: String) = "put-away/$orderId"
```

`composable(Routes.PUT_AWAY_LIST) { PutAwayListScreen(onOrderClick = { navController.navigate(Routes.putAwayDetail(it)) }) }`; placeholder detail composable showing the order id (replaced in Task 9). `HomeScreen.kt`: the Put Away `MenuCard` gets `Routes.PUT_AWAY_LIST` (currently route-less → "coming soon" toast at `HomeScreen.kt:87`). `AppContainer`: factory entry `PutAwayListViewModel(putAwayRepository)`.

- [ ] **Step 1: Write the failing VM tests** — `PutAwayListViewModelTest.kt` (fakes + `Dispatchers.setMain` pattern from `ReceivingListViewModelTest`):

```kotlin
@Test fun `loads candidates`() = runTest { /* fake 2 orders -> 2 in state, loading false */ }
@Test fun `empty list renders empty state`() = runTest { /* fake empty -> orders empty, no error */ }
@Test fun `repository error surfaces as errorKey`() = runTest { /* fake throws LocalizedException("...") -> errorKey set, loading false */ }
```

- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*PutAwayListViewModelTest"` — verify failure.
- [ ] **Step 3:** Implement VM + screen + nav wiring. Follow `PickingListScreen.kt` layout idioms (Scaffold + TopAppBar `put_away_title`, LazyColumn cards) minus search and selection.
- [ ] **Step 4:** Full suite green (230 → 233) + `./gradlew :app:assembleDebug`.
- [ ] **Step 5:** Commit: `git add apps/android/app/src/main/java apps/android/app/src/test apps/android/app/src/main/res && git commit -m "android phase3: put-away list screen + nav"`

---

## Task 9: Put-away detail screen — header, lots, boxes

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/putaway/PutAwayDetailViewModel.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/putaway/PutAwayDetailScreen.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/putaway/PutAwayLotsSection.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/putaway/ShelfBoxesSection.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/putaway/SelectShelfDialog.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/navigation/AppNav.kt` (replace placeholder)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/ui/putaway/PutAwayDetailViewModelTest.kt`

Web references: `apps/web/pages/put-away/[id].vue`, `apps/web/components/put-away/ShelfBoxesPanel.vue`, `PutAwayLotsPanel.vue`, `apps/web/components/SelectShelfDialog.vue`.

Screen behavior:

- **Header** (DetailHeader-style card, expandable like picking): refNo + `StatusBadge(status, "receiving")`; rows: `put_away_detail_supplier` (fallback `common_no_supplier`), `put_away_detail_delivery_date`.
- **Lots section** (`PutAwayLotsSection.kt`, port of `PutAwayLotsPanel.vue`): title `put_away_lots_title`; empty → `common_no_lots`. Per lot card: `put_away_part` (partNo, `common_no_data` fallback), `put_away_date_lot` (`{dateCode|—} / {lotCode|—}`), `put_away_coo_cow` (`{coo|—} / {cow|—}`), `put_away_total_qty`, `put_away_scanned_qty`, `put_away_boxed_qty`, a **Scan** button (wired in Task 10 — render behind `scanEnabled: Boolean = false`, Task 9 screens pass false), and a scans toggle `put_away_show_scans`/`put_away_hide_scans` (with count). Scan rows for this lot (`scans.filter { it.receivingInvoiceItemId == lot.receivingInvoiceItemId }` — client-side grouping like the web): `"{qty} {common_pcs}"` + per-scan `{dateCode|—} / {lotCode|—} / {coo|—} / {cow|—}` + status text (`common_in_box` with boxId, or `common_unboxed` in warning color). Actions: unboxed scan → box selector (`put_away_select_box`, options = **open** boxes of this order) + Add to box (`put_away_add_to_box`, disabled until a box is selected) + Remove scan (`put_away_remove_scan`); boxed scan in an **open** box → Remove from box (`put_away_remove_from_box`); boxed scan in a closed box → no actions. Box-selection state screen-held (`remember` map scanId→boxId, pruned on reload — Phase 2 picking precedent).
- **Boxes section** (`ShelfBoxesSection.kt`, port of `ShelfBoxesPanel.vue`): header `put_away_boxes_title` + New box button when `status != "clear"` (`put_away_new_box`) + Show/Hide toggle (collapsed by default). Boxes grouped by shelf (`common_shelf_format` header `{code} — {zone}`, `common_unassigned` fallback group), preserving the DAO order within groups. Per box card: id, `StatusBadge(status, family = "box")`, `put_away_box_lines_qty` (lineCount, totalQty), expandable contents (`{partNo|—} × {qty}` per part). Open-box actions: **Add all** (`put_away_add_all`, disabled when the order's unboxed-scan count is 0) → confirm `AlertDialog` (`put_away_add_all_confirm` with count) → delegates; **Close box** (`put_away_close_box`) only when `lineCount > 0`; **Cancel box** (`put_away_cancel_box`) only when `lineCount == 0`. Empty → `common_no_boxes`.
- **SelectShelfDialog** (AlertDialog port of `SelectShelfDialog.vue`): title `select_shelf_title`, dropdown of `shelves` (`common_shelf_format` labels, `select_shelf_default` placeholder), Confirm disabled until a shelf is chosen → `vm.createBox(shelfCode)`; cancel/dismiss.
- All mutations through the VM (`runAction` pattern: serialized, `actionInProgress`, `LocalizedException` → `errorKey`+`errorArgs`, reload on success; add-all pending-confirm via `pendingAddAllBoxId` — Phase 2 picking precedent, `canFinish`-style computed props where a business rule appears in the UI).
- `OnResumeEffect { viewModel.reload() }`; `collectAsStateWithLifecycle`; `ErrorText(state.errorKey, args = state.errorArgs)` in the header card.

VM (constructor: `orderId`, `PutAwayDetailSource` interface — `getPutAwayDetail`, `createBox`, `assignScanToBox`, `addAllToBox`, `removeScanFromBox`, `removeScannedPiece`, `closeBox`, `cancelBox` — `PutAwayRepository` opts in; `SessionSource` reused from `ui/receiving/` via import; `io` dispatcher):

```kotlin
data class PutAwayDetailUiState(
    val loading: Boolean = true,
    val detail: PutAwayDetail? = null,
    val errorKey: String? = null,
    val errorArgs: List<String> = emptyList(),
    val actionInProgress: Boolean = false,
    val pendingAddAllBoxId: String? = null,
    val showShelfDialog: Boolean = false,
    val toastKey: String? = null,
)
```

`provideFactory(container, orderId)` companion mirroring `PickingDetailViewModel.provideFactory`. Init-load + `OnResumeEffect` (accepted double-first-query pattern). Success toasts: create box → none (box appears), assign/remove/close/cancel → none required by the web (web shows no toasts here — errors only); do not add speculative toasts.

- [ ] **Step 1: Write the failing VM tests** — `PutAwayDetailViewModelTest.kt` (fakes; fake `SessionSource` shape from `ReceivingDetailViewModelTest`):

```kotlin
@Test fun `loads detail on init`() = runTest { /* fake detail -> header id, lots, boxes in state */ }
@Test fun `create box delegates and reloads`() = runTest { /* showShelfDialog flow: open dialog, createBox("A-01-01") -> fake called with (orderId, shelf, actor), dialog closed, reloaded */ }
@Test fun `add all requires confirm then delegates`() = runTest { /* requestAddAll("box-1") -> pending; confirmAddAll() -> fake called, pending cleared */ }
@Test fun `cancel box delegates and reloads`() = runTest { ... }
@Test fun `repository error surfaces as errorKey`() = runTest { /* fake closeBox throws LocalizedException("cannot_close_empty_shelf_box") -> errorKey, actionInProgress false */ }
```

- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*PutAwayDetailViewModelTest"` — verify failure.
- [ ] **Step 3:** Implement per the behavior spec. Keep `PutAwayDetailScreen.kt` to scaffold/header/dialog wiring; sections as LazyListScope extensions in their own files (Phase 2 `PickingItemsSection.kt` precedent). Wire the `AppNav` detail route.
- [ ] **Step 4:** Full suite green (233 → 238) + `./gradlew :app:assembleDebug`.
- [ ] **Step 5:** Commit: `git add apps/android/app/src/main/java apps/android/app/src/test apps/android/app/src/main/res && git commit -m "android phase3: put-away detail screen"`

---

## Task 10: Scan-to-put-away wiring

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/putaway/PutAwayDetailViewModel.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/putaway/PutAwayDetailScreen.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/putaway/PutAwayLotsSection.kt` (enable Scan buttons)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/PutAwayRepository.kt` (interface opt-in extension)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/ui/putaway/PutAwayDetailScanTest.kt`

Web references: `apps/web/pages/put-away/[id].vue:298-323` (openScan/retake/toast), `apps/web/composables/useScanMatchers.ts:225-264` (matchPutAway), `apps/web/composables/useLabelScan.ts:117-133` (single auto-apply, error toast, none → review).

Behavior (web parity — deliberately narrower than picking):

- **No ScanFab, no manual-entry button, no hardware wedge** (web put-away has none — `useHardwareScanner` is not used by the web put-away pages). Scan entry point: per-lot Scan buttons only.
- **Per-lot Scan** → `vm.pinLot(lot)` then launch the camera (`rememberCameraScanLauncher`, `ui/receiving/ScanLaunchers.kt`). Enable the Task 9 buttons (`scanEnabled = true`).
- **Scan result handling**: QR/barcodes → `QrParser.parseQrCapture` (templates from `ScanRepository.supplierQrTemplates()`, context supplier = `detail.header.supplierCode`, targets = the pinned lot's partNo — web passes `targets: [lot.partNo]`) with `OcrLabelParser.parseAndIdentify` fallback — reuse the Phase 1/2 `provideFactory` wiring pattern (the `LabelScanParser` seam in `ui/scan/`).
- **Pinned flow**: `matchPutAway(pin, fields, actorId)`:
  - `Single` → **auto-apply immediately, no dialog** (web: put-away never sets `confirmSingleMatch`): `recordPutAwayScan(item.receivingInvoiceItemId, qty, dateCode, lotCode, coo, cow)` — qty from `Single.qty` (no re-parse), ancillary fields normalized like Phase 2 (`ancillaryFields` helper precedent: `normalizeCode` for date/lot, `normalize` for coo/cow, empty → null). Success → toast `common_scan_success` + clear pin + reload. `LocalizedException` failure → toast `errorMessage(code, args)` (web toasts scan errors on this page).
  - `Error` (e.g. `scanned_part_does_not_match_item` from OCR noise) → open the review dialog (`ui/scan/LabelScanReviewDialog`) in mode `manual = (imagePath == null)`, fields editable, Find match re-runs `matchPutAway` against the same pin with edited fields; on `Single` the dialog shows one match option (`"{partNo} ({qty})"` — pinned partNo + parsed qty, `R.string.scan_review_match_single`) and Apply dispatches exactly like the auto-apply path; success → toast + close + clear pin + reload; failure → inline `applyErrorKey` (dialog stays open). Retake (review mode) → relaunch camera with the same pin. Cancel → close, clear pin.
- **Apply dispatch seam**: add to `PutAwayDetailSource`: `suspend fun recordScan(receivingInvoiceItemId: String, qty: Int, dateCode: String?, lotCode: String?, coo: String?, cow: String?): String` (→ `PutAwayRepository.recordPutAwayScan`).
- Reuse the Phase 2 Task 10 hardening verbatim: `scanInFlight` transient gate (set before parse, cleared on every terminal path — dialog path hands off to `dialogOpen`), `dialogOpen = true` at dialog entry, `runAction(scanApply = true)` semantics for the apply path (inline `applyErrorKey` when the dialog is open, error toast otherwise). Read `ui/picking/PickingDetailViewModel.kt` and mirror the structure with put-away names.

VM additions to `PutAwayDetailUiState`:

```kotlin
val scanPin: ScanMatcher.PinnedPutAwayItem? = null,
val scanReview: ScanReviewUiState? = null,     // ui.scan
val dialogOpen: Boolean = false,
val toastArgs: List<String> = emptyList(),
```

VM functions: `pinLot(lot: PutAwayLotDetail)`, `onCameraScan(result: CameraScanResult)`, `findMatch()`, `applyScan(optionId: String)`, `updateScanFields(fields)`, `retakeScan()`, `closeScanReview()`, private `applyScanned(pin, fields, qty)` with the `runAction` wrapping.

- [ ] **Step 1: Write the failing tests** — `PutAwayDetailScanTest.kt` (fakes extending the Task 9 doubles + fake `LabelScanParser`; `matchPutAway` is pure — use the real `ScanMatcher`):

```kotlin
@Test fun `pinned single match auto applies without dialog`() = runTest {
    // detail with one lot (available 10); vm.pinLot(it); vm.onCameraScan(parsed fields partNo+qty 4)
    // assert fake recordScan called with (itemId, 4, date/lot/coo/cow normalized); scanReview == null; toastKey == scan success; reloaded
}
@Test fun `match error opens review dialog`() = runTest {
    // scan partNo != pin partNo -> scanReview != null, dialogOpen == true, fields pre-filled
}
@Test fun `review dialog find match then apply`() = runTest {
    // after error dialog: updateScanFields(corrected); findMatch(); assert one matchOption
    // applyScan(optionId) -> fake recordScan called, dialog closed, toast
}
@Test fun `auto apply error toasts without dialog`() = runTest {
    // fake recordScan throws LocalizedException("scanned_qty_exceeds_total") -> scanReview null, toastKey == code, dialogOpen false
}
@Test fun `dialog apply failure shows inline error and stays open`() = runTest {
    // error dialog path, fake recordScan throws -> applyErrorKey set, dialogOpen true, no toast
}
@Test fun `retake keeps pin and clears dialog`() = runTest {
    // camera review path (imagePath != null) -> retakeScan() -> scanReview null, dialogOpen false, scanPin intact
}
```

- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*PutAwayDetailScanTest"` — verify failure.
- [ ] **Step 3:** Implement VM additions + screen wiring per the behavior spec. Reuse `PickingDetailScreen.kt`'s camera-launcher wiring as the template (no wedge block — put-away has none).
- [ ] **Step 4:** Full suite green (238 → 244) + `./gradlew :app:assembleDebug`.
- [ ] **Step 5:** Commit: `git add apps/android/app/src/main/java apps/android/app/src/test apps/android/app/src/main/res && git commit -m "android phase3: scan-to-put-away wiring"`

---

## Task 11: Docs, verification, Phase 4 handoff notes

**Files:**
- Modify: `AGENTS.md` (Android section: put-away screens, `PutAwayRepository`, `matchPutAway`, Phase 3 complete status + test count)
- Modify: `docs/app-docs/ai/feature-registry.md` + `docs/app-docs/ai/code-map.md` (short additions — put-away flow files)
- Modify: `docs/superpowers/plans/2026-07-12-native-android-phase-3.md` (append handoff notes at the end)

- [ ] **Step 1: Full verification**

```bash
cd apps/android && export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr' && export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

Expected: full suite PASS (249 — the Task 10 trajectory predicted 244; the actual final count is 249), APK builds.

- [ ] **Step 2: On-device walkthrough (if a device is connected)**

```bash
'/d/android/platform-tools/adb.exe' devices
./gradlew :app:installDebug
```

Walk with adb screencap + taps (Phase 1/2 technique; login operator / DocPal2026!; Simeji IME doubles `input text` — delete duplicated chars; wedge payloads can be injected via adb key events):
1. Home → Put Away card → candidate list renders (seed order `04958166`, KOA, available count, `in_hand` badge, hint text).
2. Open the order: header, lots cards, boxes section (empty), shelf dialog opens from New box → create a box on `A-01-01` → box appears.
3. Scan a piece: inject a KOA QR payload for one of the order's parts via the wedge key events is NOT possible here (no wedge on this screen) — instead use the camera path if a label can be shown to the camera, otherwise defer camera-scan and verify the scan pipeline through JVM tests (already done); at minimum verify the Scan button launches the camera activity.
4. If a scan was applied (or a scan was created through the review dialog's manual fields — the dialog IS reachable via a mismatching synthetic scan if camera works): unboxed scan row appears → assign to the box → boxed; Add all confirm; Close box.
5. Put away everything reachable and confirm the order auto-clears (status badge `clear`, order leaves the candidate list on return).
6. **Wedge KeyUp regression check (Task 2):** on the picking detail, inject a wedge payload via adb key events ending in Enter and confirm the detail screen no longer pops back to the list after the flush.
Record verified-vs-deferred honestly (camera label scan needs a physical label — likely deferred, as in Phases 1-2).

- [ ] **Step 3: Update docs** — short additions only; link to this plan rather than duplicating.

- [ ] **Step 4: Append `## Phase 4 handoff notes` to this plan**

Cover:
- What Phase 4 (goods verify) reuses: shelf boxes + put-away scans with `verified` flags (`verified_at`), the boxes-by-shelf grouping UI, scan pipeline end to end, `ui/scan/LabelScanReviewDialog`, ScanMatcher sibling pattern. **Critical:** Android does NOT schedule cycle-count `verification_tasks` (the API's `scheduleCycleCount` was deliberately not ported — no such table) — Phase 4 must list shelves/boxes directly instead of reading verification tasks; verify against the web goods-verify flow when planning.
- Known gaps inherited: `materializeReceivingAllocation` still has no production caller (put-away does its own lot upsert keyed on the inventory_lots unique index — `lot_code` not in the merge key); `removeScannedPackage` first-source-restore bug still open (web + Android); seam interfaces `ReceivingDetailSource`/`MismatchSource`/`SessionSource`/`PickingSource` still in `ui/receiving/ReceivingDetailViewModel.kt`; `matchMessageRes` doubles as state-kind discriminator in the scan dialog; wedge `scannedQty = 0` simplification on picking; remove-from-box does not flip `clear` back to `in_hand` (web parity); once an order is `clear`, unboxed scans are unreachable in the put-away UI (web parity — goods-verify/stock-search phases read them from other angles).
- Deferred verifications from Step 2.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/app-docs/ai/feature-registry.md docs/app-docs/ai/code-map.md docs/superpowers/plans/2026-07-12-native-android-phase-3.md
git commit -m "android phase3: docs + handoff notes"
```

---

## Self-review checklist (completed during plan writing)

- [x] Spec coverage: Phase 3 row of the design spec — receiving order list ✓ (Tasks 3, 8), detail ✓ (Tasks 4, 9), create shelf-box labels ✓ (Tasks 5, 9 — web creates rather than scans box labels; noted), scan items into shelf boxes ✓ (Tasks 5-7, 10), lots panel ✓ (Tasks 4, 9), close boxes ✓ (Tasks 6, 9). Exit criteria "put-away flow reproducible" covered by Tasks 5/6 (repo tests prove scan→box→clear) + 11 (device walkthrough).
- [x] Web behavior sources cited per task with file:line (API authoritative + pglite error codes; divergences flagged: no cycle-count scheduling, no wedge/manual scan entry, `lot_code` outside the lot merge key per the Android unique index).
- [x] Error keys traced from `apps/api/src/db/putAway.ts` / `apps/web/db/putAway.ts` / `useScanMatchers.ts` to the Task 1 string list, incl. the API's unmapped 409s mapped to proper codes (`lot_has_pick_allocations`, `item_does_not_belong_to_receiving_order`).
- [x] Reuse verified against the actual code: `PutAwayScanEntity`/`ShelfBoxEntity`/`ShelfEntity`/`InventoryLot(Source)Entity` shapes, `ReceivingDao.unboxedPutAwayScanTotals` + `AllocationDistributor`, `LabelScanParser` seam in `ui/scan/`, `ScanPrimitives`, fixture helpers in `domain/PickingDbFixture.kt`, `StringsParityTest`, `StatusBadge` families (receiving + box cover put-away).
- [x] Deliberate deviations documented: no `scheduleCycleCount`/`verification_tasks`; no wedge/manual-entry on put-away (web parity); matcher error order follows the Android `matchPicking` precedent; empty-part scan surfaces as `scanned_part_does_not_match_item` (web `none`) — same review-dialog UX; box id `SBOX-%04d` global (API-style, not the pglite `SBOX-HK1-…`).
- [x] Type consistency: `PutAwayCandidate`, `PutAwayOrderHeader`/`PutAwayLotDetail`/`PutAwayScanDetail`/`PutAwayBoxDetail`/`PutAwayBoxContent`/`ShelfOption`/`PutAwayDetail`, `PinnedPutAwayItem`, `PutAwayMatchResult`, `PutAwayListSource`/`PutAwayDetailSource` defined once and used consistently; `PutAwayDetailSource` introduced in Task 9 and extended in Task 10 with exact signatures.
- [x] Every task has failing-test-first steps (except the two non-logic tasks: strings, wedge fix — both have explicit verification), exact commands, and a commit step.
- [x] Test-count trajectory: 199 → 199 (T1) → 199 (T2) → 203 (T3) → 207 (T4) → 214 (T5) → 224 (T6) → 230 (T7) → 233 (T8) → 238 (T9) → 244 (T10) → verified at T11.

---

## Phase 4 handoff notes

Phase 3 verification (Task 11, 2026-07-12): 249 JVM tests green
(`./gradlew :app:testDebugUnitTest`, 0 failures/errors/skips across 39 test
classes), `assembleDebug` and `installDebug` clean on device
`MFM5PRE526010002`. All six device walkthrough items were exercised — see
"Deferred verifications" below for what could not be done through adb.

### What Phase 4 (goods verify) reuses

- **Shelf boxes + put-away scans.** `PutAwayRepository` writes `shelf_boxes`
  (`SBOX-%04d` global numbering, API-style) and `put_away_scans` rows. Scans
  carry `verified` / `verified_at` flags that Phase 3 never sets — goods
  verify is the consumer that flips them.
- **Boxes-by-shelf grouping UI.** The put-away detail's boxes section
  (`ui/putaway/PutAwayDetailScreen.kt`) groups boxes by shelf with per-box
  contents and a Close action — the natural starting point for a
  shelf→box→scan verify list.
- **Scan pipeline end to end** — camera (`scanner/RectangleCameraActivity`
  via `ui/receiving/ScanLaunchers.kt`), QR-template-first parsing
  (`QrParser` → `OcrLabelParser` fallback), `ScanMatcher`. Note: put-away
  has no wedge/manual scan entry (web parity), so the camera launcher +
  review dialog is the only scan entry on that screen.
- **`ui/scan/LabelScanReviewDialog` + `ScanReviewUiState`** — now consumed
  by receiving, picking, and put-away. See the known gap about
  `matchMessageRes` below before adding a fourth consumer.
- **ScanMatcher sibling pattern** — `ScanMatcher.matchPutAway`
  (`domain/scan/ScanMatcher.kt`) is the third sibling after
  `matchReceiving`/`matchPicking`; a goods-verify matcher context follows
  the same shape (`OcrInput` in, sealed result out, single match
  auto-applies, match error opens the review dialog).
- **CRITICAL: no `verification_tasks` table.** The API's
  `scheduleCycleCount` was deliberately not ported — Android has no
  verification-task entity and no scheduling path. Phase 4 must list
  shelves/boxes directly (e.g. from `shelf_boxes` + `put_away_scans` where
  `verified = 0`) instead of reading verification tasks. Verify against the
  web goods-verify flow (`apps/web/pages/goods-verify/`, the API's
  goods-verify/verification-task queries) when planning.

### Known gaps / corrections

- **`materializeReceivingAllocation` still has no production caller**
  (carried over from the Phase 2 handoff). Put-away does its own lot upsert
  keyed on the `inventory_lots` unique index — `lot_code` is NOT in the
  merge key, a deliberate divergence from the web (which merges on lot_code).
  If Phase 4 doesn't adopt the function either, delete it.
- **`removeScannedPackage` first-source-restore bug** — inherited from the
  web, still open on both sides (first flagged in the Phase 2 handoff).
- **Seam interfaces still in `ui/receiving/ReceivingDetailViewModel.kt`**
  (`ReceivingDetailSource`/`MismatchSource`/`SessionSource`/`PickingSource`)
  — the Phase 3 cleanup suggested in the Phase 2 handoff did not happen.
  Phase 3 instead followed the newer pattern: `PutAwayListSource` /
  `PutAwayDetailSource` live next to their own ViewModel in `ui/putaway/`.
- **`matchMessageRes` doubles as the state-kind discriminator** in
  `LabelScanReviewDialog.kt` (Apply-button visibility is keyed on the
  message string resource). Put-away reused the existing message kinds; a
  goods-verify consumer that needs new wording must add an explicit
  state-kind field to `ScanReviewUiState` first.
- **Wedge `scannedQty = 0` simplification** on picking (inherited,
  POC-acceptable).
- **Remove-from-box does not flip `clear` back to `in_hand`** (web parity).
- **Once an order is `clear`, its unboxed scans are unreachable in the
  put-away UI** (web parity — goods-verify/stock-search phases read them
  from other angles).
- **`PutAwayRepository.listCandidates` runs N+1 totals queries** (one per
  candidate order; Phase 3 review note). Defensible at POC scale — the seed
  has a single candidate; revisit with one grouped query if the list grows.
- **Task 2's wedge KeyUp fix blanket-consumes Enter KeyUp on detail
  screens** (intentional): keypad-Enter button activation is disabled while
  the hardware-key buffer is enabled. Touch is unaffected (verified on
  device — the picking-detail log toggle still expands via tap).

### Deferred verifications (from Task 11 Step 2)

Verified on device (screencap-confirmed; shots in
`apps/android/build/walkthrough/`):

- Login (operator / DocPal2026!), put-away candidate list (seed order
  `04958166`, KOA, 可用 8914000, 已收貨 badge, hint text).
- Put-away detail: header, lots panel, New box → shelf dialog → `SBOX-0001`
  created on shelf `A-01-01`.
- Scan button launches `RectangleCameraActivity` (camera permission grant
  flow exercised).
- Assign flow: unboxed scan row → select `SBOX-0001` → assign → boxed
  (在箱 SBOX-0001 內).
- Add-all confirm dialog (將 264 個未裝箱掃描加入此箱？) → 265 lines boxed →
  **order auto-cleared on the last assign** (header badge 已完成, lots panel
  沒有可上架的批次, New-box action gone).
- Close box (已關閉); back → list empty state 沒有需要上架的收貨單.
- Wedge KeyUp regression check (Task 2 fix): on the picking detail, an
  adb-keyevent wedge payload ending in Enter flushed without popping the
  screen back to the list; the toast "Receiving order is not in hand" proved
  the flush was processed end to end (rejected because the put-away
  walkthrough had already cleared allocation source `04958166` — expected
  cross-flow consistency, not a bug).

Not fully exercised:

- **Camera label scan** — needs a physical label; deferred (as in Phases
  1–2). The camera activity launch itself was verified.
- **Put-away scan rows were DB-injected** rather than camera-created (no
  label available, and put-away has no wedge/manual entry). The
  assign / add-all / close / auto-clear UI paths themselves were genuinely
  exercised on device against real Room state.

Device state note: the walkthrough left the device DB with `04958166`
cleared and `SBOX-0001` closed on `A-01-01` holding 265 put-away lines
(~21.76M qty), all unverified — a useful starting state for the Phase 4
goods-verify walkthrough.
