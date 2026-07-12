# Native Android Phase 2 — Picking Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the web picking flow to native Android: picking order list with multi-select batch issue report, picking order detail (items, allocations, boxes), scan-to-pick, and finish → measuring task creation.

**Architecture:** Continue the Phase 1 structure in `apps/android`: Room DAOs + suspend repositories in `data/`, pure domain logic in `domain/`, Compose screens + StateFlow ViewModels in `ui/`. Phase 1 already ported most picking mutations (`scanAllocationToPackage`, `applyOcrPick`, box ops, `maybeAutoFinishPickingOrder`); this phase adds the missing mutations (batch issue, cancel box, manual finish), the read models for list/detail, the picking-context scan matcher, and all UI.

**Tech Stack:** Kotlin 2.1.20, Jetpack Compose (Material 3), Navigation-Compose, Room, Robolectric 4.14.1 JVM tests (`@Config(sdk = [34])`), kotlinx-coroutines-test.

**Web sources of truth (read-only — never modify `apps/web`):**
- List + batch issue: `apps/web/pages/picking/index.vue`, `apps/web/components/PickingIssueReportModal.vue`, `apps/web/db/picking.ts:473-550`
- Detail: `apps/web/pages/picking/[id].vue`, `apps/web/components/picking/{PickingItemsSection,PickingBoxesSection,PickingIssueBanner}.vue`, `apps/web/db/picking.ts`, `apps/web/db/ocrPicking.ts`
- Scan matching: `apps/web/composables/useScanMatchers.ts:177-223` (`matchPicking`), `apps/web/pages/picking/[id].vue:163-179` (`findMatchingAllocation`)
- i18n: `apps/web/i18n/locales/{en-US,zh-CN,zh-HK}.ts`

---

## Conventions (established in Phase 1 — every task must follow)

- **Gradle:** `cd apps/android && export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr' && export PATH="$JAVA_HOME/bin:$PATH" && ./gradlew :app:testDebugUnitTest` (add `:app:assembleDebug` for UI tasks).
- **Git:** other agents commit unrelated work to master (`apps/api`, `apps/web`). Stage ONLY `apps/android` paths explicitly (and the specific doc files in Task 11). Never `git add -A`. The working tree may contain an unrelated regenerated `apps/android/app/src/main/assets/seed.sql` — leave it alone, never stage it.
- **Repositories:** suspend entry points wrap DAO work in `withContext(Dispatchers.IO)`; multi-write mutations self-wrap in `db.runInTransaction { }` (nested calls join the outer transaction). Errors are `LocalizedException(code, params)` with the web's exact error keys; UI resolves them via `errorMessage(key, args)` in `ui/components/ErrorText.kt`.
- **ViewModels:** constructor-injected `io: CoroutineDispatcher = Dispatchers.IO`; race-safe reload via `private var loadJob: Job?` (cancel previous, capture params before launch, try/catch rethrowing `CancellationException`); mutations serialized through a `runAction` helper guarded by `actionInProgress`; test seams are small `interface ...Source` types the real repositories opt into; per-orderId screens use a `provideFactory(container, id)` companion (see `ReceivingDetailViewModel`).
- **UI:** Material 3; reuse `ui/components/`: `StatusBadge(status, family)`, `DetailRow`, `EmptyState`, `ErrorText`, `OnResumeEffect`. Dates: `SimpleDateFormat("yyyy-MM-dd", Locale.US)` + `TimeZone.getDefault()` (minSdk 24, no desugaring — do NOT use java.time).
- **Strings:** trilingual `res/values{,-zh-rCN,-zh-rTW}/strings.xml`; English source of truth, zh texts taken from `apps/web/i18n/locales/zh-CN.ts` / `zh-HK.ts`; `StringsParityTest` enforces key-set identity. `%1$d` only ever receives Int; `%1$s` only String.
- **Tests:** Robolectric `@RunWith(RobolectricTestRunner::class)` + `@Config(sdk = [34])`; in-memory seeded DB via `AppDatabase.build(context, inMemory = true)` (seeds from `assets/seed.sql`); Room sync calls inside `offMainThread { }` (`DbTestSupport.kt`); **never hardcode seed UUIDs** — look up ids by business key (`ReceivingRepositoryTest.partIdOf` pattern) or build synthetic fixtures with deterministic ids (`PickingRepositoryTest.insertBaseFixture` pattern); VM tests use `Dispatchers.setMain(StandardTestDispatcher())` + fakes implementing the source interfaces.

---

## Task 1: i18n strings for the picking flow

**Files:**
- Modify: `apps/android/app/src/main/res/values/strings.xml`
- Modify: `apps/android/app/src/main/res/values-zh-rCN/strings.xml`
- Modify: `apps/android/app/src/main/res/values-zh-rTW/strings.xml`

Add every key below to all three files. English texts are authoritative (from `apps/web/i18n/locales/en-US.ts`); zh-CN/zh-HK texts come from the corresponding web locale files (look each key up there; the web keys are dotted, e.g. `picking.itemsSection.title` → `picking_items_section_title`).

**Picking list + detail chrome:**

```xml
<string name="picking_title">Picking</string>
<string name="picking_detail_title">Picking Detail</string>
<string name="picking_ship_to">Ship to: %1$s</string>
<string name="picking_report_issue">Report issue</string>
<string name="picking_issue_report_summary">%1$d issue(s) reported, %2$d order(s) skipped.</string>
<string name="picking_detail_supplier">Supplier</string>
<string name="picking_detail_delivery_date">Delivery date</string>
<string name="picking_detail_po_no">PO No.</string>
<string name="picking_detail_ship_to">Ship to</string>
<string name="picking_detail_date_code_notice">Date-code notice</string>
<string name="picking_detail_finish_picking">Finish picking</string>
<string name="picking_detail_finishing">Finishing…</string>
<string name="picking_detail_measuring">Measuring</string>
<string name="picking_detail_measuring_task_created">Measuring task created</string>
<string name="picking_detail_no_matching_allocation">No matching allocation for scanned item</string>
```

**Items section** (`picking.itemsSection.*`):

```xml
<string name="picking_items_title">Items</string>
<string name="picking_items_part">Part</string>
<string name="picking_items_required_qty">Required qty</string>
<string name="picking_items_scanned_qty">Scanned qty</string>
<string name="picking_items_boxed_qty">Boxed qty</string>
<string name="picking_items_required_date_code">Required date code</string>
<string name="picking_items_status">Status</string>
<string name="picking_items_allocations">Allocations</string>
<string name="picking_items_location">Location</string>
<string name="picking_items_source">Source</string>
<string name="picking_items_receiving_area">Receiving area</string>
<string name="picking_items_allocated_qty">Allocated qty</string>
<string name="picking_items_unboxed_packages">Unboxed packages</string>
<string name="picking_items_boxed_packages">Boxed packages</string>
<string name="picking_items_box_ids">Box IDs</string>
<string name="picking_items_select_box">Select box</string>
<string name="picking_items_add_to_box">Add to box</string>
<string name="picking_items_adding">Adding…</string>
<string name="picking_items_remove">Remove</string>
<string name="picking_items_removing">Removing…</string>
<string name="picking_items_scan">Scan</string>
<string name="picking_items_hide_logs">Hide picking logs</string>
<string name="picking_items_show_logs">Show picking logs</string>
<string name="picking_items_no_logs">No picking logs.</string>
```

**Boxes section** (`picking.boxesSection.*`):

```xml
<string name="picking_boxes_title">Boxes (%1$d)</string>
<string name="picking_boxes_new_box">New box</string>
<string name="picking_boxes_box_id">Box ID</string>
<string name="picking_boxes_status">Status</string>
<string name="picking_boxes_packages">Packages</string>
<string name="picking_boxes_qty">Qty</string>
<string name="picking_boxes_cancel_box">Cancel box</string>
<string name="picking_boxes_canceling">Canceling…</string>
<string name="picking_boxes_add_all">Add all</string>
<string name="picking_boxes_add_all_confirm">Add %1$d unboxed package(s) to this box?</string>
```

**Issue banner + reasons + batch issue dialog:**

