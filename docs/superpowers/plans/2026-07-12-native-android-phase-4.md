# Native Android Phase 4 (Goods Verify) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduce the web goods-verify flow on the native Android app: shelf list → boxes on shelf → box detail, scan each put-away item to verify it, and mark fully-verified boxes verified — "Verify flow reproducible" (design spec Phase 4 exit criteria).

**Architecture:** Three-level drill-down under `ui/goodsverify/` (shelf list → shelf box list → box detail) backed by a new `GoodsVerifyRepository` (domain) + `GoodsVerifyDao` (data/db). No schema changes: `put_away_scans.verified`/`verified_at`, `shelf_boxes.status` (`"verified"` already mapped in `StatusBadge` family `"box"`), and `shelves.zone` all exist. Scan-to-verify is box-scoped (no pin), reuses the camera launcher + `LabelScanReviewDialog`, and — web parity (`confirmSingleMatch: true`) — always opens the review dialog even on a single match. A fully-verified box auto-marks verified after a successful scan apply (web `onScanApplied` parity) or via the header button.

**Tech Stack:** Kotlin, Jetpack Compose, Room (in-memory for tests), Robolectric JVM tests (`@Config(sdk=[34])`), existing scan pipeline (`QrParser`/`OcrLabelParser`/`ScanPrimitives`/`ScanMatcher`).

**References:**
- Design spec: `docs/superpowers/specs/2026-07-12-native-android-design.md` (Phase 4 row, flow 6).
- Phase 3 handoff: `docs/superpowers/plans/2026-07-12-native-android-phase-3.md` (`## Phase 4 handoff notes` — read first; critical: **no `verification_tasks` table on Android** — list shelves/boxes directly).
- Web behavior (authoritative = **pglite** path, same choice as Phase 3): `apps/web/db/goodsVerify.ts`, `apps/web/pages/goods-verify/index.vue`, `apps/web/pages/goods-verify/shelf/[code].vue`, `apps/web/pages/goods-verify/box/[id].vue`, `apps/web/composables/useScanMatchers.ts:301-320` (`matchGoodsVerify`), `apps/web/composables/useLabelScan.ts:155-186`. API divergences (`apps/api/src/db/putAway.ts:243-254`, `apps/api/src/db/measure.ts:152-183`) are documented where relevant but NOT ported.
- Tests documenting web behavior: `apps/web/tests/goodsVerify.test.ts`, `apps/api/src/db/goodsVerify.test.ts`.