```xml
<string name="picking_issue_banner_issue_reason">Issue reason</string>
<string name="picking_issue_banner_actual_qty_available">Actual qty available</string>
<string name="picking_issue_banner_pack_size">Pack size</string>
<string name="picking_issue_banner_remark">Remark</string>
<string name="picking_issue_banner_note">Note</string>
<string name="picking_issue_banner_reported">Reported</string>
<string name="picking_issue_reason_insufficient_stock">Insufficient stock</string>
<string name="picking_issue_reason_cannot_divide">Cannot divide quantity</string>
<string name="picking_issue_reason_merge">Merge orders</string>
<string name="picking_issue_reason_other">Other</string>
<string name="picking_issue_modal_title">Report picking issue</string>
<string name="picking_issue_modal_issue_reason">Issue reason</string>
<string name="picking_issue_modal_actual_qty_available">Actual qty available</string>
<string name="picking_issue_modal_pack_size">Pack size</string>
<string name="picking_issue_modal_per_order_remarks">Per-order remarks</string>
<string name="picking_issue_modal_requested">Requested: %1$d</string>
<string name="picking_issue_modal_remark_placeholder">Remark for this order</string>
<string name="picking_issue_modal_common_note">Common note</string>
<string name="picking_issue_modal_common_note_placeholder">Note applied to all selected orders</string>
<string name="picking_issue_modal_actual_qty_placeholder">e.g. 5</string>
<string name="picking_issue_modal_pack_size_placeholder">e.g. 20000</string>
<string name="picking_issue_validation_merge_min_orders">Select at least two orders to request a merge</string>
<string name="picking_issue_validation_valid_available_qty">Enter a valid available quantity</string>
<string name="picking_issue_validation_valid_pack_size">Enter a valid pack size</string>
<string name="picking_issue_validation_note_or_remark">Enter a note or at least one remark</string>
```

**Common + error keys:**

```xml
<string name="common_no_picking_orders">No picking orders found.</string>
<string name="common_selected_count">%1$d selected</string>
<string name="common_no_boxes">No boxes yet.</string>
<string name="common_reported_by">by %1$s</string>
<string name="error_box_is_not_empty">Box is not empty</string>
<string name="error_no_orders_selected">No orders selected</string>
<string name="error_select_at_least_two_orders_to_merge">Select at least two orders to request a merge</string>
<string name="error_actual_quantity_required">Actual quantity is required</string>
<string name="error_pack_size_required">Pack size is required</string>
<string name="error_no_reportable_orders_selected">No reportable orders selected</string>
<string name="error_actual_qty_must_be_less_than_requested">Actual qty for %1$s must be less than requested qty</string>
<string name="error_order_already_finished">Order already finished</string>
<string name="error_no_items_to_pick">No items to pick</string>
<string name="error_not_all_items_fully_boxed">Not all items fully boxed</string>
<string name="error_missing_allocation">Missing allocation</string>
<string name="error_scanned_part_does_not_match_allocation">Scanned part does not match allocation</string>
<string name="error_invalid_allocation">Invalid allocation</string>
<string name="error_qty_exceeds_allocated">Quantity exceeds allocated quantity</string>
<string name="error_invalid_quantity_to_apply">Invalid quantity to apply</string>
```

Before adding, grep each key to avoid duplicates — some may already exist from Phase 1 (e.g. `common_pcs`, `common_actor_system`, `common_scan_success`, `log_state_*`, `status_picking_*`, `status_box_*` definitely exist; do not re-add). Note: web has no `logStates.removed` entry and Phase 1 already added `log_state_removed`; also add `log_state_cancelled` = "Cancelled" if missing (cancel-box logs use `to_state='cancelled'`).

- [ ] **Step 1: Add the keys to all three locale files**

Keep the files' existing section ordering/style. Verify zh translations against `apps/web/i18n/locales/zh-CN.ts` and `zh-HK.ts` (do not machine-translate; copy the web texts).

- [ ] **Step 2: Run the parity test**

```bash
./gradlew :app:testDebugUnitTest --tests "*StringsParityTest"
```

Expected: PASS (key sets identical across the three files).

- [ ] **Step 3: Commit**

```bash
git add apps/android/app/src/main/res && git commit -m "android phase2: picking flow i18n strings x3"
```

---

## Task 2: Picking list data layer

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/model/PickingModels.kt` (create if absent — check first; `MeasuringEntities.kt`/`PickingEntities.kt` exist, a model file may too)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/PickingDao.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/PickingRepository.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/data/PickingListRepositoryTest.kt`

Port the web list query (`apps/web/services/adapters/pgliteWarehouse.ts:1119-1137`):

```sql
SELECT po.id, po.ref_no, po.status, po.delivery_date, po.ship_to, s.name AS supplier_name,
  (SELECT COALESCE(SUM(pi.qty), 0) FROM picking_items pi WHERE pi.picking_order_id = po.id) AS total_qty
FROM picking_orders po
LEFT JOIN suppliers s ON po.supplier_id = s.id
ORDER BY CASE WHEN po.status = 'finished' THEN 1 ELSE 0 END, po.delivery_date
```

(Finished orders sink last; `issue` orders stay in the main list — do NOT special-case them.)

- [ ] **Step 1: Write the failing test**

`PickingListRepositoryTest.kt` — Robolectric seeded-DB pattern (copy the class preamble from `ReceivingRepositoryTest.kt`: `@RunWith(RobolectricTestRunner::class)`, `@Config(sdk = [34])`, `AppDatabase.build(context, inMemory = true)` in `@Before`, `close()` in `@After`):

```kotlin
@Test fun `seeded orders list with finished last and total qty`() = runTest {
    val repo = PickingRepository(db, ReceivingRepository(db, Allocator(db)))
    val orders = repo.listOrders()
    assertTrue(orders.size >= 20)                       // seed has 23 picking orders
    val firstFinishedIndex = orders.indexOfFirst { it.status == "finished" }
    if (firstFinishedIndex >= 0) {
        assertTrue(orders.drop(firstFinishedIndex).all { it.status == "finished" })
    }
    val withItems = orders.first { it.totalQty > 0 }
    assertTrue(withItems.refNo.isNotEmpty())
}
```

(Construct the repository the way `PickingRepositoryTest.kt` does — check its `@Before` for the exact constructor chain.)

- [ ] **Step 2: Run test to verify it fails**

```bash
./gradlew :app:testDebugUnitTest --tests "*PickingListRepositoryTest"
```

Expected: compile failure — `listOrders` / `PickingOrderSummary` unresolved.

- [ ] **Step 3: Implement**

`PickingOrderSummary` in the domain model file:

```kotlin
data class PickingOrderSummary(
    val id: String,
    val refNo: String,
    val status: String,
    val deliveryDate: Long?,
    val supplierName: String?,
    val shipTo: String?,
    val totalQty: Int,
)
```

`PickingDao.kt`:

```kotlin
data class PickingOrderSummaryRow(
    val id: String,
    @ColumnInfo(name = "ref_no") val refNo: String,
    val status: String,
    @ColumnInfo(name = "delivery_date") val deliveryDate: Long?,
    val shipTo: String?,
    @ColumnInfo(name = "supplier_name") val supplierName: String?,
    @ColumnInfo(name = "total_qty") val totalQty: Int,
)

@Query("""
    SELECT po.id, po.ref_no, po.status, po.delivery_date, po.ship_to, s.name AS supplier_name,
      (SELECT COALESCE(SUM(pi.qty), 0) FROM picking_items pi WHERE pi.picking_order_id = po.id) AS total_qty
    FROM picking_orders po
    LEFT JOIN suppliers s ON po.supplier_id = s.id
    ORDER BY CASE WHEN po.status = 'finished' THEN 1 ELSE 0 END, po.delivery_date
""")
fun pickingOrderSummaryRows(): List<PickingOrderSummaryRow>
```

(Verify actual column names against `PickingOrderEntity` before writing the SQL — `delivery_date` is stored as epoch ms Long? in Phase 1 entities.)

`PickingRepository.kt`:

```kotlin
suspend fun listOrders(): List<PickingOrderSummary> = withContext(Dispatchers.IO) {
    db.pickingDao().pickingOrderSummaryRows().map {
        PickingOrderSummary(it.id, it.refNo, it.status, it.deliveryDate, it.supplierName, it.shipTo, it.totalQty)
    }
}
```

- [ ] **Step 4: Run test to verify it passes, then full suite**

```bash
./gradlew :app:testDebugUnitTest
```

Expected: PASS, suite green (143 + new tests).

- [ ] **Step 5: Commit**

```bash
git add apps/android && git commit -m "android phase2: picking list data layer"
```

---

## Task 3: Batch issue report (repository)

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/PickingDao.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/PickingRepository.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/ReportPickingIssuesTest.kt`

Port `reportPickingOrderIssues` (`apps/web/db/picking.ts:473-550`):

- Input: `entries: List<Pair<orderId, remark: String?>>`, `input: PickingIssueInput(reason: String, qty: Int?, packSize: Int?, note: String?)`, `actorId: String`.
- Validate (throw `LocalizedException`): empty entries → `no_orders_selected`; reason `merge` && entries.size < 2 → `select_at_least_two_orders_to_merge`; reason `insufficient_stock` && (qty == null || qty < 0) → `actual_quantity_required`; reason `cannot_divide` && (packSize == null || packSize <= 0) → `pack_size_required`.
- In one transaction: load orders (id, refNo, status, totalQty) for the entry ids; reportable = `status == "pending" || status == "picking"` (finished/issue silently skipped, counted as skipped); none reportable → `no_reportable_orders_selected`.
- Per reportable order: for `insufficient_stock` enforce `qty < order.totalQty` else `LocalizedException("actual_qty_must_be_less_than_requested", mapOf("ref_no" to refNo))`; `UPDATE picking_orders SET status='issue', issue_reason=:reason, issue_qty=:qty (insufficient_stock only, else NULL), issue_pack_size=:packSize (cannot_divide only, else NULL), issue_note=:note (trimmed, nullable), issue_remark=:remark (per entry, trimmed, nullable), issue_reported_at=:now, issue_reported_by=:actorId, updated_at=:now WHERE id=:id`; insert one `transition_logs` row: `entity_type='picking_order'`, `entity_id=orderId`, `from_state=previous status`, `to_state='issue'`, `actor_id=actorId`, `metadata=JSON {"reason":...,"qty":...,"packSize":...,"note":...,"remark":...}` (build with `org.json.JSONObject`, matching web key names), `created_at=now`.
- Return `Pair(reported, skipped)`.

Check how Phase 1 writes transition logs (`PickingDao.insertLog` + the `TransitionLogEntity` shape — use `java.util.UUID.randomUUID().toString()` for ids, epoch ms timestamps) and mirror it exactly.

- [ ] **Step 1: Write the failing tests**

`ReportPickingIssuesTest.kt` — build on the `PickingRepositoryTest.kt` fixture style (deterministic synthetic ids, `exec(sql)` helper, `expectCode(code) { ... }`):

```kotlin
@Test fun `reports issue on pending order with all fields and log`() = runTest {
    // fixture: two pending picking orders with items (totalQty known)
    val (reported, skipped) = repo.reportPickingOrderIssues(
        entries = listOf("po-1" to "short by 5", "po-2" to null),
        input = PickingIssueInput(reason = "insufficient_stock", qty = 3, packSize = null, note = "truck short"),
        actorId = "user-1",
    )
    assertEquals(2 to 0, reported to skipped)
    // assert po-1 row: status=issue, issue_reason, issue_qty=3, issue_note, issue_remark, reported_by/at set
    // assert one transition log per order with to_state='issue' and from_state='pending'
}

@Test fun `merge requires at least two orders`() = runTest {
    expectCode("select_at_least_two_orders_to_merge") {
        runBlocking { repo.reportPickingOrderIssues(listOf("po-1" to null), PickingIssueInput("merge", null, null, null), "user-1") }
    }
}

@Test fun `finished and issue orders are skipped`() = runTest {
    // fixture: one finished, one pending -> reported=1 skipped=1; finished row untouched
}

@Test fun `insufficient stock qty must be below order total`() = runTest {
    expectCode("actual_qty_must_be_less_than_requested") { ... qty == totalQty ... }
}

@Test fun `no reportable orders throws`() = runTest {
    expectCode("no_reportable_orders_selected") { ... all finished ... }
}
```

(Adapt to the real fixture helpers; keep all five test intents.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
./gradlew :app:testDebugUnitTest --tests "*ReportPickingIssuesTest"
```

- [ ] **Step 3: Implement**

`PickingDao.kt` additions:

```kotlin
@Query("SELECT * FROM picking_orders WHERE id IN (:ids)")
fun pickingOrdersByIds(ids: List<String>): List<PickingOrderEntity>

@Query("""
    UPDATE picking_orders SET status = 'issue', issue_reason = :reason, issue_qty = :qty,
      issue_pack_size = :packSize, issue_note = :note, issue_remark = :remark,
      issue_reported_at = :now, issue_reported_by = :actorId, updated_at = :now
    WHERE id = :id
""")
fun markPickingOrderIssue(id: String, reason: String, qty: Int?, packSize: Int?, note: String?, remark: String?, now: Long, actorId: String)

@Query("SELECT COALESCE(SUM(qty), 0) FROM picking_items WHERE picking_order_id = :orderId")
fun totalQtyOfOrder(orderId: String): Int
```

`PickingRepository.kt`:

```kotlin
data class PickingIssueInput(
    val reason: String,          // insufficient_stock | cannot_divide | merge | other
    val qty: Int?,               // required for insufficient_stock
    val packSize: Int?,          // required for cannot_divide
    val note: String?,
)

suspend fun reportPickingOrderIssues(
    entries: List<Pair<String, String?>>,
    input: PickingIssueInput,
    actorId: String,
): Pair<Int, Int> = withContext(Dispatchers.IO) {
    // validations (outside tx is fine — pure)
    // db.runInTransaction { ... }
}
```

- [ ] **Step 4: Run tests + full suite**

```bash
./gradlew :app:testDebugUnitTest
```

- [ ] **Step 5: Commit**

```bash
git add apps/android && git commit -m "android phase2: batch picking issue report"
```

---

## Task 4: Cancel box + manual finish

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/PickingDao.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/PickingRepository.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/CancelBoxAndFinishTest.kt`

**Cancel box** — port `cancelShippingBox` (`apps/web/db/picking.ts:599-630`):
1. Box exists → else `box_not_found`.
2. `box.status == "open"` → else `box_is_not_open`.
3. `COUNT(picking_packages WHERE shipping_box_id = boxId) == 0` → else `box_is_not_empty`.
4. Transition log: `entity_type='shipping_box'`, `entity_id=boxId`, `from_state='open'`, `to_state='cancelled'`, `metadata={"pickingOrderId": ...}`.
5. **Hard-delete** the `shipping_boxes` row (no persisted cancelled status).

**Manual finish** — port `finishPickingOrder` (`apps/web/db/picking.ts:853-907`):
- Guards: order exists → `picking_order_not_found`; already finished → `order_already_finished`; zero items → `no_items_to_pick`; status `issue` → `picking_order_has_open_issue`; any item `picked_qty < qty` → `not_all_items_fully_boxed`.
- Then identical work to the existing auto-finish: set `status='finished', updated_at=now`; insert `measuring_tasks` row (`id=uuid`, `picking_order_id`, `status='pending'`, `created_at=now`); set `measuring_task_id` on all the order's shipping boxes; transition log `entity_type='picking_order'`, `from_state='picking'`, `to_state='finished'`, **`metadata=NULL`** (auto-finish uses `{"auto": true}` — that is the only difference).
- Refactor: the existing `maybeAutoFinishPickingOrderInternal` (PickingRepository.kt:~509) already does steps; extract the shared finish work into `private fun finishOrderInternal(orderId, actorId, now, auto: Boolean)` used by both (auto passes `auto=true` → metadata `{"auto": true}`, manual passes `false` → null metadata). Do not change auto-finish behavior.

- [ ] **Step 1: Write the failing tests**

`CancelBoxAndFinishTest.kt` — same fixture style as `PickingRepositoryTest.kt`:

```kotlin
@Test fun `cancel empty open box deletes row and logs cancelled`() = runTest {
    // fixture: open box with 0 packages
    repo.cancelShippingBox(boxId, "user-1")
    assertNull(offMainThread { db.pickingDao().boxById(boxId) })
    // transition log row: entity_type='shipping_box', to_state='cancelled'
}

@Test fun `cancel box with packages throws box_is_not_empty`() = runTest {
    // fixture: box with one package assigned
    expectCode("box_is_not_empty") { runBlocking { repo.cancelShippingBox(boxId, "user-1") } }
    assertNotNull(offMainThread { db.pickingDao().boxById(boxId) })  // untouched
}

@Test fun `cancel closed box throws box_is_not_open`() = runTest { ... }

@Test fun `finish creates measuring task and assigns boxes`() = runTest {
    // fixture: picking order, one item qty=10, one package qty=10 already in a box (picked_qty=10)
    repo.finishPickingOrder(orderId, "user-1")
    // order status == finished
    // exactly one measuring_tasks row for the order, status='pending'
    // box.measuring_task_id == task id
    // log to_state='finished' with metadata NULL
}

@Test fun `finish with unboxed remainder throws not_all_items_fully_boxed`() = runTest {
    // fixture: item qty=10, picked_qty=5
    expectCode("not_all_items_fully_boxed") { ... }
}

@Test fun `finish issue order throws picking_order_has_open_issue`() = runTest { ... }