**Conventions (carried from Phases 1–3, do not re-litigate):**
- Gradle: `cd apps/android && export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr' && export PATH="$JAVA_HOME/bin:$PATH"` before any `./gradlew`; run gradle SEQUENTIALLY (file locks); on a lock failure `./gradlew --stop` and retry.
- TDD per task: failing test first, full suite green before commit, `./gradlew :app:assembleDebug` on UI tasks.
- Test count baseline: **249**. Trajectory: 249 → 249 (T1) → 254 (T2) → 260 (T3) → 266 (T4) → 269 (T5) → 272 (T6) → 276 (T7) → 282 (T8) → verified at T9. If a count is lower than expected, investigate.
- Commit staging: `git add apps/android/app/src/main/java apps/android/app/src/test apps/android/app/src/main/res` (+ doc paths where noted). NEVER stage `apps/android/app/src/main/assets/seed.sql`, `apps/web/`, or `apps/api/` — other agents keep those dirty.
- Tests seed-agnostic: fixtures define their own ids; never hardcode seed UUIDs.
- Slice interfaces: VM defines a narrow `*Source` interface in its own file; the repository opts in with `override`s (Phase 2/3 pattern).
- VM conventions: injected `io` dispatcher, race-safe `loadJob` reload, serialized `runAction` mutations with `actionInProgress`, `LocalizedException` → `errorKey` + `errorArgs`, `provideFactory(container, key)` per nav argument.
- Web parity decisions already made for this phase (do not reopen):
  - **pglite semantics** for both mutations: `verifyShelfBoxScans` updates all scans of the part in the box (no status check, no transition log, zero rows → `shelf_box_item_not_found`); `markShelfBoxVerified` does NOT require `closed` status (flips open or closed → verified). The API's closed-status requirement and cycle-count tasks are NOT ported.
  - **No wedge, no manual-entry button** (web goods-verify pages don't use `useHardwareScanner`; camera is the only capture path, review dialog is always in `review` mode since camera captures carry an image).
  - **Always-confirm scan UX**: every completed scan opens `LabelScanReviewDialog` — both the single-match and the match-error paths (web toasts matcher errors, but the Android Phase 2/3 precedent routes match errors to the review dialog with editable fields; single-match confirm is web `confirmSingleMatch: true`).
  - **No success toast** on verify apply (web shows none — the item card flipping to verified + timestamp is the feedback); error toasts only.
  - Item aggregation key is `(box, part)` with synthetic item identity — no per-scan verify UI.

---

## Task 1: i18n strings for goods-verify flow

**Files:**
- Modify: `apps/android/app/src/main/res/values/strings.xml`
- Modify: `apps/android/app/src/main/res/values-zh-rCN/strings.xml`
- Modify: `apps/android/app/src/main/res/values-zh-rHK/strings.xml`

Add the keys below to all three locale files (identical key sets — `StringsParityTest` enforces). Before adding, grep the existing `strings.xml` for each key: reuse anything that already exists (`status_box_verified`, `menu_goods_verify_*`, `log_state_verified` exist; `error_operator_not_signed_in` exists). English values come from `apps/web/i18n/locales/en-US.ts` (goodsVerify block `:312-337`, errors `:570-604`, common keys); zh-CN/zh-HK values come from `apps/web/i18n/locales/zh-CN.ts` / `zh-HK.ts` for keys that exist there. `part_not_found_in_box` is MISSING from the web locales (web matcher throws it but no locale entry) — coin translations in the style of the neighboring strings.

Screen strings:

| Key | English |
|---|---|
| `goods_verify_title` | Goods Verify |
| `goods_verify_search_shelves` | Search shelf code or zone… |
| `goods_verify_no_shelves` | No shelves found. |
| `goods_verify_boxes_count` | %1$d boxes |
| `goods_verify_boxes_title` | Shelf Boxes |
| `goods_verify_boxes_intro` | Boxes on shelf %1$s. |
| `goods_verify_search_boxes` | Search box ID or status… |
| `goods_verify_no_boxes` | No boxes on this shelf. |
| `goods_verify_verified_fraction` | %1$d / %2$d verified |
| `goods_verify_last_check` | Last check: %1$s |
| `goods_verify_box_title` | Box %1$s |
| `goods_verify_box_not_found` | Box not found. |
| `goods_verify_mark_verified` | Mark box verified |
| `goods_verify_shelf_label` | Shelf |
| `goods_verify_expected_items` | Expected items |
| `goods_verify_no_items` | No items in this box. |
| `goods_verify_part` | Part |
| `goods_verify_qty` | Qty |
| `goods_verify_verified_label` | Verified |
| `goods_verify_scan` | Scan |
| `common_today` | Today |
| `common_yes` | Yes |
| `common_no` | No |

Error strings (`error_<code>` convention, resolved by `ErrorText`/`errorMessage`):

| Key | English |
|---|---|
| `error_shelf_box_not_found` | Shelf box not found |
| `error_shelf_box_item_not_found` | Shelf box item not found |
| `error_shelf_box_already_verified` | Shelf box is already verified |
| `error_shelf_box_has_no_items` | Shelf box has no items to verify |
| `error_not_all_shelf_box_items_verified` | Not all shelf box items are verified |
| `error_part_no_required` | Part No. is required |
| `error_part_not_found_in_box` | Part not found in box |

- [ ] **Step 1:** Add the keys to all three locale files. Keep each file's existing key ordering idiom (keys are grouped by prefix; add the `goods_verify_*` block after the put-away block, `common_today`/`common_yes`/`common_no` near the other `common_*`, `error_*` in the error run). Preserve exact apostrophe/ellipsis characters as used in neighboring entries.
- [ ] **Step 2:** Run `cd apps/android && export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr' && export PATH="$JAVA_HOME/bin:$PATH" && ./gradlew :app:testDebugUnitTest --tests "*StringsParityTest"` — parity green. Full suite stays at 249.
- [ ] **Step 3:** Commit: `git add apps/android/app/src/main/res && git commit -m "android phase4: goods-verify i18n strings"`

---

## Task 2: Goods-verify read model (DAO + repository reads)

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/GoodsVerifyDao.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/model/GoodsVerifyModels.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/GoodsVerifyRepository.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/AppDatabase.kt` (register DAO)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/AppContainer.kt` (`goodsVerifyRepository`)
- Modify: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/PutAwayDbFixture.kt` (add `verified`/`verifiedAt` params to `insertPutAwayScan`, defaults `0`/`null`; add `insertPart` if the fixture cannot already create a `parts` row — check what `insertReceivingInvoiceItem` inserts)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/GoodsVerifyReadTest.kt`

Web reference: `apps/web/db/goodsVerify.ts:45-152` (pglite `getShelvesWithBoxes`, `getShelfBoxesByShelf`, `getShelfBoxDetail`). SQLite translation notes: web `bool_and(verified)` → `MIN(verified)`; item ids synthetic.

Models (`GoodsVerifyModels.kt`):

```kotlin
data class ShelfSummary(
    val code: String,
    val zone: String?,
    val boxCount: Int,
)

data class VerifyBoxSummary(
    val id: String,
    val status: String,
    val itemCount: Int,        // distinct parts with scans in the box
    val verifiedCount: Int,    // parts whose scans are ALL verified
    val lastCheckAt: Long?,    // max verified_at, epoch ms
    val checkedToday: Boolean, // lastCheckAt on the current UTC date
)

data class VerifyBoxItem(
    val partId: String,
    val partNo: String,
    val description: String?,
    val qty: Int,              // SUM(qty) over the box's scans for this part
    val verified: Boolean,     // MIN(verified) == 1
    val verifiedAt: Long?,     // MAX(verified_at), epoch ms
)

data class VerifyBoxDetail(
    val id: String,
    val status: String,
    val shelfCode: String?,
    val shelfZone: String?,
    val items: List<VerifyBoxItem>,
) {
    val allVerified: Boolean get() = items.isNotEmpty() && items.all { it.verified }
}
```

DAO queries (`GoodsVerifyDao.kt`, plain blocking `fun` like `PutAwayDao`):

```kotlin
@Query("""
    SELECT s.code AS code, s.zone AS zone, COUNT(sb.id) AS boxCount
    FROM shelves s LEFT JOIN shelf_boxes sb ON sb.shelf_code = s.code
    GROUP BY s.code ORDER BY s.code
""")
fun shelfSummaries(): List<ShelfSummaryRow>

@Query("""
    SELECT sb.id AS id, sb.status AS status, sb.created_at AS createdAt,
        (SELECT COUNT(*) FROM (SELECT 1 FROM put_away_scans WHERE shelf_box_id = sb.id GROUP BY part_id)) AS itemCount,
        (SELECT COUNT(*) FROM (SELECT 1 FROM put_away_scans WHERE shelf_box_id = sb.id GROUP BY part_id HAVING MIN(verified) = 1)) AS verifiedCount,
        (SELECT MAX(verified_at) FROM put_away_scans WHERE shelf_box_id = sb.id) AS lastCheckAt
    FROM shelf_boxes sb WHERE sb.shelf_code = :shelfCode ORDER BY sb.created_at DESC
""")
fun boxSummaries(shelfCode: String): List<VerifyBoxSummaryRow>

@Query("SELECT sb.id AS id, sb.status AS status, sb.shelf_code AS shelfCode, s.zone AS shelfZone FROM shelf_boxes sb LEFT JOIN shelves s ON s.code = sb.shelf_code WHERE sb.id = :boxId")
fun boxHeader(boxId: String): VerifyBoxHeaderRow?

@Query("""
    SELECT pas.part_id AS partId, p.part_no AS partNo, p.description AS description,
        SUM(pas.qty) AS qty, MIN(pas.verified) AS allVerified, MAX(pas.verified_at) AS verifiedAt
    FROM put_away_scans pas JOIN parts p ON p.id = pas.part_id
    WHERE pas.shelf_box_id = :boxId GROUP BY pas.part_id ORDER BY p.part_no
""")
fun boxItems(boxId: String): List<VerifyBoxItemRow>
```

Repository (`GoodsVerifyRepository.kt` — class KDoc notes the pglite reference and that `verification_tasks`/`scheduleCycleCount` are deliberately absent on Android):

```kotlin
class GoodsVerifyRepository(private val db: AppDatabase) {
    private val dao get() = db.goodsVerifyDao()

    suspend fun listShelves(): List<ShelfSummary> = withContext(Dispatchers.IO) {
        dao.shelfSummaries().map { ShelfSummary(it.code, it.zone, it.boxCount) }
    }

    suspend fun listBoxes(shelfCode: String): List<VerifyBoxSummary> = withContext(Dispatchers.IO) {
        val today = LocalDate.now(ZoneOffset.UTC)
        dao.boxSummaries(shelfCode).map { row ->
            VerifyBoxSummary(
                id = row.id, status = row.status,
                itemCount = row.itemCount, verifiedCount = row.verifiedCount,
                lastCheckAt = row.lastCheckAt,
                checkedToday = row.lastCheckAt?.let {
                    Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate() == today
                } ?: false,
            )
        }
    }

    suspend fun getBoxDetail(boxId: String): VerifyBoxDetail? = withContext(Dispatchers.IO) {
        val header = dao.boxHeader(boxId) ?: return@withContext null
        VerifyBoxDetail(
            id = header.id, status = header.status,
            shelfCode = header.shelfCode, shelfZone = header.shelfZone,
            items = dao.boxItems(boxId).map {
                VerifyBoxItem(it.partId, it.partNo, it.description, it.qty, it.allVerified == 1, it.verifiedAt)
            },
        )
    }
}
```

`AppContainer`: `val goodsVerifyRepository by lazy { GoodsVerifyRepository(database) }` next to `putAwayRepository`.

- [ ] **Step 1: Write the failing tests** — `GoodsVerifyReadTest.kt` (Robolectric `@Config(sdk=[34])`, in-memory DB, `offMainThread { db.clearAllTables() }` in setUp, `runBlocking`, fixtures from the extended `PutAwayDbFixture`; seed-agnostic ids):

```kotlin
@Test fun `shelves list includes zero-box shelves with counts`() = runBlocking {
    // shelves A-01-01 (1 box), B-01-01 (0 boxes) -> 2 rows ordered by code, boxCount 1 and 0
}
@Test fun `box summaries aggregate per part`() = runBlocking {
    // box with part X (2 scans, both verified, verifiedAt = now) and part Y (1 scan unverified)
    // -> itemCount 2, verifiedCount 1, lastCheckAt = now, checkedToday true
}
@Test fun `checkedToday false for older checks`() = runBlocking {
    // one fully verified part with verifiedAt = now - 2 * 86_400_000 -> checkedToday false
}
@Test fun `box detail groups scans by part`() = runBlocking {
    // 3 scans: part X qty 2+3 (one verified), part Y qty 1 (verified) ->
    // items ordered by partNo: X(qty 5, verified false, verifiedAt null-or-set), Y(qty 1, verified true)
}
@Test fun `box detail null for unknown box`() = runBlocking { /* getBoxDetail("nope") == null */ }
```

- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*GoodsVerifyReadTest"` — verify failure.
- [ ] **Step 3:** Implement models, DAO, repository, DI, fixture extension.
- [ ] **Step 4:** Full suite green (249 → 254).
- [ ] **Step 5:** Commit: `git add apps/android/app/src/main/java apps/android/app/src/test && git commit -m "android phase4: goods-verify read model"`

---

## Task 3: Verify mutations (verify item, mark box verified)

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/GoodsVerifyDao.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/GoodsVerifyRepository.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/GoodsVerifyMutationTest.kt`

Web reference: `apps/web/db/goodsVerify.ts:154-208` (pglite `verifyShelfBoxScans`, `markShelfBoxVerified`). API divergences NOT ported: the API's `verified=0`-only update + 404 (`apps/api/src/db/putAway.ts:243-254`) and the closed-status requirement (`apps/api/src/db/measure.ts:162`) — note both in the repository KDoc.

DAO additions:

```kotlin
@Query("UPDATE put_away_scans SET verified = 1, verified_at = :now WHERE shelf_box_id = :boxId AND part_id = :partId")
fun verifyScansInBoxForPart(boxId: String, partId: String, now: Long): Int

@Query("SELECT COUNT(*) FROM put_away_scans WHERE shelf_box_id = :boxId")
fun scanCount(boxId: String): Int

@Query("SELECT COUNT(*) FROM put_away_scans WHERE shelf_box_id = :boxId AND verified = 0")
fun unverifiedScanCount(boxId: String): Int

@Query("UPDATE shelf_boxes SET status = :status WHERE id = :boxId")
fun updateBoxStatus(boxId: String, status: String)

@Insert
fun insertTransitionLog(row: TransitionLogEntity)
```

Repository additions (validation order pinned by tests; both mutations self-wrap `db.runInTransaction`):

```kotlin
/** pglite verifyShelfBoxScans: verifies every scan of the part in the box; no status check, no log. */
suspend fun verifyBoxItem(boxId: String, partId: String) = withContext(Dispatchers.IO) {
    db.runInTransaction {
        val changed = dao.verifyScansInBoxForPart(boxId, partId, System.currentTimeMillis())
        if (changed == 0) throw LocalizedException("shelf_box_item_not_found")
    }
}

/** pglite markShelfBoxVerified: not-found → already-verified → no-items → not-all-verified; logs closed|open → verified. */
suspend fun markBoxVerified(boxId: String, actorId: String) = withContext(Dispatchers.IO) {
    db.runInTransaction {
        val header = dao.boxHeader(boxId) ?: throw LocalizedException("shelf_box_not_found")
        if (header.status == "verified") throw LocalizedException("shelf_box_already_verified")
        if (dao.scanCount(boxId) == 0) throw LocalizedException("shelf_box_has_no_items")
        if (dao.unverifiedScanCount(boxId) > 0) throw LocalizedException("not_all_shelf_box_items_verified")
        dao.updateBoxStatus(boxId, "verified")
        dao.insertTransitionLog(
            TransitionLogEntity(
                id = UUID.randomUUID().toString(),
                entityType = "shelf_box",
                entityId = boxId,
                fromState = header.status,
                toState = "verified",
                actorId = actorId,
                metadata = null,
                createdAt = System.currentTimeMillis(),
            )
        )
    }
}
```

(Check `TransitionLogEntity`'s real constructor in `data/db/AuditEntities.kt` and the Phase 3 `insertBoxTransitionLog` helper shape — match field names/defaults exactly. If a shared insert helper already exists on another DAO, reuse the established pattern instead of duplicating.)

- [ ] **Step 1: Write the failing tests** — `GoodsVerifyMutationTest.kt` (same harness as `GoodsVerifyReadTest`):

```kotlin
@Test fun `verify item sets verified flags and timestamp`() = runBlocking {
    // 2 scans part X (unverified) + 1 scan part Y -> verifyBoxItem(box, X) ->
    // both X rows verified=1 with verified_at set; Y untouched
}
@Test fun `verify item unknown part throws shelf_box_item_not_found`() = runBlocking {
    // expectCode("shelf_box_item_not_found") { repo.verifyBoxItem(box, "no-part") }
}
@Test fun `mark verified flips status and logs transition`() = runBlocking {
    // closed box, all scans verified -> status "verified"; transition_logs row
    // entity_type shelf_box, from "closed" to "verified", actorId, metadata null
}
@Test fun `mark verified allows open box (pglite parity)`() = runBlocking {
    // open box, all verified -> succeeds, from_state "open" in the log
}
@Test fun `mark verified rejects unverified scans`() = runBlocking {
    // one unverified scan -> expectCode("not_all_shelf_box_items_verified"); status unchanged
}
@Test fun `mark verified validation order`() = runBlocking {
    // unknown box -> shelf_box_not_found; already verified -> shelf_box_already_verified;
    // empty box -> shelf_box_has_no_items (three asserts in one test, order as listed)
}
```

- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*GoodsVerifyMutationTest"` — verify failure.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full suite green (254 → 260).
- [ ] **Step 5:** Commit: `git add apps/android/app/src/main/java apps/android/app/src/test && git commit -m "android phase4: goods-verify mutations"`

---

## Task 4: Goods-verify scan matcher (domain)

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/scan/ScanMatcher.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/scan/MatchGoodsVerifyTest.kt`

Port `matchGoodsVerify` (`apps/web/composables/useScanMatchers.ts:301-320`). Pure function over the box's UNVERIFIED items — no DAO, no new constructor seams. Key difference from the put-away matcher: **qty is not validated** — verification is per-part; the label's qty is irrelevant (web never checks it). Add to `ScanMatcher.kt` after the put-away declarations:

```kotlin
/** An unverified item in the box being verified (aggregation key is part). */
data class GoodsVerifyTarget(
    val partId: String,
    val partNo: String,               // normalized (ScanPrimitives.normalize)
    val qty: Int,                     // aggregated box qty for display
)

sealed class GoodsVerifyMatchResult {
    data class Single(val item: GoodsVerifyTarget) : GoodsVerifyMatchResult()
    data class Error(val key: String) : GoodsVerifyMatchResult()
}

/** Port of useScanMatchers.matchGoodsVerify: matches the scanned part against the box's unverified items. */
fun matchGoodsVerify(
    targets: List<GoodsVerifyTarget>,       // unverified items only
    parsed: ScanPrimitives.OcrInput,
    actorId: String?,
): GoodsVerifyMatchResult {
    if (actorId == null) return GoodsVerifyMatchResult.Error("operator_not_signed_in")
    val partNo = ScanPrimitives.normalize(parsed.partNo)
    if (partNo.isEmpty()) return GoodsVerifyMatchResult.Error("part_no_required")
    val item = targets.firstOrNull { it.partNo == partNo }
        ?: return GoodsVerifyMatchResult.Error("part_not_found_in_box")
    return GoodsVerifyMatchResult.Single(item)
}
```

Notes:
- Validation order follows the Android sibling precedent (actor → parse → part lookup). The web checks `operator_not_signed_in` first too (`useScanMatchers.ts:303`).
- The web's `part_no_required` fires on empty parsed partNo; `part_not_found_in_box` when no unverified item matches (web `findUnverifiedBoxItemByPartNo`, `:92-100`). Normalization = `ScanPrimitives.normalize` (trim/uppercase/collapse-space parity with web `useMockOcr.ts:37-39`).
- Already-verified parts are absent from `targets`, so scanning one yields `part_not_found_in_box` — same as the web.
- `Single` carries no qty from the scan; apply uses `item.partId` only.

- [ ] **Step 1: Write the failing tests** — `MatchGoodsVerifyTest.kt` (plain JVM, `MatchPutAwayTest` style; `ScanMatcher` with `{ emptyList() }` stub lambdas):

```kotlin
private val targets = listOf(ScanMatcher.GoodsVerifyTarget("part-1", "RK73H1JTTD6201F", 12))
private fun input(partNo: String = "RK73H1JTTD6201F") = ScanPrimitives.OcrInput(partNo, "", "", "", "", "")
```

(Verify `OcrInput`'s real constructor and adjust — partNo first.)

- `single when part matches an unverified item` → `Single(targets[0])`
- `match is normalized` (input lowercase + extra spaces) → `Single`
- `empty part` (partNo "") → `Error("part_no_required")`
- `part not in box` → `Error("part_not_found_in_box")`
- `already verified part not in targets` (targets emptyList) → `Error("part_not_found_in_box")`
- `not signed in` → `Error("operator_not_signed_in")`

- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*MatchGoodsVerifyTest"` — verify failure.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full suite green (260 → 266).
- [ ] **Step 5:** Commit: `git add apps/android/app/src/main/java apps/android/app/src/test && git commit -m "android phase4: goods-verify scan matcher"`

---

## Task 5: Shelf list screen + nav + home card

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/goodsverify/GoodsVerifyShelfListViewModel.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/goodsverify/GoodsVerifyShelfListScreen.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/navigation/AppNav.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/home/HomeScreen.kt` (Goods Verify card navigates)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/AppContainer.kt` (factory entries)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/ui/goodsverify/GoodsVerifyShelfListViewModelTest.kt`

Web reference: `apps/web/pages/goods-verify/index.vue`. Behavior:

- Search field (`goods_verify_search_shelves`) filtering client-side on code/zone (web `index.vue:60-68`).
- Rows: whole card clickable → shelf box list; shelf `code` + `zone` (zone omitted when null) + badge `goods_verify_boxes_count` with boxCount.
- Empty (after filter or load): `goods_verify_no_shelves`; spinner on first load; reload via `OnResumeEffect`; error via `ErrorText`.
- No back button (top-level screen, like the other list screens).

VM (constructor: `GoodsVerifyShelfListSource` interface { `suspend fun listShelves(): List<ShelfSummary>` } — `GoodsVerifyRepository` opts in; `io` dispatcher):

```kotlin
data class GoodsVerifyShelfListUiState(
    val loading: Boolean = true,
    val shelves: List<ShelfSummary> = emptyList(),
    val errorKey: String? = null,
    val errorArgs: List<String> = emptyList(),
)
```

Race-safe `loadJob` reload (established list-VM pattern). Filter state is screen-held (`remember`/`rememberSaveable` query string) — the VM stays dumb, matching how picking search is screen-side.

`AppNav.kt`:

```kotlin
const val GOODS_VERIFY_SHELVES = "goods-verify"
const val GOODS_VERIFY_SHELF_BOXES = "goods-verify/shelf/{shelfCode}"
const val GOODS_VERIFY_BOX = "goods-verify/box/{boxId}"
fun goodsVerifyShelfBoxes(shelfCode: String) = "goods-verify/shelf/$shelfCode"
fun goodsVerifyBox(boxId: String) = "goods-verify/box/$boxId"
```

Wire `composable(Routes.GOODS_VERIFY_SHELVES) { GoodsVerifyShelfListScreen(onShelfClick = { navController.navigate(Routes.goodsVerifyShelfBoxes(it)) }) }` plus placeholder composables for the two deeper routes (a `Text` showing the argument — replaced in Tasks 6/7, Phase 3 Task 8 precedent). `HomeScreen.kt`: the Goods Verify `MenuCard` (currently route-less → coming-soon toast, `HomeScreen.kt:88`) gets `Routes.GOODS_VERIFY_SHELVES`. `AppContainer`: factory entry `GoodsVerifyShelfListViewModel(goodsVerifyRepository)`.

- [ ] **Step 1: Write the failing VM tests** — `GoodsVerifyShelfListViewModelTest.kt` (fakes + `Dispatchers.setMain` pattern from `PutAwayListViewModelTest`):

```kotlin
@Test fun `loads shelves`() = runTest { /* fake 2 shelves -> 2 in state, loading false */ }
@Test fun `empty list renders empty state`() = runTest { /* fake empty -> shelves empty, no error */ }
@Test fun `repository error surfaces as errorKey`() = runTest { /* fake throws LocalizedException -> errorKey set, loading false */ }
```

- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*GoodsVerifyShelfListViewModelTest"` — verify failure.
- [ ] **Step 3:** Implement VM + screen + nav wiring. Follow `PutAwayListScreen.kt` layout idioms (Scaffold + TopAppBar `goods_verify_title`, LazyColumn cards) plus the picking list's search-field idiom for the filter.
- [ ] **Step 4:** Full suite green (266 → 269) + `./gradlew :app:assembleDebug`.
- [ ] **Step 5:** Commit: `git add apps/android/app/src/main/java apps/android/app/src/test apps/android/app/src/main/res && git commit -m "android phase4: goods-verify shelf list + nav"`

---

## Task 6: Shelf box list screen

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/goodsverify/GoodsVerifyBoxListViewModel.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/goodsverify/GoodsVerifyBoxListScreen.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/navigation/AppNav.kt` (replace placeholder)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/ui/goodsverify/GoodsVerifyBoxListViewModelTest.kt`

Web reference: `apps/web/pages/goods-verify/shelf/[code].vue`. Behavior:

- Intro line `goods_verify_boxes_intro` with the shelf code; search field (`goods_verify_search_boxes`) filtering client-side on id/status (web `[code].vue:86-94`).
- Rows: whole card clickable → box detail; box id + `goods_verify_verified_fraction` (verifiedCount, itemCount) + `StatusBadge(status, family = "box")` + last-check line `goods_verify_last_check` (formatted `lastCheckAt`, only when non-null) with an inline `common_today` badge when `checkedToday`; done-card styling (reuse the shared `CardDoneColor` border from `ui.picking`) when `status == "verified"` (web `card--done`).
- Empty: `goods_verify_no_boxes`; spinner on first load; `OnResumeEffect` reload; `ErrorText`; back button to the shelf list (detail-screen TopAppBar idiom from put-away).

VM (constructor: `shelfCode`, `GoodsVerifyBoxListSource` interface { `suspend fun listBoxes(shelfCode: String): List<VerifyBoxSummary>` } — repo opts in; `io` dispatcher; `provideFactory(container, shelfCode)`):

```kotlin
data class GoodsVerifyBoxListUiState(
    val loading: Boolean = true,
    val boxes: List<VerifyBoxSummary> = emptyList(),
    val errorKey: String? = null,
    val errorArgs: List<String> = emptyList(),
)
```

Timestamp formatting: reuse the established epoch-ms formatting helper used by the detail screens (check `PutAwayDetailScreen`/`PickingDetailScreen` for the current idiom; a date-time form is wanted here — date only is acceptable if that is what the shared helper produces; do not invent a new dependency).

- [ ] **Step 1: Write the failing VM tests** — `GoodsVerifyBoxListViewModelTest.kt`:

```kotlin
@Test fun `loads boxes for shelf`() = runTest { /* fake 2 boxes -> 2 in state, loading false */ }
@Test fun `empty shelf renders empty state`() = runTest { /* fake empty -> no error */ }
@Test fun `repository error surfaces as errorKey`() = runTest { ... }
```

- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*GoodsVerifyBoxListViewModelTest"` — verify failure.
- [ ] **Step 3:** Implement VM + screen; wire the `GOODS_VERIFY_SHELF_BOXES` route (navArgument `shelfCode`, `requireNotNull` guard like the other detail routes).
- [ ] **Step 4:** Full suite green (269 → 272) + `./gradlew :app:assembleDebug`.
- [ ] **Step 5:** Commit: `git add apps/android/app/src/main/java apps/android/app/src/test apps/android/app/src/main/res && git commit -m "android phase4: goods-verify box list screen"`

---

## Task 7: Box detail screen — header, expected items, mark verified

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/goodsverify/GoodsVerifyBoxDetailViewModel.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/goodsverify/GoodsVerifyBoxDetailScreen.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/goodsverify/GoodsVerifyItemsSection.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/navigation/AppNav.kt` (replace placeholder)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/ui/goodsverify/GoodsVerifyBoxDetailViewModelTest.kt`

Web reference: `apps/web/pages/goods-verify/box/[id].vue`. Screen behavior:

- **Header** (DetailHeader-style card): title `goods_verify_box_title` with box id + `StatusBadge(status, family = "box")`; row `goods_verify_shelf_label` → shelf code (`common_no_data` fallback when null — box can be shelf-less after a cancelled shelf assignment; web API returns shelf or null). Actions slot: **Mark box verified** button (`goods_verify_mark_verified`) only when `canMarkVerified`; disabled while `actionInProgress`.
- **Items section** (`GoodsVerifyItemsSection.kt`, LazyListScope extension — Phase 2/3 precedent): title `goods_verify_expected_items`; empty → `goods_verify_no_items`. Per item card (done styling when `item.verified`): `goods_verify_part` (partNo), `goods_verify_qty` (aggregated qty), `goods_verify_verified_label` → when verified show the formatted `verifiedAt` timestamp with a finished-style badge, when unverified show `common_no` (web shows a pending badge + `common.yes`/`common.no`; Android: timestamp when verified, `common_no` when not), and a **Scan** button (`goods_verify_scan`) on unverified items — rendered behind `scanEnabled: Boolean = false` (Task 8 wires it). Every Scan button triggers the SAME box-level scan (web parity — there is no per-item pin).
- `OnResumeEffect { viewModel.reload() }`; `collectAsStateWithLifecycle`; `ErrorText(state.errorKey, args = state.errorArgs)` in the header card; unknown box (`detail == null` after load) → `goods_verify_box_not_found` empty state.

VM (constructor: `boxId`, `GoodsVerifyBoxDetailSource` interface — `getBoxDetail(boxId)`, `verifyItem(boxId, partId)`, `markBoxVerified(boxId, actorId)` — `GoodsVerifyRepository` opts in; `SessionSource` reused from `ui/receiving/` via import; `io` dispatcher; `provideFactory(container, boxId)`):

```kotlin
data class GoodsVerifyBoxDetailUiState(
    val loading: Boolean = true,
    val detail: VerifyBoxDetail? = null,
    val errorKey: String? = null,
    val errorArgs: List<String> = emptyList(),
    val actionInProgress: Boolean = false,
) {
    val canMarkVerified: Boolean get() =
        detail != null && detail.status != "verified" && detail.allVerified
}
```

`markVerified()` through `runAction` (serialized; `SessionSource.currentUser()?.id ?: throw LocalizedException("operator_not_signed_in")`; reload on success). No success toast (web shows none — the card--done flip is the feedback).

- [ ] **Step 1: Write the failing VM tests** — `GoodsVerifyBoxDetailViewModelTest.kt` (fakes; `SessionSource` fake shape from `PutAwayDetailViewModelTest`):

```kotlin
@Test fun `loads detail on init`() = runTest { /* fake detail -> box id + items in state */ }
@Test fun `mark verified delegates and reloads`() = runTest { /* allVerified detail -> markVerified() -> fake called with (boxId, actor), reloaded */ }
@Test fun `canMarkVerified false until all items verified`() = runTest { /* one unverified item -> false; all verified + status open -> true; status verified -> false */ }
@Test fun `repository error surfaces as errorKey`() = runTest { /* fake markBoxVerified throws LocalizedException("not_all_shelf_box_items_verified") -> errorKey, actionInProgress false */ }
```

- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*GoodsVerifyBoxDetailViewModelTest"` — verify failure.
- [ ] **Step 3:** Implement per the behavior spec. Keep the screen to scaffold/header wiring; items as a LazyListScope extension. Wire the `GOODS_VERIFY_BOX` route.
- [ ] **Step 4:** Full suite green (272 → 276) + `./gradlew :app:assembleDebug`.
- [ ] **Step 5:** Commit: `git add apps/android/app/src/main/java apps/android/app/src/test apps/android/app/src/main/res && git commit -m "android phase4: goods-verify box detail screen"`

---

## Task 8: Scan-to-verify wiring

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/goodsverify/GoodsVerifyBoxDetailViewModel.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/goodsverify/GoodsVerifyBoxDetailScreen.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/goodsverify/GoodsVerifyItemsSection.kt` (enable Scan buttons)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/ui/goodsverify/GoodsVerifyBoxScanTest.kt`

Web references: `apps/web/pages/goods-verify/box/[id].vue:30-35,53-55,93-98,137-186` (ScanFab + per-item Scan + auto-mark), `apps/web/composables/useScanMatchers.ts:301-320`, `apps/web/composables/useLabelScan.ts:117-186` (`confirmSingleMatch: true`).

Behavior (web parity; deliberately narrower than put-away):

- **No wedge, no manual-entry button, no ScanFab composable** — scan entry points are the per-item Scan buttons on unverified item cards (web also has a ScanFab; Android uses the established per-row button pattern — noted deviation, no UX loss since every button triggers the same box-level scan). Enable the Task 7 buttons (`scanEnabled = true`), gated on `!actionInProgress` like put-away.
- **Scan** → launch the camera immediately (`rememberCameraScanLauncher`, `ui/receiving/ScanLaunchers.kt`). No pin — targets come from the box.
- **Scan result handling**: `QrParser.parseQrCapture` (templates from `ScanRepository.supplierQrTemplates()`, context supplier = null — the box aggregates parts across receiving orders, so there is no single supplier context; targets = the partNos of the box's UNVERIFIED items — web `scanTargets`, `box/[id].vue:137-143`) with `OcrLabelParser.parseAndIdentify` fallback — same `provideFactory` wiring + `LabelScanParser` seam as put-away.
- **Match**: `matchGoodsVerify(unverifiedTargets, fields, actorId)`:
  - `Single` → open the review dialog (`LabelScanReviewDialog`, `manual = false` — camera captures carry an image; web `confirmSingleMatch: true` — single matches do NOT auto-apply on this flow) with one match option (`"{partNo} ({qty})"` — the item's partNo + aggregated box qty, `R.string.scan_review_match_single`), fields pre-filled and editable.
  - `Error` → open the same dialog in the error state (`scan_review_error` + error key, fields editable) — the Android Phase 2/3 precedent for match errors (web toasts instead; the dialog path is strictly more capable and consistent within the app).
  - Find match re-runs `matchGoodsVerify` against the CURRENT unverified targets (from the latest loaded detail) with the edited fields.
  - Apply → `verifyItem(boxId, item.partId)`; success → close dialog + reload + **auto-mark check** (below); failure → inline `applyErrorKey` (dialog stays open).
  - Retake → close dialog, relaunch camera. Cancel → close dialog.
- **Auto-mark** (web `onScanApplied` parity, `box/[id].vue:93-98`): after a successful verify + reload, if the reloaded `detail.allVerified` and `detail.status != "verified"` → `runAction { markBoxVerified(boxId, actor) }`. On mark failure, surface `errorKey` (defensive; the check just passed).
- Reuse the Phase 3 Task 10 hardening: `scanInFlight` transient gate (set before parse, cleared on every terminal path — dialog path hands off to `dialogOpen`), `dialogOpen = true` at dialog entry, `runAction(scanApply = true)` semantics for the apply path (inline `applyErrorKey` when the dialog is open, `errorKey` otherwise). Mirror `PutAwayDetailViewModel` structure with goods-verify names. Note: put-away's `toastKey`/`toastArgs` machinery is NOT needed (no success toast here); apply errors when the dialog is closed surface via `errorKey`.

VM additions to `GoodsVerifyBoxDetailUiState`:

```kotlin
val scanReview: ScanReviewUiState? = null,     // ui.scan
val dialogOpen: Boolean = false,
```

VM functions: `onCameraScan(result: CameraScanResult)`, `findMatch()`, `applyScan(optionId: String)`, `updateScanFields(fields)`, `retakeScan()`, `closeScanReview()`, private `applyVerified(item, …)` with the `runAction` wrapping + auto-mark.

- [ ] **Step 1: Write the failing tests** — `GoodsVerifyBoxScanTest.kt` (fakes extending the Task 7 doubles + fake `LabelScanParser`; real `ScanMatcher`):

```kotlin
@Test fun `single match opens review dialog (always confirm)`() = runTest {
    // detail with one unverified item; vm.onCameraScan(parsed fields matching partNo)
    // -> scanReview != null, dialogOpen == true, one matchOption "RK73… (12)", verifyItem NOT yet called
}
@Test fun `apply verifies item and closes dialog`() = runTest {
    // after dialog: applyScan(optionId) -> fake verifyItem called with (boxId, partId), dialog closed, reloaded
}
@Test fun `match error opens dialog in error state`() = runTest {
    // scan partNo not in box -> scanReview != null with error key part_not_found_in_box, fields editable
}
@Test fun `apply failure shows inline error and stays open`() = runTest {
    // fake verifyItem throws LocalizedException("shelf_box_item_not_found") -> applyErrorKey set, dialogOpen true
}
@Test fun `auto marks box when last item verified`() = runTest {
    // detail with one unverified item; fake verifyItem flips it; next reload returns allVerified ->
    // fake markBoxVerified called with (boxId, actor); state status verified
}
@Test fun `retake clears dialog`() = runTest {
    // dialog open -> retakeScan() -> scanReview null, dialogOpen false
}
```

- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest --tests "*GoodsVerifyBoxScanTest"` — verify failure.
- [ ] **Step 3:** Implement VM additions + screen wiring per the behavior spec. Reuse `PutAwayDetailScreen.kt`'s camera-launcher wiring as the template.
- [ ] **Step 4:** Full suite green (276 → 282) + `./gradlew :app:assembleDebug`.
- [ ] **Step 5:** Commit: `git add apps/android/app/src/main/java apps/android/app/src/test apps/android/app/src/main/res && git commit -m "android phase4: scan-to-verify wiring"`

---

## Task 9: Docs, verification, Phase 5 handoff notes

**Files:**
- Modify: `AGENTS.md` (Android section: goods-verify screens, `GoodsVerifyRepository`, `matchGoodsVerify`, Phase 4 complete status + test count)
- Modify: `docs/app-docs/ai/feature-registry.md` + `docs/app-docs/ai/code-map.md` (short additions — goods-verify flow files)
- Modify: `docs/superpowers/plans/2026-07-12-native-android-phase-4.md` (append handoff notes at the end)

- [ ] **Step 1: Full verification**

```bash
cd apps/android && export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr' && export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

Expected: full suite PASS (282), APK builds.

- [ ] **Step 2: On-device walkthrough (if a device is connected)**

```bash
'/d/android/platform-tools/adb.exe' devices
./gradlew :app:installDebug
```

The Phase 3 walkthrough left the device DB with `SBOX-0001` closed on `A-01-01` holding 265 unverified put-away lines — the starting state. The Phase 3 walkthrough also left DB-inject helper scripts under `apps/android/build/walkthrough/` (gitignored) — reuse them for verified-flag injection. Walk with adb screencap + taps (login operator / DocPal2026!; Simeji IME doubles `input text` — delete duplicated chars):
1. Home → Goods Verify card → shelf list renders (11 seed shelves, box counts; `A-01-01` shows 1 box; search filters by code/zone).
2. `A-01-01` → box list renders (`SBOX-0001`, `0 / N verified`, closed badge, no last-check line).
3. `SBOX-0001` → box detail: header (box id, closed badge, shelf row), expected-items list with partNo/qty/`common_no`, Scan button on each unverified item; Mark-verified button ABSENT (not all verified).
4. Scan: verify a Scan button launches the camera activity. Physical-label scan DEFERRED (no label — same as Phases 1–3; pipeline covered by JVM tests).
5. Inject `verified=1, verified_at=<now>` for all but one part via the helper scripts → reload: verified fraction advances, per-item timestamps show, `goods_verify_last_check` + Today badge appear on the box-list card after back-navigation.
6. Inject the last part verified → box detail shows Mark box verified → tap → status `verified`, done styling, box-list card done; verify the transition log row exists (`run-as … sqlite3` on the app's db, or the Phase 3 helper technique).
7. Reopen the verified box: no Scan buttons, no Mark-verified button; empty-action state correct.
Record verified-vs-deferred honestly.

- [ ] **Step 3: Update docs** — short additions only; link to this plan rather than duplicating.

- [ ] **Step 4: Append `## Phase 5 handoff notes` to this plan**

Cover:
- What Phase 5 (measuring) reuses: `measuring_tasks` rows inserted by picking finish (Phase 2), per-box measurement columns (check `MeasuringEntities.kt` for the measuring/package entities already in the schema), the box-drill-down UI pattern from this phase, scan-to-verify packages (`matchGoodsVerify` sibling pattern), `LabelScanReviewDialog`, camera launcher.
- Known gaps inherited (carry forward, verify each still true when writing): `materializeReceivingAllocation` no production caller; `removeScannedPackage` first-source-restore bug (web + Android); seam interfaces still in `ui/receiving/ReceivingDetailViewModel.kt`; `matchMessageRes` doubles as the dialog kind discriminator; wedge `scannedQty = 0` simplification on picking; clear→in_hand never flips back; unboxed scans unreachable after clear; `ScanMatcherTest.kt:376` hardcoded seed UUID; `ShelfBoxEntity`/`PutAwayScanEntity` living in `MeasuringEntities.kt` (rename candidate); `listCandidates` N+1; T2 Enter-KeyUp blanket-consume applies to any future wedge screen.
- Phase 4 decisions to record: pglite mark-verified parity (open boxes allowed — API would 409); verify-item updates all scans of the part (API updates only unverified); no per-scan transition logs; `part_not_found_in_box` coined on Android (missing from web locales); auto-mark after last verify; `checkedToday` uses UTC dates; supplier context absent from QR parsing on this flow (multi-order boxes); no ScanFab (per-item buttons only).
- Deferred verifications from Step 2.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/app-docs/ai/feature-registry.md docs/app-docs/ai/code-map.md docs/superpowers/plans/2026-07-12-native-android-phase-4.md
git commit -m "android phase4: docs + handoff notes"
```

---

## Self-review checklist (completed during plan writing)

- [x] Spec coverage: design spec Phase 4 row — shelf list ✓ (Tasks 2, 5), boxes on shelf ✓ (Tasks 2, 6), box detail ✓ (Tasks 2, 7), scan each put-away item to verify ✓ (Tasks 3, 4, 8), close verified box ✓ (mark-verified Tasks 3, 7, 8 — "close" in the spec row maps to the web's mark-verified, which is the terminal box state; put-away already owns literal close). Exit criteria "verify flow reproducible" covered by Tasks 3/8 (repo + VM tests prove scan→verify→mark) + 9 (device walkthrough).
- [x] Web behavior sources cited per task with file:line (pglite authoritative; API divergences flagged: no cycle-count tasks, no closed-status requirement on mark-verified, verify-item updates all rows not just unverified, API put_away_scans lacks part_id — Room has it, matching pglite).
- [x] Error keys traced from `apps/web/db/goodsVerify.ts` / `useScanMatchers.ts` to the Task 1 string list, incl. the web-missing `part_not_found_in_box` (coined).
- [x] Reuse verified against the actual code: `PutAwayScanEntity.verified`/`verified_at` (`MeasuringEntities.kt:70-71`), `ShelfBoxEntity.status`, `ShelfEntity.zone` (`ReferenceEntities.kt:45-49`), `StatusBadge` box family maps `verified` (`StatusBadge.kt:62`), `TransitionLogEntity` (`AuditEntities.kt:8-24`), `LabelScanReviewDialog`/`ScanReviewUiState`, `LabelScanParser` seam, `rememberCameraScanLauncher`, fixture pattern in `PutAwayDbFixture.kt`, `StringsParityTest`, Room version 1 + destructive migration (no schema change needed).
- [x] Deliberate deviations documented: pglite-over-API semantics (3 points above); always-confirm dialog (web `confirmSingleMatch: true`) + match errors route to the dialog instead of a toast (Android precedent); no wedge/manual entry/ScanFab; no success toasts; `checkedToday` in UTC; supplier context null in QR parsing (multi-order boxes).
- [x] Type consistency: `ShelfSummary`/`VerifyBoxSummary`/`VerifyBoxItem`/`VerifyBoxDetail`, `GoodsVerifyTarget`/`GoodsVerifyMatchResult`, `GoodsVerifyShelfListSource`/`GoodsVerifyBoxListSource`/`GoodsVerifyBoxDetailSource` defined once and used consistently; route constants `GOODS_VERIFY_SHELVES`/`GOODS_VERIFY_SHELF_BOXES`/`GOODS_VERIFY_BOX` + helpers `goodsVerifyShelfBoxes`/`goodsVerifyBox` consistent across Tasks 5–7.
- [x] Every task has failing-test-first steps (except Task 1 strings — explicit parity verification), exact commands, and a commit step.
- [x] Test-count trajectory: 249 → 249 (T1) → 254 (T2) → 260 (T3) → 266 (T4) → 269 (T5) → 272 (T6) → 276 (T7) → 282 (T8) → verified at T9.

---

## Phase 5 handoff notes

Phase 4 verification (Task 9, 2026-07-13): 282 JVM tests green
(`./gradlew :app:testDebugUnitTest`, 0 failures/errors/skips across 46 test
classes), `assembleDebug` and `installDebug` clean on device
`MFM5PRE526010002`. All seven device walkthrough items were exercised — see
"Deferred verifications" below for what could not be done through adb.

### What Phase 5 (measuring) reuses

- **`measuring_tasks` rows inserted by picking finish** (Phase 2
  `PickingRepository.finish` — manual or auto when the last package is boxed).
  `MeasuringTaskEntity` (`data/db/MeasuringEntities.kt:12`): `id`,
  `pickingOrderId` (unique index), `status` default `"pending"`, `createdAt`.
  Phase 5's task list reads these directly.
- **Per-box measurement columns already in the schema** — `ShippingBoxEntity`
  (`MeasuringEntities.kt:26`): `pickingOrderId`, `measuringTaskId`, `status`
  default `"open"`, `grossWeight`, `netWeight`, `destinationCountry`,
  `boxSize`, `createdAt`. No schema change needed for the measuring flow.
- **The box drill-down UI pattern from this phase** — three-level
  list → list → detail (`ui/goodsverify/`) with per-key `provideFactory`
  (`GoodsVerifyBoxDetailViewModel.provideFactory`), `OnResumeEffect` reload,
  expandable header card with an actions slot, LazyListScope item sections
  (`GoodsVerifyItemsSection.kt`), and done-card styling (green `CardDoneColor`
  border, reused from `ui.picking`).
- **Scan-to-verify packages — the `matchGoodsVerify` sibling pattern**
  (`domain/scan/ScanMatcher.kt:167`): targets in, sealed result out
  (`Single` → review dialog, `Error` → review dialog in error state),
  `verifyItem`-style apply with inline `applyErrorKey`. Goods verify is the
  fourth `LabelScanReviewDialog` consumer; see the `matchMessageRes` gap below
  before adding a fifth.
- **`LabelScanReviewDialog` + camera launcher** —
  `rememberCameraScanLauncher` (`ui/receiving/ScanLaunchers.kt`) with the
  `LabelScanParser` seam and `provideFactory` wiring, reused unchanged.
- **Transition logs for box status transitions** — `GoodsVerifyDao.insertTransitionLog`
  shares the `@Insert` shape with `PutAwayDao.insertLog`; measuring box
  transitions (open → closed → verified) should log the same way.

### Known gaps inherited (re-verified against current code 2026-07-13)

- **`materializeReceivingAllocation` still has no production caller**
  (`domain/PickingRepository.kt:371` — definition + KDoc + DAO helper only;
  carried from Phases 2–3). If Phase 5 doesn't adopt it, delete it.
- **`removeScannedPackage` first-source-restore bug** — still present,
  still "Ported as written from the web" (`PickingRepository.kt:526-533`);
  open on both web and Android.
- **Seam interfaces still in `ui/receiving/ReceivingDetailViewModel.kt`**
  (`ReceivingDetailSource`/`MismatchSource`/`SessionSource`/`PickingSource`,
  lines 32–59). Newer phases put source interfaces next to their own ViewModel;
  goods verify followed that (`ui/goodsverify/`).
- **`matchMessageRes` doubles as the dialog kind discriminator** in
  `LabelScanReviewDialog.kt` (Apply-button visibility keyed on the message
  string resource, lines 197/202–203/230). Goods verify reused the existing
  message kinds; a measuring consumer needing new wording must add an explicit
  state-kind field to `ScanReviewUiState` first.
- **Wedge `scannedQty = 0` simplification** on picking
  (`PickingDetailViewModel.kt:505`; inherited, POC-acceptable).
- **Remove-from-box does not flip `clear` back to `in_hand`** (web parity;
  `PutAwayRepository.kt:360` comment).
- **Once an order is `clear`, its unboxed scans are unreachable in the
  put-away UI** (web parity; `PutAwayDao.inHandOrderRows` filters
  `WHERE ro.status = 'in_hand'`).
- **`ScanMatcherTest.kt:376` hardcoded seed UUID** (`ORDER_ID` companion
  constant for seeded order 04958166) — violates the "look ids up by business
  key" test convention; cosmetic.
- **`ShelfBoxEntity` / `PutAwayScanEntity` live in `MeasuringEntities.kt`**
  (`data/db/MeasuringEntities.kt:45,60`) — file-name mismatch, rename
  candidate (e.g. `BoxEntities.kt`); do it when Phase 5 next touches the file.
- **`PutAwayRepository.listCandidates` runs N+1 totals queries**
  (`PutAwayRepository.kt:50-51`; defensible at POC scale).
- **Phase 2's Enter-KeyUp blanket-consume applies to any future wedge
  screen** — keypad-Enter button activation is disabled while the hardware-key
  buffer is enabled (`ReceivingDetailScreen.kt:144`,
  `PickingDetailScreen.kt:146`); touch unaffected. If measuring adds a wedge
  entry, copy the same `onKeyEvent` guard.

### Phase 4 decisions to record

- **pglite mark-verified parity — open boxes allowed.** `markBoxVerified`
  has no closed-status check (`GoodsVerifyRepository.kt:91`); the API would
  409 (`apps/api/src/db/measure.ts:162`). Deliberate pglite-over-API choice,
  same as Phase 3.
- **verify-item updates ALL scans of the part in the box**
  (`GoodsVerifyDao.verifyScansInBoxForPart`, no `verified = 0` filter); the
  API updates only unverified rows and 404s otherwise. pglite parity.
- **No per-scan transition logs** — only the mark-verified
  `closed|open → verified` log row. Verify-item is a flag flip, not a
  transition (web pglite parity).
- **`part_not_found_in_box` coined on Android** (3 Android locales,
  `res/values*/strings.xml:464`); missing from the web locales — the web
  goods-verify matcher can't reach this state (targets are computed the same
  way), Android's box-scoped matcher can.
- **Auto-mark after the last verify** (web `onScanApplied` parity) —
  `GoodsVerifyBoxDetailViewModel.autoMarkIfReady` (`:301`) runs after a
  successful scan apply + reload; the manual header button is the other path.
- **`checkedToday` uses UTC dates** (`GoodsVerifyRepository.kt:54`,
  `LocalDate.now(ZoneOffset.UTC)`), not device-local.
- **Supplier context absent from QR parsing on this flow** — the box
  aggregates parts across receiving orders, so `parseQrCapture` gets
  `contextSupplier = null` (`GoodsVerifyBoxDetailViewModel.kt:402`).
- **No ScanFab, no wedge, no manual entry** on goods verify — scan entry is
  the per-item Scan buttons only (every button triggers the same box-level
  scan; web also has a ScanFab, noted deviation with no UX loss).
- **Always-confirm review dialog** (web `confirmSingleMatch: true`) — a
  single match does NOT auto-apply on goods verify, unlike the other three
  matchers. Match errors route to the dialog (Android precedent), not a toast.

### Phase 4 review items (recorded, no code change)

- **`GoodsVerifyDao` uses camelCase SQL column aliases** (`AS boxCount`,
  `AS shelfCode`, `AS partNo`, …) bound straight to row data classes, while
  the codebase convention elsewhere is snake_case columns + `@ColumnInfo`
  mapping on entities. Deliberate T2 choice (query row classes, not entities);
  flagged MINOR consistency inconsistency, deferred.
- **`GoodsVerifyItemsSection.kt` keeps vestigial `scanEnabled: Boolean = false`
  / `onScan: () -> Unit = {}` default parameters** deliberately, to mirror the
  sibling `PutAwayLotsSection` shape — adjudicated KEEP in the T8 review.

### Deferred verifications (from Task 9 Step 2)

Verified on device (screencap-confirmed; shots `gv1`–`gv19` in
`apps/android/build/walkthrough/`):

- Home → Goods Verify card (session persisted from Phase 3 — login as
  operator already active; greeting "Demo Operator").
- Shelf list: 11 seed shelves with box counts (`A-01-01` = 1 box, others 0),
  zone shown; search filters by code (`01-02` → only `A-01-02`).
- `A-01-01` box list: `SBOX-0001`, `0 / 156 已查貨`, closed badge, no
  last-check line. Empty box-list state on `A-01-02` (`此貨架上沒有箱號`).
- Box detail: header (box id, closed badge, expandable shelf row `A-01-01`),
  expected items with partNo/qty/`否`, Scan button per unverified item;
  Mark-verified button absent until all verified.
- Scan button launches `RectangleCameraActivity` with live preview.
- DB-injected `verified=1` for all but one part (helper
  `build/walkthrough/injectVerified.cjs`): fraction advanced to `155 / 156`,
  per-item timestamps (`2026-07-13 11:02`), `上次查貨` last-check line +
  `今日` badge on the box-list card.
- After the last-part injection: Mark box verified button appeared → tap →
  status `verified` (`已查貨`), done styling, box-list card done
  (`156 / 156`); `closed → verified` transition-log row confirmed in the
  device DB (actor = seeded operator).
- Reopened the verified box: no Scan buttons, no Mark-verified button.

Not fully exercised:

- **Physical-label camera scan** — needs a printed label; deferred (same as
  Phases 1–3). The camera activity launch itself was verified, and the
  parse → match → review-dialog → apply pipeline is covered by JVM tests
  (`GoodsVerifyBoxScanTest`). Verified flags were DB-injected rather than
  scan-applied; the mark-verified UI path itself was genuinely exercised
  against real Room state.

Device walkthrough gotcha for Phase 5: `adb push <file> /data/local/tmp/...`
from Git Bash silently mis-routes (MSYS path conversion turns the remote path
into `C:/Program Files/Git/...`; adb prints `secure_mkdirs failed` but a
misleading "1 file pushed"). Prefix the command with `MSYS_NO_PATHCONV=1`. A
`cat` from the stale temp file truncated the app DB mid-walkthrough and
triggered a Room re-seed; recovered by re-pushing the checkpointed copy.

Device state note: the walkthrough left the device DB with `SBOX-0001`
**verified** on `A-01-01` (all 265 lines verified, order `04958166` clear).
`measuring_tasks` and `shipping_boxes` are empty; all picking orders are
`pending` — Phase 5's walkthrough must first finish a picking order (or
DB-inject a `measuring_tasks` row) to get a starting state.