@Test fun `auto finish still logs auto metadata`() = runTest {
    // existing behavior regression guard: drive maybeAutoFinishPickingOrder via addPackageToBox
    // and assert the finished log metadata contains "auto"
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
./gradlew :app:testDebugUnitTest --tests "*CancelBoxAndFinishTest"
```

- [ ] **Step 3: Implement**

`PickingDao.kt` additions:

```kotlin
@Query("SELECT COUNT(*) FROM picking_packages WHERE shipping_box_id = :boxId")
fun packageCountInBox(boxId: String): Int

@Query("DELETE FROM shipping_boxes WHERE id = :boxId")
fun deleteBox(boxId: String)

@Query("SELECT * FROM measuring_tasks WHERE picking_order_id = :orderId")
fun measuringTaskOfOrder(orderId: String): MeasuringTaskEntity?
```

`PickingRepository.kt`:

```kotlin
suspend fun cancelShippingBox(boxId: String, actorId: String) = withContext(Dispatchers.IO) {
    db.runInTransaction { cancelShippingBoxInternal(boxId, actorId) }
}

suspend fun finishPickingOrder(orderId: String, actorId: String) = withContext(Dispatchers.IO) {
    db.runInTransaction {
        val order = db.pickingDao().pickingOrderById(orderId)
            ?: throw LocalizedException("picking_order_not_found")
        if (order.status == "finished") throw LocalizedException("order_already_finished")
        val items = db.pickingDao().itemsOfPickingOrder(orderId)
        if (items.isEmpty()) throw LocalizedException("no_items_to_pick")
        if (order.status == "issue") throw LocalizedException("picking_order_has_open_issue")
        if (items.any { it.pickedQty < it.qty }) throw LocalizedException("not_all_items_fully_boxed")
        finishOrderInternal(orderId, actorId, System.currentTimeMillis(), auto = false)
    }
}
```

(`cancelShippingBoxInternal` and the refactored `finishOrderInternal` per the port notes above.)

- [ ] **Step 4: Run tests + full suite**

```bash
./gradlew :app:testDebugUnitTest
```

- [ ] **Step 5: Commit**

```bash
git add apps/android && git commit -m "android phase2: cancel box + manual finish picking"
```

---

## Task 5: Picking detail read model

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/model/PickingModels.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/PickingDao.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/PickingRepository.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/data/PickingDetailRepositoryTest.kt`

Read model for the picking detail screen (web: `pages/picking/[id].vue:230-258` load + `PickingItemsSection.vue`/`PickingBoxesSection.vue` props):

```kotlin
data class PickingOrderDetail(
    val id: String,
    val refNo: String,
    val status: String,
    val supplierName: String?,
    val supplierCode: String?,          // scan context (join suppliers)
    val deliveryDate: Long?,
    val poNo: String?,
    val shipTo: String?,
    val requiredDateCodeNotice: String?,
    val measuringTaskId: String?,
    // issue fields (banner when status == "issue")
    val issueReason: String?,
    val issueQty: Int?,
    val issuePackSize: Int?,
    val issueNote: String?,
    val issueRemark: String?,
    val issueReportedByName: String?,   // join users
    val items: List<PickingItemDetail>,
    val boxes: List<PickingBoxDetail>,
)

data class PickingItemDetail(
    val id: String,
    val partNo: String?,
    val qty: Int,
    val pickedQty: Int,                 // boxed-only total (entity field)
    val scannedQty: Int,                // SUM of ALL its packages' qty (computed)
    val requiredDateCode: String?,
    val allocations: List<PickingAllocationDetail>,  // qty > 0 only
    val packages: List<PickingPackageDetail>,
)

data class PickingAllocationDetail(
    val id: String,
    val qty: Int,
    // inventory-lot-backed (allocations.inventory_lot_id set):
    val lotId: String?,
    val shelfCode: String?,
    val boxId: String?,
    val dateCode: String?,
    val lotCode: String?,
    val coo: String?,
    val cow: String?,
    // receiving-order-backed (allocations.receiving_order_id set):
    val receivingOrderId: String?,
    val receivingOrderRefNo: String?,
    val boxIds: List<String>,           // parsed from allocations.remark JSON array of strings; empty on any parse failure
)

data class PickingPackageDetail(
    val id: String,
    val qty: Int,
    val shippingBoxId: String?,
    val dateCode: String?,
    val lotCode: String?,
    val coo: String?,
    val cow: String?,
)

data class PickingBoxDetail(
    val id: String,
    val status: String,
    val packageCount: Int,
    val totalQty: Int,                  // SUM of its packages' qty
)
```

`PickingRepository`:

```kotlin
suspend fun getPickingOrderDetail(orderId: String): PickingOrderDetail? = withContext(Dispatchers.IO) { ... }

suspend fun pickingItemLogs(itemIds: List<String>): Map<String, List<PickingItemLogEntry>> = withContext(Dispatchers.IO) { ... }

data class PickingItemLogEntry(
    val id: String,
    val fromState: String?,
    val toState: String?,
    val actorName: String?,
    val metadata: String?,
    val createdAt: Long,
)
```

DAO: follow the Phase 1 flat-row pattern (`PickingRowFlat` in `ReceivingDao.kt` is the model — one wide `@Query` row per allocation/package/box, assembled in the repository). Queries needed (exact column names from the entities — verify): order + supplier + measuring task join; items + part join; allocations left-joined to `inventory_lots` and to `receiving_orders` (`WHERE (inventory_lot_id IS NOT NULL OR receiving_order_id IS NOT NULL) AND qty > 0`); packages by item ids; boxes by order id with package aggregates; logs: `SELECT tl.*, u.name AS actor_name FROM transition_logs tl LEFT JOIN users u ON u.id = tl.actor_id WHERE tl.entity_type = 'picking_item' AND tl.entity_id IN (:itemIds) ORDER BY tl.created_at DESC`.

`boxIds` parsing: `allocations.remark` may hold a JSON array of box id strings (web `boxIdsFromRemark`, `PickingItemsSection.vue:240-251`); parse defensively with `org.json.JSONArray` — anything but an array of strings → empty list.

- [ ] **Step 1: Write the failing test**

`PickingDetailRepositoryTest.kt` — synthetic fixture (deterministic ids) like `PickingRepositoryTest.insertBaseFixture`: one picking order with supplier, one item (qty 20, part joined), one lot-backed allocation (qty 5, lot with shelfCode/dateCode), one receiving-order-backed allocation (qty 10, remark `["BOX-A","BOX-B"]`), one scanned package (unboxed, qty 3), one boxed package (qty 10 → pickedQty 10), one open box containing it:

```kotlin
@Test fun `detail assembles header items allocations boxes`() = runTest {
    val detail = repo.getPickingOrderDetail("po-1")!!
    assertEquals("po-1", detail.id)
    assertEquals("KOA", detail.supplierName)
    val item = detail.items.single()
    assertEquals(20, item.qty)
    assertEquals(10, item.pickedQty)          // boxed only
    assertEquals(13, item.scannedQty)         // all packages
    assertEquals(2, item.allocations.size)
    val lotAlloc = item.allocations.first { it.lotId != null }
    assertEquals("SHELF-1", lotAlloc.shelfCode)
    val roAlloc = item.allocations.first { it.receivingOrderId != null }
    assertEquals(listOf("BOX-A", "BOX-B"), roAlloc.boxIds)
    val box = detail.boxes.single()
    assertEquals(1, box.packageCount)
    assertEquals(10, box.totalQty)
}

@Test fun `logs grouped by item newest first`() = runTest { ... }
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./gradlew :app:testDebugUnitTest --tests "*PickingDetailRepositoryTest"
```

- [ ] **Step 3: Implement**

DAO flat rows + queries, repository assembly per the model above.

- [ ] **Step 4: Run tests + full suite**

```bash
./gradlew :app:testDebugUnitTest
```

- [ ] **Step 5: Commit**

```bash
git add apps/android && git commit -m "android phase2: picking detail read model"
```

---

## Task 6: Picking scan matcher (domain)

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/scan/ScanMatcher.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/scan/MatchPickingTest.kt`

Port `matchPicking` (`apps/web/composables/useScanMatchers.ts:177-223`) and `findMatchingAllocation` (`apps/web/pages/picking/[id].vue:163-179`). These are pure functions over already-loaded detail state — no DAO, no new constructor seams.

Add to `ScanMatcher.kt`:

```kotlin
/** A pinned (or wedge-matched) allocation target on a picking order. */
data class PinnedAllocation(
    val allocationId: String?,        // null when the item has only a coarse receiving-order allocation target
    val pickingItemId: String,
    val partNo: String,               // normalized (ScanPrimitives.normalize)
    val allocationQty: Int,
    val scannedQty: Int,              // qty already scanned against this allocation
    val receivingOrderId: String?,    // non-null => receiving-order-backed: apply via applyOcrPick
)

sealed class PickingMatchResult {
    data class Single(val allocation: PinnedAllocation) : PickingMatchResult()
    data class Error(val key: String) : PickingMatchResult()
}

/** Port of useScanMatchers.matchPicking: validates parsed fields against a pinned allocation. */
fun matchPicking(
    allocation: PinnedAllocation?,
    parsed: ScanPrimitives.OcrInput,
    actorId: String?,
): PickingMatchResult {
    if (actorId == null) return PickingMatchResult.Error("operator_not_signed_in")
    if (allocation == null) return PickingMatchResult.Error("missing_allocation")
    val p = try {
        ScanPrimitives.parseManual(parsed)      // throws qty_must_be_positive_integer
    } catch (e: LocalizedException) {
        return PickingMatchResult.Error(e.code)
    }
    if (p.partNo != allocation.partNo) return PickingMatchResult.Error("scanned_part_does_not_match_allocation")
    if (allocation.allocationQty <= 0) return PickingMatchResult.Error("invalid_allocation")
    if (p.qty > allocation.allocationQty) return PickingMatchResult.Error("qty_exceeds_allocated")
    return PickingMatchResult.Single(allocation)
}

/** Wedge path: first item whose normalized partNo matches and whose allocation still has room. */
fun findMatchingAllocation(
    parsed: ScanPrimitives.OcrInput,
    allocations: List<PinnedAllocation>,
): PinnedAllocation? {
    val p = try { ScanPrimitives.parseManual(parsed) } catch (e: LocalizedException) { return null }
    return allocations.firstOrNull {
        it.partNo == p.partNo && it.allocationQty > 0 && it.scannedQty <= it.allocationQty
    }
}
```

(Web returns `single` with an `apply` closure; the Android VM applies directly by `receivingOrderId != null` — see Task 10.)

- [ ] **Step 1: Write the failing tests**

`MatchPickingTest.kt` — plain JVM tests (no Robolectric needed; match the style of `ScanMatcherTest.kt` from Phase 1):

```kotlin
private val pin = ScanMatcher.PinnedAllocation("alloc-1", "pi-1", "IC-LM358DR", 10, 0, null)
private fun input(partNo: String = "IC-LM358DR", qty: String = "4") =
    ScanPrimitives.OcrInput(partNo, "", "", "", "", qty)

@Test fun `single when fields match pin`() {
    val r = ScanMatcher(...).matchPicking(pin, input(), "user-1")
    assertEquals(ScanMatcher.PickingMatchResult.Single(pin), r)
}

@Test fun `part mismatch`() { ... input(partNo = "OTHER") -> Error("scanned_part_does_not_match_allocation") }
@Test fun `qty exceeds allocated`() { ... input(qty = "11") -> Error("qty_exceeds_allocated") }
@Test fun `non positive qty`() { ... input(qty = "0") -> Error("qty_must_be_positive_integer") }
@Test fun `missing allocation`() { ... null pin -> Error("missing_allocation") }
@Test fun `not signed in`() { ... actorId null -> Error("operator_not_signed_in") }
@Test fun `findMatchingAllocation picks first matching with room`() { ... two allocations same part, first full (scannedQty == allocationQty), second has room -> second }
@Test fun `findMatchingAllocation null on no match`() { ... }
```

(The `ScanMatcher(...)` constructor still takes the two Phase 1 candidate lambdas — pass `{ emptyList() }` stubs; the new functions don't use them.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
./gradlew :app:testDebugUnitTest --tests "*MatchPickingTest"
```

- [ ] **Step 3: Implement** per the code above.

- [ ] **Step 4: Run tests + full suite**

```bash
./gradlew :app:testDebugUnitTest
```

- [ ] **Step 5: Commit**

```bash
git add apps/android && git commit -m "android phase2: picking scan matcher"
```

---

## Task 7: Generalize the scan review dialog for reuse

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/scan/ScanReviewUiState.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/scan/LabelScanReviewDialog.kt` (moved + generalized)
- Delete: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/receiving/LabelScanReviewDialog.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/receiving/ReceivingDetailViewModel.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/receiving/ReceivingDetailScreen.kt`
- Modify: `apps/android/app/src/test/java/com/docpal/warehousepda/ui/receiving/ReceivingDetailPickingTest.kt` (assertions updated)

Phase 1's `LabelScanReviewDialog` is param-based but its `ScanReviewUiState.matchResult` is typed to the receiving-specific `ScanMatcher.MatchResult`/`MatchedRecord`. Picking (Task 10) needs the same dialog with a single pinned-allocation match. Generalize the match payload:

```kotlin
// ui/scan/ScanReviewUiState.kt
package com.docpal.warehousepda.ui.scan

import com.docpal.warehousepda.domain.scan.OcrLabelParser
import com.docpal.warehousepda.domain.scan.ScanPrimitives

/** A selectable match rendered in the review dialog. */
data class ScanMatchOption(val id: String, val label: String)

data class ScanReviewUiState(
    val manual: Boolean,              // manual entry vs camera review (web mode)
    val imagePath: String?,
    val fields: ScanPrimitives.OcrInput,
    val options: OcrLabelParser.CandidateOptions,
    val matching: Boolean = false,
    val applying: Boolean = false,
    val matchOptions: List<ScanMatchOption> = emptyList(),
    val matchMessageRes: Int? = null, // R.string.scan_review_match_single / _multiple / _none / null = not matched yet
    val matchErrorKey: String? = null,
    val applyErrorKey: String? = null,
)
```

`LabelScanReviewDialog` moves to `ui/scan/` with signature:

```kotlin
@Composable
fun LabelScanReviewDialog(
    review: ScanReviewUiState,
    onFieldsChange: (ScanPrimitives.OcrInput) -> Unit,
    onFindMatch: () -> Unit,
    onApply: (String) -> Unit,       // selected ScanMatchOption.id
    onRetake: () -> Unit,
    onDismiss: () -> Unit,
)
```

Behavior unchanged: review vs manual title/image, 6 editable fields with `CandidateChips` when >1 candidate, Find match (matching state), match message area (single/multiple/none/error via `matchMessageRes`/`matchErrorKey`), multiple options require explicit selection before Apply enabled (single option pre-selected), Apply disabled while busy, Retake only in review mode, Cancel/dismiss blocked while busy. Move `CandidateChips` and `decodeSampledBitmap` with it.

`ReceivingDetailViewModel` changes:
- Its `scanReview` state type becomes `ui.scan.ScanReviewUiState`.
- `findMatch()` maps `ScanMatcher.MatchResult` → options: `Single` → one option (id = `"${record.picking.pickingItemId}|${record.receiving.receivingInvoiceItemId}"`, label = `"{pickingOrderRefNo} ({remainingQty} / {requiredQty})"`) + `matchMessageRes = R.string.scan_review_match_single`; `Multiple` → one option per record + `_multiple`; `None` → empty + `_none`; `Error(key)` → `matchErrorKey = key` (+ `matchMessageRes = R.string.scan_review_error`).
- `applyScan(optionId)` resolves the id back to the `MatchedRecord` (keep the last `MatchResult` in a private VM field, or key the option id so it round-trips) and proceeds exactly as today (applyOcrPick → toast `common_scan_success` → close → clear pin → reload; failure → `applyErrorKey`).
- Move the scan seams `ScanMatchSource` and `LabelScanParser` out of `ReceivingDetailViewModel.kt` into `ui/scan/` too (final-review finding); leave `ReceivingDetailSource`/`MismatchSource`/`SessionSource`/`PickingSource` where they are (Phase 3 cleanup).

`ReceivingDetailScreen.kt`: import updates only. `ReceivingDetailPickingTest.kt`: update assertions from `matchResult` types to `matchOptions`/`matchMessageRes` equivalents (same intents).

- [ ] **Step 1: Run the current receiving tests to establish the green baseline**

```bash
./gradlew :app:testDebugUnitTest --tests "*ReceivingDetail*"
```

- [ ] **Step 2: Refactor**

Move + generalize per above. This is a behavior-preserving refactor of the receiving flow; no new production behavior.

- [ ] **Step 3: Update the receiving tests to the new state shape and run everything**

```bash
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

Expected: full suite green (same count), APK builds.

- [ ] **Step 4: Commit**

```bash
git add apps/android && git commit -m "android phase2: generalize label scan review dialog"
```

---

## Task 8: Picking list screen + batch issue dialog + nav

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/picking/PickingListViewModel.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/picking/PickingListScreen.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/picking/PickingIssueReportDialog.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/navigation/AppNav.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/home/HomeScreen.kt` (picking card navigates)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/AppContainer.kt` (factory entry)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/ui/picking/PickingListViewModelTest.kt`

Web reference: `apps/web/pages/picking/index.vue` + `apps/web/components/PickingIssueReportModal.vue`. Behavior:

- **No filter chips** (unlike receiving) — only a search field (`common_search_by_ref_or_supplier`), client-side case-insensitive contains over refNo + supplierName (same `visibleOrders` computed pattern as `ReceivingListViewModel`).
- Rows: checkbox (only when selectable: `status == "pending" || status == "picking"`) + refNo (tap → detail) + status badge (`StatusBadge(status, family = "picking")`) + supplier (`common_no_supplier` fallback) + delivery date (`common_no_date` fallback) + right-aligned `picking_ship_to` (destination fallback `common_no_data`). Non-selectable rows dimmed (`Modifier.alpha(0.65f)`).
- Multi-select: `selectedIds: Set<String>` in the VM; toggling only allowed for selectable orders. When ≥1 selected: bottom bar with `common_selected_count` + red "Report issue" button (`picking_report_issue`).
- Empty: `common_no_picking_orders`; spinner on first load; reload via `OnResumeEffect`; error via `ErrorText`.
- After a successful report: clear selection, reload, show `picking_issue_report_summary` as a toast (reported/skipped counts).
- `PickingIssueReportDialog` (AlertDialog-based, port of `PickingIssueReportModal.vue`):
  - Reason dropdown — 4 reasons in order `insufficient_stock, cannot_divide, merge, other` (`picking_issue_reason_*`), default `insufficient_stock`.
  - `insufficient_stock` → qty field (`picking_issue_modal_actual_qty_available`, placeholder `..._actual_qty_placeholder`).
  - `cannot_divide` → pack size field (`..._pack_size`, placeholder `..._pack_size_placeholder`).
  - Per-order remarks section: one row per selected order (refNo; `picking_issue_modal_requested` with totalQty only for `cannot_divide`; text input `..._remark_placeholder`).
  - Common note textarea (`..._common_note` / `..._common_note_placeholder`).
  - Client-side validation before submit (inline text, keys `picking_issue_validation_*`): merge && < 2 orders → `merge_min_orders`; insufficient_stock qty not an integer ≥ 0 → `valid_available_qty`; cannot_divide packSize not an integer > 0 → `valid_pack_size`; other && note blank && all remarks blank → `note_or_remark`.
  - Save → VM `reportIssues(reason, qty, packSize, note, remarks)` → repository; repository errors surface inline via `ErrorText` (params-aware: `actual_qty_must_be_less_than_requested` carries `ref_no`).

VM (constructor: `PickingListSource` interface { `suspend fun listOrders(): List<PickingOrderSummary>`; `suspend fun reportIssues(entries: List<Pair<String,String?>>, input: PickingIssueInput, actorId: String): Pair<Int,Int>` } — `PickingRepository` opts in; plus `SessionSource` for actorId; `io` dispatcher):

```kotlin
data class PickingListUiState(
    val search: String = "",
    val loading: Boolean = true,
    val orders: List<PickingOrderSummary> = emptyList(),
    val selectedIds: Set<String> = emptySet(),
    val reporting: Boolean = false,
    val errorKey: String? = null,
    val errorArgs: List<String> = emptyList(),
    val toastKey: String? = null,     // "issue_reported" -> summary toast with reported/skipped
    val toastArgs: List<Int> = emptyList(),
) {
    val visibleOrders: List<PickingOrderSummary> get() { /* same search logic as ReceivingListUiState */ }
    val selectedOrders: List<PickingOrderSummary> get() = orders.filter { it.id in selectedIds }
}
```

`toggleSelection(id)` ignores non-selectable rows; `clearSelection()`; `reload()` race-safe (Phase 1 `loadJob` pattern; preserves selection across reloads — web keeps the Set until a successful report).

`AppNav.kt`: add to `Routes`:

```kotlin
const val PICKING_LIST = "picking"
const val PICKING_DETAIL = "picking/{orderId}"
fun pickingDetail(orderId: String) = "picking/$orderId"
```

`composable(Routes.PICKING_LIST) { PickingListScreen(onOrderClick = { navController.navigate(Routes.pickingDetail(it)) }) }`; placeholder detail composable showing the order id (replaced in Task 9). `HomeScreen.kt`: picking `MenuCard` gets `Routes.PICKING_LIST`. `AppContainer`: factory entry `PickingListViewModel(pickingRepository, sessionRepository)`.

- [ ] **Step 1: Write the failing VM tests**

`PickingListViewModelTest.kt` (fakes + `Dispatchers.setMain` pattern from `ReceivingListViewModelTest`):

```kotlin
@Test fun `loads orders and searches client side`() = runTest {
    // fake with 2 orders (ref RO-1/KOA, RO-2/Diotec); search "koa" -> 1 visible
}

@Test fun `selection ignores non selectable orders`() = runTest {
    // orders with statuses pending, picking, finished, issue
    // toggle each; only pending + picking land in selectedIds
}

@Test fun `report success clears selection reloads and toasts`() = runTest {
    // select one order; fake reportIssues returns (1, 0)
    // assert selectedIds empty, reload called again, toastKey set with args [1, 0]
}

@Test fun `report validation error surfaces as errorKey`() = runTest {
    // fake throws LocalizedException("no_reportable_orders_selected")
    // assert errorKey + reporting == false
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
./gradlew :app:testDebugUnitTest --tests "*PickingListViewModelTest"
```

- [ ] **Step 3: Implement** VM + screen + dialog + nav wiring per the behavior spec. Follow `ReceivingListScreen.kt` layout idioms (Scaffold + TopAppBar `picking_title`, LazyColumn cards); the bottom selection bar is a `BottomAppBar` or a `Surface` in the Scaffold `bottomBar` slot shown only when `selectedIds` is non-empty.

- [ ] **Step 4: Run tests + assemble**

```bash
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

- [ ] **Step 5: Commit**

```bash
git add apps/android && git commit -m "android phase2: picking list screen + batch issue dialog"
```

---

## Task 9: Picking detail screen — header, issue banner, items, boxes

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/picking/PickingDetailViewModel.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/picking/PickingDetailScreen.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/picking/PickingItemsSection.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/picking/PickingBoxesSection.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/ui/picking/PickingDetailViewModelTest.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/navigation/AppNav.kt` (replace placeholder)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/receiving/ReceivingPickingTab.kt` (order ref becomes a navigation link)

Web references: `apps/web/pages/picking/[id].vue`, `apps/web/components/picking/{PickingItemsSection,PickingBoxesSection,PickingIssueBanner}.vue`.

Screen behavior:

- **Header** (DetailHeader-style card, body expandable via chevron like the web): refNo + `StatusBadge(status, "picking")`; expanded rows: supplier (`picking_detail_supplier`, fallback `common_no_supplier`), delivery date, `picking_detail_po_no`, `picking_detail_ship_to`, `picking_detail_date_code_notice`.
- **Finish picking** button: only when `status != "finished" && status != "issue"` AND every item `pickedQty >= qty`; disabled while `actionInProgress`; on success reload + toast `picking_detail_measuring_task_created` when a measuring task id is present after reload.
- **Measuring** row: when `status == "finished" && measuringTaskId != null` — render the task id as plain text (the measuring flow is Phase 5; no navigation, no stub button).
- **Issue banner** when `status == "issue"`: card with rows `picking_issue_banner_issue_reason` (label via `picking_issue_reason_<reason>`), `..._actual_qty_available` (issueQty, insufficient_stock only), `..._pack_size` (issuePackSize, cannot_divide only), `..._remark` (issueRemark), `..._note` (issueNote), `..._reported` + `common_reported_by` (issueReportedByName).
- **Items section** (`PickingItemsSection.kt`, port of `PickingItemsSection.vue`):
  - Title `picking_items_title`. Per item card (`card--done` styling — e.g. muted/green border — when `pickedQty >= qty`): `picking_items_part` (partNo, `common_no_data` fallback), `picking_items_required_qty` (qty), `picking_items_scanned_qty` (scannedQty), `picking_items_boxed_qty` (pickedQty), `picking_items_required_date_code`, derived status badge (Finished when `pickedQty >= qty` else Picking, family "picking").
  - **Allocations block** when `allocations.isNotEmpty() && actionable && pickedQty < qty` (actionable = `status != "finished" && status != "issue"`): inventory-lot allocation rows show `picking_items_location` (`"{shelfCode} / {boxId}"` — whichever parts exist, else `picking_items_receiving_area`), `dateLotCooCow` (`{dateCode|—} / {lotCode|—} / {coo|—} / {cow|—}`), `picking_items_allocated_qty`, and a **Scan** button (wired in Task 10 — for this task render the button disabled or omit it behind a `scanEnabled: Boolean = false` parameter so Task 10 only flips the flag). Receiving-order allocation rows show `picking_items_source` = `receiving_area` + `({refNo})`, allocated qty, `picking_items_box_ids` row when `boxIds` non-empty (joined `, `), Scan button same as above.
  - **Unboxed packages** when any && actionable: row `"{qty} {common_pcs} · {dateLotCooCow}"` + box selector (`picking_items_select_box`; options = open boxes of this order; `common_create_open_box_first` when none) + Add to box (`picking_items_add_to_box` / `..._adding`) disabled until a box is selected. Box selection state in the screen (`rememberSaveable` map packageId→boxId, pruned on reload — or VM-held; screen-held is fine, matches web page-level state).
  - **Boxed packages** when any && actionable: row `"{qty} {common_pcs} · {shippingBoxId}"` + Remove (`picking_items_remove` / `..._removing`) only when that box is still open.
  - **Logs toggle** per item (always rendered): `picking_items_show_logs`/`..._hide_logs` + count; expanded: `picking_items_no_logs` or entries `"{yyyy-MM-dd HH:mm} · {actorName | common_actor_system} · {fromLabel} → {toLabel}"` via `log_state_*` (`common_state_none` for null) + metadata suffix when the JSON metadata has `qty` or `note` (web `logMetadataText`).
- **Boxes section** (`PickingBoxesSection.kt`, port of `PickingBoxesSection.vue`): header `picking_boxes_title` (count) + New box button when actionable (`picking_boxes_new_box`) + Show/Hide toggle (collapsed by default; force-expand after creating). Per box card (`card--done` when not open): `picking_boxes_box_id`, status badge (family "box"), `picking_boxes_packages`, `picking_boxes_qty`; when open: Add all (`picking_boxes_add_all`, disabled when no unboxed packages → confirm `AlertDialog` `picking_boxes_add_all_confirm` with count → `addAllUnboxedPackagesToBox`), Cancel box (`picking_boxes_cancel_box` / `..._canceling`) only when `packageCount == 0` → `cancelShippingBox`. Empty: `common_no_boxes`.
- All mutations through the VM (`runAction` pattern: serialized, `actionInProgress`, `LocalizedException` → `errorKey`+`errorArgs`, reload on success). Add-all confirm reuses the Phase 1 pending-state pattern (`pendingAddAllBoxId`).
- `OnResumeEffect { viewModel.reload() }`; `collectAsStateWithLifecycle`; errors via `ErrorText(state.errorKey, args = state.errorArgs)` in the header card.
- `ReceivingPickingTab.kt`: the picking order ref (currently plain text with a "Phase 2" comment) becomes a clickable `TextButton`/`Modifier.clickable` invoking a new `onPickingOrderClick: (String) -> Unit` parameter; `ReceivingDetailScreen` wires it to `navController.navigate(Routes.pickingDetail(id))` (thread the lambda through from `AppNav`).

VM (constructor: `orderId`, `PickingDetailSource` interface — `getPickingOrderDetail`, `pickingItemLogs`, `createBox`, `cancelBox`, `addAllToBox`, `addPackageToBox`, `removePackageFromBox`, `finishPicking` — `PickingRepository` opts in; `SessionSource` — reuse the one in `ui/receiving/` (import it; do not duplicate); `io` dispatcher):

```kotlin
data class PickingDetailUiState(
    val loading: Boolean = true,
    val detail: PickingOrderDetail? = null,
    val logs: Map<String, List<PickingItemLogEntry>> = emptyMap(),
    val errorKey: String? = null,
    val errorArgs: List<String> = emptyList(),
    val currentUserId: String? = null,
    val actionInProgress: Boolean = false,
    val pendingAddAllBoxId: String? = null,
    val toastKey: String? = null,
)
```

`provideFactory(container, orderId)` companion, mirroring `ReceivingDetailViewModel.provideFactory`. Init-load + `OnResumeEffect` (same accepted double-first-query pattern as Phase 1).

- [ ] **Step 1: Write the failing VM tests**

`PickingDetailViewModelTest.kt` (fakes; reuse the fake `SessionSource` shape from `ReceivingDetailViewModelTest`):

```kotlin
@Test fun `loads detail and logs on init`() = runTest { ... assertEquals("po-1", vm.uiState.value.detail?.id) ... }

@Test fun `finish delegates and reloads and toasts when measuring task appears`() = runTest {
    // fake detail initially without measuringTaskId, after finish with one
    // assert finishPicking called with (orderId, actor), toastKey == "measuring_task_created"
}

@Test fun `cancel box delegates and reloads`() = runTest { ... }

@Test fun `addAll requires confirm then delegates`() = runTest {
    // vm.requestAddAll("box-1") -> pendingAddAllBoxId set; vm.confirmAddAll() -> fake called, pending cleared
}

@Test fun `repository error surfaces as errorKey`() = runTest {
    // fake cancelBox throws LocalizedException("box_is_not_empty")
    // assert errorKey and actionInProgress == false
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
./gradlew :app:testDebugUnitTest --tests "*PickingDetailViewModelTest"
```

- [ ] **Step 3: Implement** per the behavior spec. Keep `PickingDetailScreen.kt` to scaffold/header/dialog wiring; sections in their own files (LazyListScope extensions like `ReceivingItemsTab.kt`). Wire `AppNav` detail route and the `ReceivingPickingTab` navigation lambda.

- [ ] **Step 4: Run tests + assemble**

```bash
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

- [ ] **Step 5: Commit**

```bash
git add apps/android && git commit -m "android phase2: picking detail screen"
```

---

## Task 10: Scan-to-pick wiring

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/picking/PickingDetailViewModel.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/picking/PickingDetailScreen.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/picking/PickingItemsSection.kt` (enable Scan buttons)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/ui/picking/PickingDetailScanTest.kt`

Web references: `apps/web/pages/picking/[id].vue:163-179` (wedge), `:260-276` (openScan/retake), `apps/web/composables/useScanMatchers.ts:177-223` (apply dispatch), `apps/web/composables/useLabelScan.ts:121-124` (single auto-apply).

Behavior (deliberately different from the receiving flow — web parity):

- **No ScanFab, no manual-entry button.** Scan entry points: per-allocation Scan buttons + hardware wedge.
- **Per-allocation Scan** → `vm.pinAllocation(allocation)` then launch the camera (`rememberCameraScanLauncher`, `ui/receiving/ScanLaunchers.kt`). Enable the Scan buttons from Task 9 (`scanEnabled = true`, calling `vm.pinAllocation(...)` + the launcher).
- **Wedge**: `HardwareKeyBuffer` (300 ms) via `Modifier.onPreviewKeyEvent` on the root Scaffold, disabled while any dialog is open (`dialogOpen` flag, same pattern as `ReceivingDetailScreen`) — buffer flushes go to `vm.onHardwareScan(text)`.
- **Scan result handling** (shared camera/wedge): QR/barcodes → `QrParser.parseQrCapture` (templates from `ScanRepository.supplierQrTemplates()`, context supplier = `detail.supplierCode`, targets = the order's part numbers) with `OcrLabelParser.parseAndIdentify` fallback — reuse the Phase 1 factory wiring (the `LabelScanParser` seam now in `ui/scan/`); fields pre-fill a pending parse.
- **Pinned flow**: `matchPicking(pinned, fields, actorId)`:
  - `Single` → **auto-apply immediately, no dialog** (web: `!confirmSingleMatch`): lot-backed allocation (`receivingOrderId == null`, `allocationId != null`) → `scanAllocationToPackage(allocationId, qty, actorId)`; receiving-order-backed (`receivingOrderId != null`) → `applyOcrPick(receivingOrderId, pickingItemId, qty, dateCode, lotCode, coo, cow, actorId)`. On success: toast `common_scan_success`, reload. On `LocalizedException` failure: toast `errorMessage(code, args)` (web toasts scan errors on this page — there is no inline dialog to show them in the auto-apply path).
  - `Error` (e.g. `scanned_part_does_not_match_allocation` from OCR noise) → open the review dialog (`ui/scan/LabelScanReviewDialog`) in mode `manual = (imagePath == null)`, fields editable, Find match re-runs `matchPicking` against the same pin with edited fields; on `Single` the dialog shows one match option (`"{partNo} ({qty})"` — use the pinned allocation's partNo + parsed qty) and Apply dispatches exactly like the auto-apply path; success → toast + close + clear pin + reload; failure → inline `applyErrorKey` (dialog stays open). Retake (review mode) → relaunch camera with the same pin. Cancel → close, clear pin.
- **Wedge without pin**: `findMatchingAllocation(fields, allAllocations)` where `allAllocations` maps `detail.items[].allocations[]` to `PinnedAllocation` (partNo normalized, `scannedQty` per allocation = qty of packages already created against that allocation — compute as `min(item.scannedQty, allocation.qty)` is wrong; track properly: the web tracks scanned-per-allocation from packages' source ids; for the POC, use `scannedQty = 0` for receiving-order-backed allocations (web's applyOcrPick re-validates server-side) and `allocation.qty - allocation.remainingQty`... simplest faithful option: pass `scannedQty = 0` — the web check `scannedQty <= allocation.qty` then always passes, matching the common case; document the simplification). No match → toast `picking_detail_no_matching_allocation`. Match → pin it and continue the pinned flow above.
- **Apply dispatch seam**: add to `PickingDetailSource` (Task 9): `suspend fun scanAllocation(allocationId: String, qty: Int, actorId: String): String` (→ `PickingRepository.scanAllocationToPackage`) and `suspend fun applyOcrPick(receivingOrderId: String, pickingItemId: String, qty: Int, dateCode: String?, lotCode: String?, coo: String?, cow: String?, actorId: String)` (→ `PickingRepository.applyOcrPick`).

VM additions to `PickingDetailUiState`:

```kotlin
val scanPin: ScanMatcher.PinnedAllocation? = null,
val scanReview: ScanReviewUiState? = null,     // ui.scan
val dialogOpen: Boolean = false,
val pendingParse: ScanPrimitives.OcrInput? = null,
val pendingImagePath: String? = null,
```

VM functions: `pinAllocation(allocation: PickingAllocationDetail, item: PickingItemDetail)`, `onCameraScan(result: CameraScanResult)`, `onHardwareScan(text: String)` (no-op when `dialogOpen`), `findMatch()`, `applyScan(optionId: String)`, `updateScanFields(fields)`, `retakeScan()`, `closeScanReview()`, private `applyPicked(pin, fields)` containing the lot-vs-receiving dispatch and `runAction` wrapping. `openScanReviewOnError` sets `dialogOpen = true` at entry (Phase 1 race fix pattern).

- [ ] **Step 1: Write the failing tests**

`PickingDetailScanTest.kt` (fakes extending the Task 9 doubles + fake `LabelScanParser` + fake matcher behavior via direct `matchPicking` on real `ScanMatcher` — matchPicking is pure, so use the real one):

```kotlin
@Test fun `pinned single match auto applies to lot allocation without dialog`() = runTest {
    // detail with one lot-backed allocation (qty 10); vm.pinAllocation(it); vm.onCameraScan(parsed fields partNo+qty 4)
    // assert fake scanAllocation called with (allocationId, 4, actor); scanReview == null (no dialog); toastKey == scan success; reloaded
}

@Test fun `pinned receiving allocation applies via applyOcrPick`() = runTest {
    // receiving-order-backed allocation -> fake applyOcrPick received (receivingOrderId, pickingItemId, qty, ...)
}

@Test fun `match error opens review dialog`() = runTest {
    // scan partNo != pin partNo -> scanReview != null, dialogOpen == true, fields pre-filled
}

@Test fun `review dialog find match then apply`() = runTest {
    // after error dialog: vm.updateScanFields(corrected); vm.findMatch(); assert one matchOption
    // vm.applyScan(optionId) -> fake scanAllocation called, dialog closed, toast
}

@Test fun `wedge without pin matches allocation by part`() = runTest {
    // detail with allocation part "IC-1"; vm.onHardwareScan raw parsed to IC-1 qty 2 -> pinned + applied
}

@Test fun `wedge without pin no match toasts`() = runTest {
    // unknown part -> toastKey == no_matching_allocation, no apply call
}

@Test fun `wedge ignored while dialog open`() = runTest {
    // dialogOpen = true; vm.onHardwareScan("...") -> parser not invoked
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
./gradlew :app:testDebugUnitTest --tests "*PickingDetailScanTest"
```

- [ ] **Step 3: Implement**

VM additions + screen wiring per the behavior spec. Reuse `ReceivingDetailScreen.kt`'s camera-launcher and wedge wiring as the template (read it first; adapt names). The review dialog is the generalized `ui/scan/LabelScanReviewDialog` from Task 7.

- [ ] **Step 4: Run tests + assemble**

```bash
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

- [ ] **Step 5: Commit**

```bash
git add apps/android && git commit -m "android phase2: scan-to-pick wiring"
```

---

## Task 11: Docs, verification, Phase 3 handoff notes

**Files:**
- Modify: `AGENTS.md` (Android section: picking screens, batch issue, finish → measuring task, matchPicking, generalized scan dialog location)
- Modify: `docs/app-docs/ai/feature-registry.md` + `docs/app-docs/ai/code-map.md` (short additions to the Android subsections — picking flow files)
- Modify: `docs/superpowers/plans/2026-07-12-native-android-phase-2.md` (append handoff notes at the end)

- [ ] **Step 1: Full verification**

```bash
cd apps/android && export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr' && export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

Expected: full suite PASS, APK builds.

- [ ] **Step 2: On-device walkthrough (if a device is connected)**

```bash
'/d/android/platform-tools/adb.exe' devices
./gradlew :app:installDebug
```

Walk with adb screencap + taps (Phase 1 walkthrough technique; login operator / DocPal2026!, note the Simeji IME doubles `input text` — work around by deleting duplicated chars):
1. Home → Picking card → picking list renders (search, checkboxes on pending/picking only, finished sunk last).
2. Select one order → bottom bar → Report issue dialog (reason fields switch by reason) → save → order shows issue badge.
3. Open a picking order detail: header, items with allocations/packages, boxes section, logs toggle.
4. Create box → appears; Add all confirm; Cancel empty box.
5. If a fully-boxable fixture exists (or via scans from Phase 1 seed state), finish → measuring task id row appears.
6. Receiving detail → picking tab → tap picking order ref → navigates to picking detail.
Record verified-vs-deferred honestly (camera scan/wedge need labels/scanner — likely deferred).

- [ ] **Step 3: Update docs**

Short additions only; link to this plan rather than duplicating.

- [ ] **Step 4: Append `## Phase 3 handoff notes` to this plan**

Cover:
- What Phase 3 (put-away) reuses: scan pipeline end to end, `ui/scan/LabelScanReviewDialog`, ScanMatchers pattern (a put-away matcher context is the next sibling of `matchReceiving`/`matchPicking`), box/lot DAO queries, measuring task row existence (Phase 5 reads it).
- Known gaps: `materializeReceivingAllocation` usage points arrived with Task 10's applyOcrPick (verify and correct this note when writing); put-away scans table untouched; wedge `scannedQty = 0` simplification (Task 10); the inherited `removeScannedPackage` first-source-restore bug still open (web + Android); seam interfaces `ReceivingDetailSource`/`MismatchSource`/`SessionSource`/`PickingSource` still in `ui/receiving/ReceivingDetailViewModel.kt`; `removeScannedPackage` action exists on the receiving picking tab but not on the picking detail (web parity — not an omission); measuring link on finished picking orders is plain text until Phase 5.
- Deferred verifications from Step 2.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/app-docs/ai/feature-registry.md docs/app-docs/ai/code-map.md docs/superpowers/plans/2026-07-12-native-android-phase-2.md
git commit -m "android phase2: docs + handoff notes"
```

---

## Self-review checklist (completed during plan writing)

- [x] Spec coverage: Phase 2 row of the design spec — list ✓ (Tasks 2, 8), batch issue ✓ (Tasks 3, 8), detail ✓ (Tasks 5, 9), scan-to-pick ✓ (Tasks 6, 10), boxes incl. cancel ✓ (Tasks 4, 9), finish → measuring task ✓ (Tasks 4, 9). Exit criteria "picking flow reproducible; finish creates measuring task" covered by Tasks 4 (repo test asserts task creation) + 11 (device walkthrough).
- [x] Web behavior sources cited per task with file:line (pages, components, db modules, i18n).
- [x] Error keys traced from `apps/web/db/picking.ts` / `useScanMatchers.ts` to the Task 1 string list; params-carrying codes (`actual_qty_must_be_less_than_requested`) flagged for ErrorText args.
- [x] Reuse of Phase 1 infrastructure verified against the actual code: `PickingRepository` mutations, `ScanPrimitives.OcrInput`/`parseManual`, `ScanMatcher` shape, `LabelScanReviewDialog` param-based design, source-interface seams, test fixtures (`PickingRepositoryTest` pattern), StringsParityTest.
- [x] Deliberate web-parity deviations documented: no ScanFab/manual button on picking detail; single-match auto-apply (no confirmSingleMatch); wedge `scannedQty = 0` simplification; measuring link rendered as plain text until Phase 5.
- [x] Type consistency: `PickingOrderSummary`, `PickingOrderDetail`/`PickingItemDetail`/`PickingAllocationDetail`/`PickingPackageDetail`/`PickingBoxDetail`, `PickingIssueInput`, `PinnedAllocation`, `PickingMatchResult`, `ScanMatchOption`/`ScanReviewUiState` defined once and used consistently across tasks; `PickingDetailSource` introduced in Task 9 and extended in Task 10 with exact signatures.
- [x] Every task has failing-test-first steps, exact commands, and a commit step.
