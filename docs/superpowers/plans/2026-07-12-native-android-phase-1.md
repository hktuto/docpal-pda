# Native Android Rewrite — Phase 1 (Receiving) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduce the web receiving flow end-to-end on the native Android app: receiving order list (status filters, search), detail screen (items tab with mismatches + picking tab with boxes/packages), confirm arrival, automatic clear/in-hand transitions, FIFO allocation of received stock to picking orders, and scan-to-receive (camera + hardware wedge) with the review modal.

**Architecture:** Extend the Phase 0 `apps/android` module. Add a manual DI container (`AppContainer`) so ViewModels and repositories are constructor-injected and testable. Repositories hold all DB access (Room DAOs, `runInTransaction` for multi-row mutations, `withContext(Dispatchers.IO)` at the repository boundary). Complex web SQL (`allocationsCte` window-function CTE) is ported as a pure Kotlin function (`AllocationDistributor`) fed by three simple DAO queries — this keeps the logic unit-testable and avoids SQLite-version pitfalls (minSdk 24 ships SQLite 3.9, no window functions). Scan parsing (`parseManual`, QR templates, `parseAndIdentify`) and matching (`matchReceiving`) are ported as pure Kotlin with fixture tests copied verbatim from `apps/web/tests/`. UI is Jetpack Compose mirroring the web pages `apps/web/pages/receiving/index.vue` and `apps/web/pages/receiving/[id].vue`.

**Tech stack:** Kotlin, Jetpack Compose (Material 3), Room 2.7.1, DataStore, Navigation-Compose, ML Kit + CameraX scanner (already copied in Phase 0), JUnit 4 + Robolectric 4.14.1 + kotlinx-coroutines-test 1.9.0 (all test deps already in `apps/android/app/build.gradle`).

**Spec:** `docs/superpowers/specs/2026-07-12-native-android-design.md` — Phase 1 row: "Receiving (list, detail, scan-to-receive, mismatches, allocation, clear) — Web receiving flow reproducible end-to-end on device."

---

## Locked decisions (deviations from the web implementation)

1. **Allocation distribution in Kotlin, not SQL.** The web `allocationsCte` (`apps/web/db/helpers.ts`) uses `ROW_NUMBER()` / `SUM() OVER` window functions that do not exist on minSdk 24 SQLite. The identical FIFO distribution math is implemented as `AllocationDistributor.distribute(...)` (Task 2), unit-tested against hand-computed fixtures. All "available receiving qty" computations go through it.
2. **No regex normalization in SQL.** Web candidate queries use `REGEXP_REPLACE(...)` to normalize part numbers / date codes inside Postgres. SQLite has no regex replace; DAO queries return raw columns and repositories normalize in Kotlin with the ported `normalize` / `normalizeCode` functions. Result: identical matching semantics, slightly more rows transferred.
3. **`NULLS LAST` emulated.** Postgres `ORDER BY col ASC NULLS LAST` becomes `ORDER BY (col IS NULL), col ASC` in SQLite (NULLs sort first by default in SQLite ASC).
4. **`DISTINCT ON` → `GROUP BY`.** The web `getPickingOrdersByReceivingOrder` lot-allocation branch uses `DISTINCT ON (a.id)`; SQLite equivalent is `GROUP BY a.id` (each allocation id appears once per group; non-aggregated columns come from an arbitrary row of the group, same as `DISTINCT ON` with `ORDER BY a.id`).
5. **`GREATEST`/`LEAST` → Kotlin.** Only used inside the CTE, which is ported to Kotlin anyway.
6. **Picking-order-level features stay in Phase 2.** The picking tab of the receiving detail screen includes: picking order rows, create box, add-to-box, add-all, remove-from-box, remove-scan, per-item scan. It does NOT include: picking order list screen, batch issue reporting, manual finish, measuring navigation. `maybeAutoFinishPickingOrder` IS ported (it fires implicitly from box operations and must behave identically).
7. **Confirm dialogs use Compose `AlertDialog`** instead of `window.confirm`.
8. **Session access centralized** in `SessionRepository` (Phase 0 handoff note). Repositories that need an actor id take it as a parameter; ViewModels fetch it from `SessionRepository`.
9. **Timestamps are epoch millis** (`System.currentTimeMillis()`), matching the seed export and Phase 0 entities.
10. **Metadata JSON** is built with `org.json.JSONObject` (available on device and under Robolectric). Key order is not significant.

## SQLite porting rules (apply to every DAO query in this plan)

- No `REGEXP_REPLACE` → normalize in Kotlin.
- No `NULLS LAST` → `ORDER BY (col IS NULL), col`.
- No `DISTINCT ON` → `GROUP BY`.
- No window functions → compute in Kotlin.
- Boolean columns are `INTEGER 0/1` (`verified`); map to `Boolean` in Kotlin data classes manually in repository mappers (Room handles `Boolean`↔`INTEGER` automatically for entity columns).
- All multi-row mutations run inside `db.runInTransaction { }` (synchronous Room API; call sites are already off the main thread via `withContext(Dispatchers.IO)` in repositories and `offMainThread` in tests).

## Conventions (carried from Phase 0)

- Package root `com.docpal.warehousepda`; folders `data/`, `data/db/`, `domain/`, `domain/model/`, `ui/<feature>/`, `scanner/`.
- Tests under `apps/android/app/src/test/java/com/docpal/warehousepda/...` with `@RunWith(RobolectricTestRunner::class)` + `@Config(sdk = [34])` when they touch Android framework; seeded-DB tests build an in-memory database exactly like `apps/android/app/src/test/java/com/docpal/warehousepda/data/db/SeedImportTest.kt` and run queries via `offMainThread { }` from `DbTestSupport.kt`.
- Domain errors are `LocalizedException("i18n_key")` (see `domain/LocalizedException.kt`); ViewModels map the key to a string resource for display. Keys must match the web's i18n error keys exactly.
- Gradle: `cd apps/android && export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr' && export PATH="$JAVA_HOME/bin:$PATH" && ./gradlew :app:testDebugUnitTest`.
- Commit after every task: `git add <files> && git commit -m "..."`.

## File structure (new files this phase)

```
apps/android/app/src/main/java/com/docpal/warehousepda/
├── App.kt                              # Application; owns AppContainer
├── AppContainer.kt                     # manual DI: db, repositories, VM factories
├── data/
│   ├── SessionRepository.kt            # wraps SessionStore + UserDao
│   ├── db/
│   │   ├── ReceivingDao.kt             # list/detail/mismatch/available-qty queries
│   │   ├── PickingDao.kt               # picking rows, packages, boxes, allocations
│   │   ├── ScanDao.kt                  # scan candidate queries
│   │   └── AppDatabase.kt              # EDIT: register new DAOs
│   └── ReceivingRepository.kt          # list + detail assembly, confirm arrival
├── domain/
│   ├── AllocationDistributor.kt        # Kotlin port of allocationsCte FIFO math
│   ├── Allocator.kt                    # parseDateCodeRule + allocatePendingPickingOrders
│   ├── MismatchRules.kt                # computeReceivedQty + validateMismatchInputs
│   ├── MismatchRepository.kt           # report/edit/confirm/cancel + clear/in-hand
│   ├── PickingRepository.kt            # scanAllocationToPackage, box ops, applyOcrPick
│   ├── scan/
│   │   ├── ScanPrimitives.kt           # normalize, normalizeCode, collapseSpaces, parseManual
│   │   ├── QrParser.kt                 # decodeKoaQty, parseQrCapture
│   │   ├── OcrLabelParser.kt           # parseAndIdentify port
│   │   ├── ScanMatcher.kt              # matchReceiving port
│   │   └── HardwareKeyBuffer.kt        # hardware scanner wedge buffering
│   └── model/                          # ReceivingOrderSummary, ReceivingOrderDetail, etc.
├── ui/
│   ├── LocaleManager.kt                # EDIT: add applyAndRecreate helper
│   ├── components/
│   │   ├── StatusBadge.kt              # badgeClass + statusLabel helpers
│   │   ├── DetailRow.kt                # label/value row used on detail pages
│   │   ├── EmptyState.kt
│   │   └── ErrorText.kt                # errorKey -> localized message (params substitution)
│   ├── receiving/
│   │   ├── ReceivingListScreen.kt + ReceivingListViewModel.kt
│   │   ├── ReceivingDetailScreen.kt + ReceivingDetailViewModel.kt
│   │   ├── ReportIssueDialog.kt
│   │   ├── LabelScanReviewDialog.kt    # review + manual modes, CandidateChips
│   │   └── ScanLaunchers.kt            # ActivityResultLauncher wrapper + CAMERA permission
│   ├── home/HomeScreen.kt              # EDIT: receiving card navigates
│   └── navigation/AppNav.kt            # EDIT: receiving routes
└── res/values*/strings.xml             # EDIT: receiving/scan/status/error strings ×3 locales

apps/android/app/src/test/java/com/docpal/warehousepda/
├── domain/
│   ├── AllocationDistributorTest.kt
│   ├── AllocatorTest.kt
│   ├── MismatchRulesTest.kt
│   ├── MismatchRepositoryTest.kt
│   ├── PickingRepositoryTest.kt       # applyOcrPick + box ops, seeded DB
│   ├── ReceivingRepositoryTest.kt     # list + detail + confirm arrival, seeded DB
│   └── scan/
│       ├── ScanPrimitivesTest.kt
│       ├── QrParserTest.kt
│       ├── OcrLabelParserTest.kt
│       ├── ScanMatcherTest.kt
│       └── HardwareKeyBufferTest.kt
└── ui/receiving/ReceivingListViewModelTest.kt
```

Reference web sources (read-only, do not modify `apps/web`):

| Android artifact | Web source of truth |
|---|---|
| `AllocationDistributor` | `apps/web/db/helpers.ts` (`allocationsCte`) |
| `MismatchRules`, `MismatchRepository` | `apps/web/db/mismatch.ts` |
| `Allocator` | `apps/web/db/allocate.ts` |
| `ReceivingRepository` queries | `apps/web/services/adapters/pgliteWarehouse.ts` (`getReceivingOrders`, `getReceivingOrder`) + `apps/web/db/receiving.ts` |
| `PickingRepository` | `apps/web/db/picking.ts` + `apps/web/db/ocrPicking.ts` |
| `ScanPrimitives`, `QrParser` | `apps/web/composables/useMockOcr.ts` |
| `OcrLabelParser` | `apps/web/utils/parseOcrScan.ts` |
| `ScanMatcher` | `apps/web/composables/useScanMatchers.ts` |
| `HardwareKeyBuffer` | `apps/web/composables/useHardwareScanner.ts` |
| Receiving UI | `apps/web/pages/receiving/index.vue`, `apps/web/pages/receiving/[id].vue`, `apps/web/components/receiving/`, `apps/web/components/LabelScanReviewModal.vue` |
| String values | `apps/web/i18n/locales/{en-US,zh-CN,zh-HK}.ts` |
| Test fixtures | `apps/web/tests/{parseOcrScan,useLabelScan,scanMatchers,useHardwareScanner}.test.ts` |

---

## Task 1: DI seam — AppContainer, SessionRepository, ViewModel refactor

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/App.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/AppContainer.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/data/SessionRepository.kt`
- Modify: `apps/android/app/src/main/AndroidManifest.xml` (register `App`)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/login/LoginViewModel.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/home/HomeViewModel.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/login/LoginScreen.kt`, `.../ui/home/HomeScreen.kt` (use factory)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/data/SessionRepositoryTest.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/ui/login/LoginViewModelTest.kt`

Phase 0's `LoginViewModel`/`HomeViewModel` reach into `AppDatabase.getInstance(context)` and duplicate the "stored user id → load user → clear on stale" logic. Centralize before the receiving screens add a third copy.

- [ ] **Step 1: Write the failing SessionRepository test**

`apps/android/app/src/test/java/com/docpal/warehousepda/data/SessionRepositoryTest.kt`:

```kotlin
package com.docpal.warehousepda.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.offMainThread
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SessionRepositoryTest {

    private lateinit var db: AppDatabase
    private lateinit var repo: SessionRepository

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        // seed.sql is applied by AppDatabase's SeedCallback via assets.
        repo = SessionRepository(SessionStore(context), db.userDao())
        offMainThread { repo.logout() }
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `currentUser returns seeded operator after login id stored`() = offMainThread {
        val operator = db.userDao().findByUsername("operator")!!
        repo.setLoggedInUserId(operator.id)
        val user = repo.currentUser()
        assertEquals("operator", user?.username)
    }

    @Test
    fun `currentUser clears stale stored id and returns null`() = offMainThread {
        repo.setLoggedInUserId("does-not-exist")
        assertNull(repo.currentUser())
        assertNull(repo.storedUserId())
    }

    @Test
    fun `logout clears stored id`() = offMainThread {
        val operator = db.userDao().findByUsername("operator")!!
        repo.setLoggedInUserId(operator.id)
        repo.logout()
        assertNull(repo.currentUser())
    }
}
```

Note: if `SessionStore` in `data/SessionStore.kt` does not yet expose suspend vs blocking functions, match its existing API — the repository mirrors it. Check `SessionStore.kt` first and adapt the test's call names to what exists.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/android && export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr' && export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:testDebugUnitTest --tests "*SessionRepositoryTest"
```

Expected: FAIL — `SessionRepository` does not exist (compile error).

- [ ] **Step 3: Write SessionRepository**

`apps/android/app/src/main/java/com/docpal/warehousepda/data/SessionRepository.kt`:

```kotlin
package com.docpal.warehousepda.data

import com.docpal.warehousepda.data.db.UserDao
import com.docpal.warehousepda.domain.model.User

/**
 * Single source of truth for the signed-in user.
 *
 * Wraps [SessionStore] (DataStore-backed user id) and [UserDao]. A stored id
 * that no longer resolves to a user row (e.g. after a destructive migration)
 * is cleared on read so callers never see a dangling session.
 */
class SessionRepository(
    private val sessionStore: SessionStore,
    private val userDao: UserDao,
) {

    /** Blocking read — call from a background thread (repositories do this inside Dispatchers.IO). */
    fun currentUser(): User? {
        val id = sessionStore.userIdBlocking() ?: return null
        val entity = userDao.findById(id)
        if (entity == null) {
            sessionStore.clearBlocking()
            return null
        }
        return User(
            id = entity.id,
            username = entity.username,
            displayName = entity.displayName,
            role = entity.role,
        )
    }

    /** Blocking read of the raw stored id (test support + edge cases). */
    fun storedUserId(): String? = sessionStore.userIdBlocking()

    fun setLoggedInUserId(id: String) = sessionStore.setUserIdBlocking(id)

    fun logout() = sessionStore.clearBlocking()
}
```

If `SessionStore` currently exposes only `suspend`/`Flow` APIs, add the three blocking wrappers to `SessionStore` using `runBlocking { }` internally (documented as "blocking bridge for repository-layer synchronous style; ViewModels must not call these on the main thread" — repositories call them from `Dispatchers.IO`). Read `data/SessionStore.kt` and `domain/model/User.kt` first and match field names exactly; adjust the constructor signature above to the real `User` model.

- [ ] **Step 4: Run SessionRepository test — verify PASS**

```bash
./gradlew :app:testDebugUnitTest --tests "*SessionRepositoryTest"
```

- [ ] **Step 5: Write the failing LoginViewModel test**

`apps/android/app/src/test/java/com/docpal/warehousepda/ui/login/LoginViewModelTest.kt`:

```kotlin
package com.docpal.warehousepda.ui.login

import com.docpal.warehousepda.domain.AuthRepository
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.User
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class LoginViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    private class FakeAuthRepository : AuthRepository {
        var nextUser: User? = User("u1", "operator", "Operator", "operator")
        var nextError: LocalizedException? = null
        var lastUsername: String? = null
        var lastPassword: String? = null

        override fun login(username: String, password: String): User {
            lastUsername = username
            lastPassword = password
            nextError?.let { throw it }
            return nextUser ?: throw LocalizedException("invalid_username_or_password")
        }
    }

    @Before
    fun setUp() = Dispatchers.setMain(dispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `login success exposes user and clears error`() = runTest {
        val auth = FakeAuthRepository()
        val vm = LoginViewModel(auth)
        vm.login("operator", "DocPal2026!")
        advanceUntilIdle()
        val state = vm.uiState.value
        assertTrue(state.loggedIn)
        assertEquals("operator", auth.lastUsername)
        assertFalse(state.loading)
        assertEquals(null, state.errorKey)
    }

    @Test
    fun `login failure exposes error key`() = runTest {
        val auth = FakeAuthRepository().apply { nextError = LocalizedException("invalid_username_or_password") }
        val vm = LoginViewModel(auth)
        vm.login("operator", "wrong")
        advanceUntilIdle()
        val state = vm.uiState.value
        assertFalse(state.loggedIn)
        assertEquals("invalid_username_or_password", state.errorKey)
    }
}
```

`AuthRepository` must become an interface for this fake to work — see Step 6. If the existing `LoginViewModel.uiState` field names differ (`loggedIn` vs `user` etc.), keep the existing names and adapt the test; the behavioral assertions (success path, error-key path) are the contract.

- [ ] **Step 6: Refactor AuthRepository to an interface + refactor ViewModels to constructor injection**

First, extend `domain/LocalizedException.kt` to carry optional interpolation params (needed by `receiving_order_already_status {status}` and `unhandled_mismatch_reason {reason}` in later tasks):

```kotlin
class LocalizedException(
    val code: String,
    val params: Map<String, String> = emptyMap(),
) : Exception(code)
```

Additive change — existing single-argument call sites keep compiling.

In `domain/AuthRepository.kt`: extract `interface AuthRepository { fun login(username: String, password: String): User }` and rename the existing implementation to `class DefaultAuthRepository(private val userDao: UserDao, private val sessionRepository: SessionRepository) : AuthRepository` (it stores the user id via `SessionRepository` after a successful login — move the `SessionStore` write out of the ViewModel if Phase 0 had it there). Keep the plain-text password comparison and `LocalizedException("invalid_username_or_password")` behavior unchanged.

`LoginViewModel(authRepository: AuthRepository)` and `HomeViewModel(sessionRepository: SessionRepository)` take constructor parameters; no `Context` lookups inside ViewModels. `HomeViewModel.logout()` calls `sessionRepository.logout()` then sets `loggedOut = true`.

- [ ] **Step 7: AppContainer + App + factories**

`apps/android/app/src/main/java/com/docpal/warehousepda/AppContainer.kt`:

```kotlin
package com.docpal.warehousepda

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.docpal.warehousepda.data.SessionRepository
import com.docpal.warehousepda.data.SessionStore
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.AuthRepository
import com.docpal.warehousepda.domain.DefaultAuthRepository
import com.docpal.warehousepda.ui.home.HomeViewModel
import com.docpal.warehousepda.ui.login.LoginViewModel

/** Manual DI container. Created once in [App]; Compose screens obtain ViewModels via [viewModelFactory]. */
class AppContainer(context: Context) {

    val db: AppDatabase = AppDatabase.getInstance(context)

    val sessionRepository: SessionRepository by lazy {
        SessionRepository(SessionStore(context), db.userDao())
    }

    val authRepository: AuthRepository by lazy {
        DefaultAuthRepository(db.userDao(), sessionRepository)
    }

    @Suppress("UNCHECKED_CAST")
    val viewModelFactory: ViewModelProvider.Factory = object : ViewModelProvider.Factory {
        override fun <T : ViewModel> create(modelClass: Class<T>): T = when {
            modelClass.isAssignableFrom(LoginViewModel::class.java) -> LoginViewModel(authRepository) as T
            modelClass.isAssignableFrom(HomeViewModel::class.java) -> HomeViewModel(sessionRepository) as T
            else -> throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
        }
    }
}
```

`apps/android/app/src/main/java/com/docpal/warehousepda/App.kt`:

```kotlin
package com.docpal.warehousepda

import android.app.Application

class App : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
```

Manifest: add `android:name=".App"` to the `<application>` element.

In `LoginScreen.kt` and `HomeScreen.kt`, replace `viewModel()` with:

```kotlin
val app = LocalContext.current.applicationContext as App
val viewModel: LoginViewModel = viewModel(factory = app.container.viewModelFactory)
```

- [ ] **Step 8: Run all tests — verify PASS (existing tests must stay green)**

```bash
./gradlew :app:testDebugUnitTest
```

Expected: PASS — SessionRepositoryTest, LoginViewModelTest, plus all Phase 0 tests (AuthRepositoryTest may need its constructor call updated to `DefaultAuthRepository`; fix mechanically, do not change assertions).

- [ ] **Step 9: Commit**

```bash
git add apps/android && git commit -m "android phase1: DI container, SessionRepository, VM constructor injection"
```

---

## Task 2: AllocationDistributor — Kotlin port of `allocationsCte`

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/AllocationDistributor.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/AllocationDistributorTest.kt`

Source of truth: `apps/web/db/helpers.ts`. The CTE distributes each `(receiving_order_id, part_id)` allocation total across that part's invoice items in FIFO order (`delivery_date ASC NULLS LAST, invoice_no ASC, date_code ASC NULLS LAST`): an item absorbs `max(0, min(gross, totalAllocated - (cumulativeGrossBeforeThisItem)))`. Unboxed put-away scans reserve per item directly.

- [ ] **Step 1: Write the failing test**

`apps/android/app/src/test/java/com/docpal/warehousepda/domain/AllocationDistributorTest.kt`:

```kotlin
package com.docpal.warehousepda.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class AllocationDistributorTest {

    private fun item(id: String, partId: String, orderId: String, gross: Int, sortKey: Int) =
        AllocationDistributor.InvoiceItemRow(
            id = id, partId = partId, receivingOrderId = orderId, grossQty = gross,
            deliveryDate = sortKey.toLong(), invoiceNo = "INV", dateCode = sortKey.toString(),
        )

    @Test
    fun `allocation fills items in FIFO order`() {
        val items = listOf(
            item("a", "p1", "o1", gross = 100, sortKey = 1),
            item("b", "p1", "o1", gross = 100, sortKey = 2),
            item("c", "p1", "o1", gross = 100, sortKey = 3),
        )
        val totals = mapOf(("o1" to "p1") to 150)
        val result = AllocationDistributor.distribute(items, totals, emptyMap())
        assertEquals(100, result["a"]!!.allocatedQty)
        assertEquals(50, result["b"]!!.allocatedQty)
        assertEquals(0, result["c"]!!.allocatedQty)
    }

    @Test
    fun `allocation larger than stock clamps at gross per item`() {
        val items = listOf(
            item("a", "p1", "o1", gross = 60, sortKey = 1),
            item("b", "p1", "o1", gross = 40, sortKey = 2),
        )
        val result = AllocationDistributor.distribute(items, mapOf(("o1" to "p1") to 999), emptyMap())
        assertEquals(60, result["a"]!!.allocatedQty)
        assertEquals(40, result["b"]!!.allocatedQty)
    }

    @Test
    fun `parts and orders are independent partitions`() {
        val items = listOf(
            item("a", "p1", "o1", gross = 10, sortKey = 1),
            item("b", "p2", "o1", gross = 10, sortKey = 2),
            item("c", "p1", "o2", gross = 10, sortKey = 1),
        )
        val totals = mapOf(("o1" to "p1") to 5, ("o1" to "p2") to 7, ("o2" to "p1") to 3)
        val result = AllocationDistributor.distribute(items, totals, emptyMap())
        assertEquals(5, result["a"]!!.allocatedQty)
        assertEquals(7, result["b"]!!.allocatedQty)
        assertEquals(3, result["c"]!!.allocatedQty)
    }

    @Test
    fun `unboxed scans reserve per item and available subtracts both`() {
        val items = listOf(
            item("a", "p1", "o1", gross = 100, sortKey = 1),
            item("b", "p1", "o1", gross = 100, sortKey = 2),
        )
        val unboxed = mapOf("b" to 30)
        val result = AllocationDistributor.distribute(items, mapOf(("o1" to "p1") to 50), unboxed)
        assertEquals(50, result["a"]!!.availableQty)   // 100 - 50 alloc
        assertEquals(20, result["b"]!!.availableQty)   // 100 - 0 alloc - 30 unboxed
    }

    @Test
    fun `excluded picking item is omitted from allocation totals`() {
        val items = listOf(item("a", "p1", "o1", gross = 100, sortKey = 1))
        // totals map is pre-filtered by the caller; excluding means the key is absent.
        val result = AllocationDistributor.distribute(items, emptyMap(), emptyMap())
        assertEquals(100, result["a"]!!.availableQty)
    }

    @Test
    fun `null delivery date and null date code sort last`() {
        val nullDate = AllocationDistributor.InvoiceItemRow(
            id = "n", partId = "p1", receivingOrderId = "o1", grossQty = 10,
            deliveryDate = null, invoiceNo = "INV", dateCode = null,
        )
        val early = item("e", "p1", "o1", gross = 10, sortKey = 5)
        val result = AllocationDistributor.distribute(
            listOf(nullDate, early), mapOf(("o1" to "p1") to 10), emptyMap()
        )
        assertEquals(10, result["e"]!!.allocatedQty)
        assertEquals(0, result["n"]!!.allocatedQty)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./gradlew :app:testDebugUnitTest --tests "*AllocationDistributorTest"
```

Expected: FAIL — class does not exist.

- [ ] **Step 3: Write AllocationDistributor**

`apps/android/app/src/main/java/com/docpal/warehousepda/domain/AllocationDistributor.kt`:

```kotlin
package com.docpal.warehousepda.domain

/**
 * Kotlin port of the web `allocationsCte` (apps/web/db/helpers.ts).
 *
 * Order-level allocations (receiving_order_id + part via the picking item) are
 * distributed across that part's invoice items in FIFO order:
 *   delivery_date ASC NULLS LAST, invoice_no ASC, date_code ASC NULLS LAST.
 * Each item absorbs max(0, min(gross, total - consumedByEarlierItems)).
 * Unboxed put-away scans reserve per item directly (no distribution).
 *
 * The Postgres original uses window functions; this port exists because
 * minSdk 24 ships SQLite 3.9 without them (plan, locked decision 1).
 */
object AllocationDistributor {

    data class InvoiceItemRow(
        val id: String,
        val partId: String,
        val receivingOrderId: String,
        /** received_qty - picked_qty - put_away_qty */
        val grossQty: Int,
        /** Epoch millis; null sorts last (Postgres NULLS LAST). */
        val deliveryDate: Long?,
        val invoiceNo: String,
        /** Compared lexicographically; null sorts last. */
        val dateCode: String?,
    )

    data class ItemAvailability(
        val allocatedQty: Int,
        val unboxedScannedQty: Int,
        val availableQty: Int,
    )

    /**
     * @param items        all invoice item rows to reserve against (any order; sorted internally)
     * @param allocationTotals  (receivingOrderId, partId) -> total allocated qty (pre-filtered for exclusions)
     * @param unboxedByItem     receiving_invoice_item_id -> unboxed put-away scan qty
     * @return receiving_invoice_item_id -> availability breakdown
     */
    fun distribute(
        items: List<InvoiceItemRow>,
        allocationTotals: Map<Pair<String, String>, Int>,
        unboxedByItem: Map<String, Int>,
    ): Map<String, ItemAvailability> {
        val result = HashMap<String, ItemAvailability>(items.size)
        val byPartition = items.groupBy { it.receivingOrderId to it.partId }
        for ((key, partitionItems) in byPartition) {
            val total = allocationTotals[key] ?: 0
            val sorted = partitionItems.sortedWith(
                compareBy(
                    { it.deliveryDate == null },   // NULLS LAST
                    { it.deliveryDate ?: 0L },
                    { it.invoiceNo },
                    { it.dateCode == null },        // NULLS LAST
                    { it.dateCode ?: "" },
                )
            )
            var consumed = 0
            for (row in sorted) {
                val allocated = maxOf(0, minOf(row.grossQty, total - consumed))
                consumed += row.grossQty
                val unboxed = unboxedByItem[row.id] ?: 0
                result[row.id] = ItemAvailability(
                    allocatedQty = allocated,
                    unboxedScannedQty = unboxed,
                    availableQty = row.grossQty - allocated - unboxed,
                )
            }
        }
        return result
    }
}

- [ ] **Step 4: Run test — verify PASS**

```bash
./gradlew :app:testDebugUnitTest --tests "*AllocationDistributorTest"
```

- [ ] **Step 5: Commit**

```bash
git add apps/android && git commit -m "android phase1: AllocationDistributor (allocationsCte Kotlin port)"
```

---

## Task 3: ReceivingDao + ReceivingRepository — list, detail, clear/in-hand

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/ReceivingDao.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/model/ReceivingModels.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/data/ReceivingRepository.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/AppDatabase.kt` (register DAO)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/AppContainer.kt` (provide repository)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/data/ReceivingRepositoryTest.kt`

Source of truth: `apps/web/services/adapters/pgliteWarehouse.ts` (`getReceivingOrders` line 844, `getReceivingOrder` line 908), `apps/web/db/receiving.ts` (`tryMarkReceivingOrderClear`/`tryMarkReceivingOrderInHand`), `apps/web/db/picking.ts` (`getPickingOrdersByReceivingOrder` line 984, `getPickingItemTransitionLogs` line 919).

- [ ] **Step 1: Write the failing repository test**

`apps/android/app/src/test/java/com/docpal/warehousepda/data/ReceivingRepositoryTest.kt` — seeded in-memory DB (copy the setup pattern from `apps/android/app/src/test/java/com/docpal/warehousepda/data/db/SeedImportTest.kt`: `AppDatabase.build(context, inMemory = true)` applies the seed callback). Cover these behaviors; pick concrete expectations by first running the seed through the web app or by inspecting `apps/android/app/src/main/assets/seed.sql` (do not guess ids — read the seed file):

```kotlin
package com.docpal.warehousepda.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.offMainThread
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReceivingRepositoryTest {

    private lateinit var db: AppDatabase
    private lateinit var repo: ReceivingRepository

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
        repo = ReceivingRepository(db)
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `list in_hand orders sorted by delivery date with remaining counts`() = runBlocking {
        val orders = repo.listOrders("in_hand")
        assertTrue(orders.isNotEmpty())
        assertTrue(orders.all { it.status == "in_hand" })
        val dates = orders.map { it.deliveryDate }
        assertEquals(dates.sortedWith(nullsLast()), dates)
        // pick the first seeded in_hand order from seed.sql and assert its
        // remainingItems equals the count of its items with available > 0.
    }

    @Test
    fun `list filters by status`() = runBlocking {
        assertTrue(repo.listOrders("pending").all { it.status == "pending" })
        assertTrue(repo.listOrders("clear").all { it.status == "clear" })
        val all = repo.listOrders("all")
        assertEquals(
            repo.listOrders("pending").size + repo.listOrders("in_hand").size + repo.listOrders("clear").size,
            all.size,
        )
    }

    @Test
    fun `detail assembles invoices, mismatches, allocatedByItem, picking rows, packages, boxes`() = runBlocking {
        // Use a seeded in_hand order id that has picking allocations (find it in seed.sql).
        val detail = repo.getOrderDetail(SEEDED_IN_HAND_ORDER_ID)
        assertEquals(SEEDED_IN_HAND_ORDER_ID, detail.id)
        assertTrue(detail.invoices.isNotEmpty())
        assertTrue(detail.pickingRows.isNotEmpty())
        // allocatedByItem totals match AllocationDistributor output for the same inputs.
    }

    @Test
    fun `tryMarkClear flips in_hand order to clear when fully consumed, and back`() = runBlocking {
        // Find a seeded order whose every item has available <= 0 (or construct one
        // by inserting rows). Call repo.tryMarkClear(orderId, "tester") then
        // assert status == "clear" and a transition log row exists with to_state = "clear".
        // Then insert availability (e.g. report+cancel a mismatch is Task 5; here
        // directly update an item) and call repo.tryMarkInHand — assert status returns.
    }
}
```

Define `nullsLast()` helper in the test file:

```kotlin
private fun <T : Comparable<T>> nullsLast() = compareBy<T?> { it == null }.thenBy { it }
```

Replace `SEEDED_IN_HAND_ORDER_ID` and count expectations with real values from `apps/android/app/src/main/assets/seed.sql` (grep for `INSERT INTO receiving_orders`; pick an in_hand order that has picking allocations so the picking-rows assertion is meaningful). If no seeded order exercises a case (e.g. fully-consumed in_hand order for tryMarkClear), insert the needed rows in the test via `db.openHelper.writableDatabase.execSQL(...)` inside `offMainThread { }` — mirror the seed INSERT style.

- [ ] **Step 2: Run test to verify it fails**

```bash
./gradlew :app:testDebugUnitTest --tests "*ReceivingRepositoryTest"
```

Expected: FAIL — `ReceivingRepository` does not exist.

- [ ] **Step 3: Write the models**

`apps/android/app/src/main/java/com/docpal/warehousepda/domain/model/ReceivingModels.kt`:

```kotlin
package com.docpal.warehousepda.domain.model

data class ReceivingOrderSummary(
    val id: String,
    val refNo: String,
    val status: String,
    val deliveryDate: Long?,
    val supplierName: String?,
    val remainingItems: Int,
    val pendingPickingOrders: Int,
)

data class MismatchInfo(
    val id: String,
    val reason: String,
    val mismatchQty: Int?,
    val wrongPartNo: String?,
    val note: String?,
    val status: String,
    val effectiveReceivedQty: Int,
    val previousReceivedQty: Int,
    val reportedBy: String?,
    val reportedAt: Long,
)

data class ReceivingItemDetail(
    val id: String,
    val partId: String,
    val partNo: String,
    val poNo: String?,
    val poLine: String?,
    val qty: Int,
    val receivedQty: Int,
    val pickedQty: Int,
    val putAwayQty: Int,
    val boxId: String?,
    val dateCode: String?,
    val lotCode: String?,
    val coo: String?,
    val cow: String?,
    val allocatedQty: Int,       // from AllocationDistributor
    val mismatch: MismatchInfo?,
) {
    val availableQty: Int get() = receivedQty - pickedQty - putAwayQty - allocatedQty
}

data class ReceivingInvoiceDetail(
    val id: String,
    val invoiceNo: String,
    val items: List<ReceivingItemDetail>,
)

data class PickingByReceivingRow(
    val pickingOrderId: String,
    val pickingOrderRef: String,
    val pickingOrderStatus: String,
    val pickingOrderShipTo: String?,
    val pickingItemId: String,
    val requiredQty: Int,
    val pickedQty: Int,
    val scannedQty: Int,
    val boxedQty: Int,
    val partId: String,
    val partNo: String,
    val shelfCode: String?,
    val boxId: String?,
    val dateCode: String?,
    val lotCode: String?,
    val coo: String?,
    val cow: String?,
    val allocatedQty: Int,
    val allocationId: String,
)

data class DisplayPackage(
    val id: String,
    val pickingItemId: String,
    val pickingOrderId: String,
    val qty: Int,
    val shippingBoxId: String?,
    val dateCode: String?,
    val lotCode: String?,
    val coo: String?,
    val cow: String?,
    val createdAt: Long,
)

data class DisplayBox(
    val id: String,
    val pickingOrderId: String?,
    val status: String,
)

data class PickingItemLog(
    val id: String,
    val entityId: String,
    val fromState: String?,
    val toState: String,
    val metadata: String?,
    val createdAt: Long,
    val actorName: String?,
)

data class ReceivingOrderDetail(
    val id: String,
    val refNo: String,
    val status: String,
    val deliveryDate: Long?,
    val supplierName: String?,
    val invoices: List<ReceivingInvoiceDetail>,
    val remainingItems: Int,
    val pickingRows: List<PickingByReceivingRow>,
    val packagesByItem: Map<String, List<DisplayPackage>>,
    val boxesByOrder: Map<String, List<DisplayBox>>,
    val transitionLogs: Map<String, List<PickingItemLog>>,
)
```

- [ ] **Step 4: Write ReceivingDao**

`apps/android/app/src/main/java/com/docpal/warehousepda/data/db/ReceivingDao.kt`. Raw-row data classes live at the bottom of the file. Note the SQLite porting rules (no `REGEXP_REPLACE`, `(col IS NULL)` for NULLS LAST, `GROUP BY` for DISTINCT ON):

```kotlin
package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query

@Dao
interface ReceivingDao {

    @Query(
        """
        SELECT ro.id, ro.ref_no, ro.status, ro.delivery_date, s.name AS supplier_name,
               ri.invoice_no, rii.id AS item_id, rii.part_id, rii.date_code,
               (rii.received_qty - rii.picked_qty - rii.put_away_qty) AS gross_qty
        FROM receiving_orders ro
        LEFT JOIN suppliers s ON s.id = ro.supplier_id
        LEFT JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
        LEFT JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        WHERE (:filter = 'all')
           OR (:filter = 'pending' AND ro.status = 'pending')
           OR (:filter = 'in_hand' AND ro.status = 'in_hand')
           OR (:filter = 'clear' AND ro.status = 'clear')
        ORDER BY (ro.delivery_date IS NULL), ro.delivery_date, ri.invoice_no, rii.id
        """
    )
    fun listOrderRows(filter: String): List<OrderItemFlatRow>

    @Query(
        """
        SELECT a.receiving_order_id, pi.part_id, COALESCE(SUM(a.qty), 0) AS total_qty
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE a.receiving_order_id IS NOT NULL
        GROUP BY a.receiving_order_id, pi.part_id
        """
    )
    fun orderAllocationTotals(): List<OrderAllocationTotalRow>

    @Query(
        """
        SELECT pas.receiving_invoice_item_id AS item_id, COALESCE(SUM(pas.qty), 0) AS qty
        FROM put_away_scans pas
        WHERE pas.shelf_box_id IS NULL AND pas.receiving_invoice_item_id IS NOT NULL
        GROUP BY pas.receiving_invoice_item_id
        """
    )
    fun unboxedPutAwayScanTotals(): List<ItemQtyRow>

    /** Distinct pending/picking picking-order ids linked to each receiving order (two link paths, deduped in Kotlin). */
    @Query(
        """
        SELECT a.receiving_order_id AS receiving_order_id, po.id AS picking_order_id
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        JOIN picking_orders po ON po.id = pi.picking_order_id
        WHERE a.receiving_order_id IS NOT NULL AND a.qty > 0
          AND po.status IN ('pending', 'picking')
        UNION ALL
        SELECT ri2.receiving_order_id AS receiving_order_id, po.id AS picking_order_id
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        JOIN picking_orders po ON po.id = pi.picking_order_id
        JOIN inventory_lots il ON il.id = a.inventory_lot_id
        JOIN inventory_lot_sources ils ON ils.inventory_lot_id = il.id
        JOIN receiving_invoice_items rii2 ON rii2.id = ils.receiving_invoice_item_id
        JOIN receiving_invoices ri2 ON ri2.id = rii2.receiving_invoice_id
        WHERE a.qty > 0 AND po.status IN ('pending', 'picking')
        """
    )
    fun pendingPickingOrderLinks(): List<OrderPickingLinkRow>

    @Query("SELECT * FROM receiving_orders WHERE id = :id")
    fun orderById(id: String): ReceivingOrderEntity?

    @Query("SELECT name FROM suppliers WHERE id = :id")
    fun supplierName(id: String): String?

    @Query(
        """
        SELECT ri.id AS invoice_id, ri.invoice_no,
               rii.id AS item_id, rii.part_id, p.part_no, rii.po_no, rii.po_line,
               rii.qty, rii.received_qty, rii.picked_qty, rii.put_away_qty,
               rii.box_id, rii.date_code, rii.lot_code, rii.coo, rii.cow
        FROM receiving_invoices ri
        JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        JOIN parts p ON p.id = rii.part_id
        WHERE ri.receiving_order_id = :orderId
        ORDER BY ri.invoice_no, rii.id
        """
    )
    fun detailItemRows(orderId: String): List<DetailItemFlatRow>

    @Query(
        """
        SELECT * FROM receiving_item_mismatches
        WHERE receiving_invoice_item_id IN (:itemIds) AND status != 'cancelled'
        ORDER BY reported_at DESC
        """
    )
    fun activeMismatches(itemIds: List<String>): List<ReceivingItemMismatchEntity>

    /** Port of web getPickingOrdersByReceivingOrder; DISTINCT ON (a.id) → GROUP BY a.id. */
    @Query(
        """
        WITH lot_allocations AS (
          SELECT
            po.id AS picking_order_id, po.ref_no AS picking_order_ref,
            po.status AS picking_order_status, po.ship_to AS picking_order_ship_to,
            pi.id AS picking_item_id, pi.qty AS required_qty, pi.picked_qty,
            p.id AS part_id, p.part_no,
            il.shelf_code, il.box_id, il.date_code, il.lot_code, il.coo, il.cow,
            a.qty AS allocated_qty, a.id AS allocation_id
          FROM receiving_orders ro
          JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
          JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
          JOIN inventory_lot_sources ils ON ils.receiving_invoice_item_id = rii.id
          JOIN inventory_lots il ON il.id = ils.inventory_lot_id
          JOIN allocations a ON a.inventory_lot_id = il.id
          JOIN picking_items pi ON pi.id = a.picking_item_id
          JOIN picking_orders po ON po.id = pi.picking_order_id
          JOIN parts p ON p.id = pi.part_id
          WHERE ro.id = :receivingOrderId
          GROUP BY a.id
        ),
        invoice_allocations AS (
          SELECT
            po.id AS picking_order_id, po.ref_no AS picking_order_ref,
            po.status AS picking_order_status, po.ship_to AS picking_order_ship_to,
            pi.id AS picking_item_id, pi.qty AS required_qty, pi.picked_qty,
            p.id AS part_id, p.part_no,
            NULL AS shelf_code, NULL AS box_id, NULL AS date_code, NULL AS lot_code,
            NULL AS coo, NULL AS cow,
            a.qty AS allocated_qty, a.id AS allocation_id
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          JOIN picking_orders po ON po.id = pi.picking_order_id
          JOIN parts p ON p.id = pi.part_id
          WHERE a.receiving_order_id = :receivingOrderId
        ),
        combined AS (
          SELECT * FROM lot_allocations
          UNION ALL
          SELECT * FROM invoice_allocations
        ),
        package_totals AS (
          SELECT picking_item_id,
                 COALESCE(SUM(CASE WHEN shipping_box_id IS NULL THEN qty ELSE 0 END), 0) AS scanned_qty,
                 COALESCE(SUM(CASE WHEN shipping_box_id IS NOT NULL THEN qty ELSE 0 END), 0) AS boxed_qty
          FROM picking_packages
          GROUP BY picking_item_id
        )
        SELECT c.*, COALESCE(pt.scanned_qty, 0) AS scanned_qty,
               COALESCE(pt.boxed_qty, 0) AS boxed_qty
        FROM combined c
        LEFT JOIN package_totals pt ON pt.picking_item_id = c.picking_item_id
        ORDER BY c.picking_order_ref, c.part_no
        """
    )
    fun pickingRowsByReceivingOrder(receivingOrderId: String): List<PickingRowFlat>

    @Query(
        """
        SELECT * FROM picking_packages
        WHERE picking_item_id IN (:itemIds)
        ORDER BY created_at
        """
    )
    fun packagesByItemIds(itemIds: List<String>): List<PickingPackageEntity>

    @Query(
        """
        SELECT id, picking_order_id, status FROM shipping_boxes
        WHERE picking_order_id IN (:orderIds)
        ORDER BY id
        """
    )
    fun boxesByOrderIds(orderIds: List<String>): List<BoxFlatRow>

    @Query(
        """
        SELECT tl.id, tl.entity_id, tl.from_state, tl.to_state, tl.metadata,
               tl.created_at, u.display_name AS actor_name
        FROM transition_logs tl
        LEFT JOIN users u ON u.id = tl.actor_id
        WHERE tl.entity_type = 'picking_item' AND tl.entity_id IN (:itemIds)
        ORDER BY tl.created_at DESC
        """
    )
    fun pickingItemLogs(itemIds: List<String>): List<LogFlatRow>

    @Query("SELECT * FROM receiving_invoices WHERE receiving_order_id = :orderId")
    fun invoicesOfOrder(orderId: String): List<ReceivingInvoiceEntity>

    @Query("SELECT * FROM receiving_invoice_items WHERE receiving_invoice_id IN (:invoiceIds)")
    fun itemsOfInvoices(invoiceIds: List<String>): List<ReceivingInvoiceItemEntity>

    @Query("UPDATE receiving_orders SET status = :status, updated_at = :now WHERE id = :orderId")
    fun updateOrderStatus(orderId: String, status: String, now: Long)

    @Insert
    fun insertTransitionLog(log: TransitionLogEntity)
}

data class OrderItemFlatRow(
    val id: String,
    @ColumnInfo(name = "ref_no") val refNo: String,
    val status: String,
    @ColumnInfo(name = "delivery_date") val deliveryDate: Long?,
    @ColumnInfo(name = "supplier_name") val supplierName: String?,
    @ColumnInfo(name = "invoice_no") val invoiceNo: String?,
    @ColumnInfo(name = "item_id") val itemId: String?,
    @ColumnInfo(name = "part_id") val partId: String?,
    @ColumnInfo(name = "date_code") val dateCode: String?,
    @ColumnInfo(name = "gross_qty") val grossQty: Int?,
)

data class OrderAllocationTotalRow(
    @ColumnInfo(name = "receiving_order_id") val receivingOrderId: String,
    @ColumnInfo(name = "part_id") val partId: String,
    @ColumnInfo(name = "total_qty") val totalQty: Int,
)

data class ItemQtyRow(
    @ColumnInfo(name = "item_id") val itemId: String,
    val qty: Int,
)

data class OrderPickingLinkRow(
    @ColumnInfo(name = "receiving_order_id") val receivingOrderId: String,
    @ColumnInfo(name = "picking_order_id") val pickingOrderId: String,
)

data class DetailItemFlatRow(
    @ColumnInfo(name = "invoice_id") val invoiceId: String,
    @ColumnInfo(name = "invoice_no") val invoiceNo: String,
    @ColumnInfo(name = "item_id") val itemId: String,
    @ColumnInfo(name = "part_id") val partId: String,
    @ColumnInfo(name = "part_no") val partNo: String,
    @ColumnInfo(name = "po_no") val poNo: String?,
    @ColumnInfo(name = "po_line") val poLine: String?,
    val qty: Int,
    @ColumnInfo(name = "received_qty") val receivedQty: Int,
    @ColumnInfo(name = "picked_qty") val pickedQty: Int,
    @ColumnInfo(name = "put_away_qty") val putAwayQty: Int,
    @ColumnInfo(name = "box_id") val boxId: String?,
    @ColumnInfo(name = "date_code") val dateCode: String?,
    @ColumnInfo(name = "lot_code") val lotCode: String?,
    val coo: String?,
    val cow: String?,
)

data class PickingRowFlat(
    @ColumnInfo(name = "picking_order_id") val pickingOrderId: String,
    @ColumnInfo(name = "picking_order_ref") val pickingOrderRef: String,
    @ColumnInfo(name = "picking_order_status") val pickingOrderStatus: String,
    @ColumnInfo(name = "picking_order_ship_to") val pickingOrderShipTo: String?,
    @ColumnInfo(name = "picking_item_id") val pickingItemId: String,
    @ColumnInfo(name = "required_qty") val requiredQty: Int,
    @ColumnInfo(name = "picked_qty") val pickedQty: Int,
    @ColumnInfo(name = "scanned_qty") val scannedQty: Int,
    @ColumnInfo(name = "boxed_qty") val boxedQty: Int,
    @ColumnInfo(name = "part_id") val partId: String,
    @ColumnInfo(name = "part_no") val partNo: String,
    @ColumnInfo(name = "shelf_code") val shelfCode: String?,
    @ColumnInfo(name = "box_id") val boxId: String?,
    @ColumnInfo(name = "date_code") val dateCode: String?,
    @ColumnInfo(name = "lot_code") val lotCode: String?,
    val coo: String?,
    val cow: String?,
    @ColumnInfo(name = "allocated_qty") val allocatedQty: Int,
    @ColumnInfo(name = "allocation_id") val allocationId: String,
)

data class BoxFlatRow(
    val id: String,
    @ColumnInfo(name = "picking_order_id") val pickingOrderId: String?,
    val status: String,
)

data class LogFlatRow(
    val id: String,
    @ColumnInfo(name = "entity_id") val entityId: String,
    @ColumnInfo(name = "from_state") val fromState: String?,
    @ColumnInfo(name = "to_state") val toState: String,
    val metadata: String?,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "actor_name") val actorName: String?,
)
```

Register in `AppDatabase`: `abstract fun receivingDao(): ReceivingDao`.

- [ ] **Step 5: Write ReceivingRepository**

`apps/android/app/src/main/java/com/docpal/warehousepda/data/ReceivingRepository.kt`:

```kotlin
package com.docpal.warehousepda.data

import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.data.db.ReceivingItemMismatchEntity
import com.docpal.warehousepda.data.db.TransitionLogEntity
import com.docpal.warehousepda.domain.AllocationDistributor
import com.docpal.warehousepda.domain.model.DisplayBox
import com.docpal.warehousepda.domain.model.DisplayPackage
import com.docpal.warehousepda.domain.model.MismatchInfo
import com.docpal.warehousepda.domain.model.PickingByReceivingRow
import com.docpal.warehousepda.domain.model.PickingItemLog
import com.docpal.warehousepda.domain.model.ReceivingInvoiceDetail
import com.docpal.warehousepda.domain.model.ReceivingItemDetail
import com.docpal.warehousepda.domain.model.ReceivingOrderDetail
import com.docpal.warehousepda.domain.model.ReceivingOrderSummary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.UUID

/** Read model + clear/in-hand transitions for receiving orders. Mirrors the web adapter + db/receiving.ts. */
class ReceivingRepository(private val db: AppDatabase) {

    private val dao get() = db.receivingDao()

    suspend fun listOrders(filter: String): List<ReceivingOrderSummary> = withContext(Dispatchers.IO) {
        val rows = dao.listOrderRows(filter)
        val totals = dao.orderAllocationTotals().associate { (it.receivingOrderId to it.partId) to it.totalQty }
        val unboxed = dao.unboxedPutAwayScanTotals().associate { it.itemId to it.qty }
        val links = dao.pendingPickingOrderLinks()
            .groupBy({ it.receivingOrderId }, { it.pickingOrderId })

        rows.groupBy { it.id }.map { (_, orderRows) ->
            val first = orderRows.first()
            val items = orderRows.filter { it.itemId != null }.map {
                AllocationDistributor.InvoiceItemRow(
                    id = it.itemId!!,
                    partId = it.partId!!,
                    receivingOrderId = first.id,
                    grossQty = it.grossQty ?: 0,
                    deliveryDate = first.deliveryDate,
                    invoiceNo = it.invoiceNo ?: "",
                    dateCode = it.dateCode,
                )
            }
            val availability = AllocationDistributor.distribute(items, totals, unboxed)
            val remaining = if (first.status == "in_hand") {
                availability.count { it.value.availableQty > 0 }
            } else 0
            ReceivingOrderSummary(
                id = first.id,
                refNo = first.refNo,
                status = first.status,
                deliveryDate = first.deliveryDate,
                supplierName = first.supplierName,
                remainingItems = remaining,
                pendingPickingOrders = links[first.id]?.distinct()?.size ?: 0,
            )
        }
    }

    suspend fun getOrderDetail(orderId: String): ReceivingOrderDetail = withContext(Dispatchers.IO) {
        val order = dao.orderById(orderId)
            ?: throw com.docpal.warehousepda.domain.LocalizedException("receiving_order_not_found")
        val supplierName = order.supplierId?.let { dao.supplierName(it) }
        val rows = dao.detailItemRows(orderId)
        val itemIds = rows.map { it.itemId }

        // Availability per item (allocated share) via the distributor.
        val totals = dao.orderAllocationTotals().associate { (it.receivingOrderId to it.partId) to it.totalQty }
        val unboxed = dao.unboxedPutAwayScanTotals().associate { it.itemId to it.qty }
        val distributorItems = rows.map {
            AllocationDistributor.InvoiceItemRow(
                id = it.itemId,
                partId = it.partId,
                receivingOrderId = orderId,
                grossQty = it.receivedQty - it.pickedQty - it.putAwayQty,
                deliveryDate = order.deliveryDate,
                invoiceNo = it.invoiceNo,
                dateCode = it.dateCode,
            )
        }
        val availability = AllocationDistributor.distribute(distributorItems, totals, unboxed)

        val mismatches = if (itemIds.isEmpty()) emptyList() else dao.activeMismatches(itemIds)
        val mismatchByItem = HashMap<String, ReceivingItemMismatchEntity>()
        for (m in mismatches) mismatchByItem.putIfAbsent(m.receivingInvoiceItemId, m)

        val invoices = rows.groupBy { it.invoiceId }.map { (invoiceId, invoiceRows) ->
            ReceivingInvoiceDetail(
                id = invoiceId,
                invoiceNo = invoiceRows.first().invoiceNo,
                items = invoiceRows.map { r ->
                    val m = mismatchByItem[r.itemId]
                    ReceivingItemDetail(
                        id = r.itemId, partId = r.partId, partNo = r.partNo,
                        poNo = r.poNo, poLine = r.poLine, qty = r.qty,
                        receivedQty = r.receivedQty, pickedQty = r.pickedQty, putAwayQty = r.putAwayQty,
                        boxId = r.boxId, dateCode = r.dateCode, lotCode = r.lotCode, coo = r.coo, cow = r.cow,
                        allocatedQty = availability[r.itemId]?.allocatedQty ?: 0,
                        mismatch = m?.let {
                            MismatchInfo(it.id, it.reason, it.mismatchQty, it.wrongPartNo, it.note,
                                it.status, it.effectiveReceivedQty, it.previousReceivedQty,
                                it.reportedBy, it.reportedAt)
                        },
                    )
                },
            )
        }

        val pickingRows = dao.pickingRowsByReceivingOrder(orderId).map {
            PickingByReceivingRow(
                it.pickingOrderId, it.pickingOrderRef, it.pickingOrderStatus, it.pickingOrderShipTo,
                it.pickingItemId, it.requiredQty, it.pickedQty, it.scannedQty, it.boxedQty,
                it.partId, it.partNo, it.shelfCode, it.boxId, it.dateCode, it.lotCode, it.coo, it.cow,
                it.allocatedQty, it.allocationId,
            )
        }
        val pickingItemIds = pickingRows.map { it.pickingItemId }.distinct()
        val pickingOrderIds = pickingRows.map { it.pickingOrderId }.distinct()

        val packagesByItem = if (pickingItemIds.isEmpty()) emptyMap() else
            dao.packagesByItemIds(pickingItemIds).map {
                DisplayPackage(it.id, it.pickingItemId, it.pickingOrderId, it.qty, it.shippingBoxId,
                    it.dateCode, it.lotCode, it.coo, it.cow, it.createdAt)
            }.groupBy { it.pickingItemId }

        val boxesByOrder = if (pickingOrderIds.isEmpty()) emptyMap() else
            dao.boxesByOrderIds(pickingOrderIds)
                .map { DisplayBox(it.id, it.pickingOrderId, it.status) }
                .groupBy { it.pickingOrderId ?: "" }

        val logs = if (pickingItemIds.isEmpty()) emptyMap() else
            dao.pickingItemLogs(pickingItemIds).map {
                PickingItemLog(it.id, it.entityId, it.fromState, it.toState, it.metadata, it.createdAt, it.actorName)
            }.groupBy { it.entityId }

        val remainingItems = if (order.status == "in_hand") {
            availability.count { it.value.availableQty > 0 }
        } else 0

        ReceivingOrderDetail(
            id = order.id, refNo = order.refNo, status = order.status,
            deliveryDate = order.deliveryDate, supplierName = supplierName,
            invoices = invoices, remainingItems = remainingItems,
            pickingRows = pickingRows, packagesByItem = packagesByItem,
            boxesByOrder = boxesByOrder, transitionLogs = logs,
        )
    }

    /** available = received - picked - put_away - allocated - unboxed scans, per item. Used by clear/in-hand. */
    internal fun availableQtyByItem(orderId: String): Map<String, Int> {
        val rows = dao.detailItemRows(orderId)
        val order = dao.orderById(orderId) ?: return emptyMap()
        val totals = dao.orderAllocationTotals().associate { (it.receivingOrderId to it.partId) to it.totalQty }
        val unboxed = dao.unboxedPutAwayScanTotals().associate { it.itemId to it.qty }
        val items = rows.map {
            AllocationDistributor.InvoiceItemRow(
                id = it.itemId, partId = it.partId, receivingOrderId = orderId,
                grossQty = it.receivedQty - it.pickedQty - it.putAwayQty,
                deliveryDate = order.deliveryDate,
                invoiceNo = it.invoiceNo,
                dateCode = it.dateCode,
            )
        }
        return AllocationDistributor.distribute(items, totals, unboxed)
            .mapValues { it.value.availableQty }
    }

    /** Mirrors web tryMarkReceivingOrderClear: in_hand → clear when every item's available <= 0. Call inside a transaction. */
    fun tryMarkClear(orderId: String, actorId: String) {
        val order = dao.orderById(orderId) ?: return
        if (order.status != "in_hand") return
        val invoices = dao.invoicesOfOrder(orderId)
        val items = if (invoices.isEmpty()) emptyList() else dao.itemsOfInvoices(invoices.map { it.id })
        if (items.isEmpty()) return
        val available = availableQtyByItem(orderId)
        if (items.any { (available[it.id] ?: 0) > 0 }) return
        val now = System.currentTimeMillis()
        dao.updateOrderStatus(orderId, "clear", now)
        dao.insertTransitionLog(
            TransitionLogEntity(
                id = UUID.randomUUID().toString(),
                entityType = "receiving_order", entityId = orderId,
                fromState = order.status, toState = "clear",
                actorId = actorId, metadata = null, createdAt = now,
            )
        )
    }

    /** Mirrors web tryMarkReceivingOrderInHand: clear → in_hand when any item regains availability. */
    fun tryMarkInHand(orderId: String, actorId: String) {
        val order = dao.orderById(orderId) ?: return
        if (order.status != "clear") return
        val invoices = dao.invoicesOfOrder(orderId)
        val items = if (invoices.isEmpty()) emptyList() else dao.itemsOfInvoices(invoices.map { it.id })
        if (items.isEmpty()) return
        val available = availableQtyByItem(orderId)
        if (items.none { (available[it.id] ?: 0) > 0 }) return
        val now = System.currentTimeMillis()
        dao.updateOrderStatus(orderId, "in_hand", now)
        dao.insertTransitionLog(
            TransitionLogEntity(
                id = UUID.randomUUID().toString(),
                entityType = "receiving_order", entityId = orderId,
                fromState = order.status, toState = "in_hand",
                actorId = actorId, metadata = null, createdAt = now,
            )
        )
    }
}
```

Wire into `AppContainer`: `val receivingRepository by lazy { ReceivingRepository(db) }`.

- [ ] **Step 6: Run test — verify PASS**

```bash
./gradlew :app:testDebugUnitTest --tests "*ReceivingRepositoryTest"
```

- [ ] **Step 7: Commit**

```bash
git add apps/android && git commit -m "android phase1: receiving list/detail repository, clear/in-hand transitions"
```

---

## Task 4: MismatchRules — pure validation and received-qty math

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/MismatchRules.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/MismatchRulesTest.kt`

Source of truth: `apps/web/db/mismatch.ts` (`computeReceivedQty` line 9, `validateMismatchInputs` line 35). Validation throws in exactly this order: `mismatch_reason_required` → `not_found_mismatch_cannot_include_qty` → `quantity_must_be_non_negative_integer` → `damaged_rejected_quantity_exceeds_expected` → `quantity_must_be_greater_than_zero` → `wrong_part_number_required` → `quantity_mismatch_requires_valid_received_qty` → `computed_received_quantity_cannot_be_negative`.

- [ ] **Step 1: Write the failing test**

`apps/android/app/src/test/java/com/docpal/warehousepda/domain/MismatchRulesTest.kt`:

```kotlin
package com.docpal.warehousepda.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class MismatchRulesTest {

    @Test
    fun `computeReceivedQty per reason`() {
        assertEquals(0, MismatchRules.computeReceivedQty(100, "not_found", null))
        assertEquals(60, MismatchRules.computeReceivedQty(100, "damaged", 40))
        assertEquals(60, MismatchRules.computeReceivedQty(100, "quality_rejection", 40))
        assertEquals(0, MismatchRules.computeReceivedQty(100, "damaged", null))   // bad defaults to 0
        assertEquals(70, MismatchRules.computeReceivedQty(100, "qty_mismatch", 70))
        assertEquals(100, MismatchRules.computeReceivedQty(100, "over_shipment", 25)) // capped at expected
        assertEquals(0, MismatchRules.computeReceivedQty(100, "wrong_part", 100))
    }

    @Test
    fun `damaged bad qty larger than expected clamps to zero`() {
        assertEquals(0, MismatchRules.computeReceivedQty(10, "damaged", 99))
    }

    private fun errorKey(expected: Int, reason: String?, qty: Int?, wrongPart: String?): String? =
        runCatching { MismatchRules.validateMismatchInputs(expected, reason, qty, wrongPart) }
            .exceptionOrNull()?.let { (it as LocalizedException).code }

    @Test
    fun `validation order and keys`() {
        assertEquals("mismatch_reason_required", errorKey(100, null, null, null))
        assertEquals("not_found_mismatch_cannot_include_qty", errorKey(100, "not_found", 5, null))
        assertEquals("quantity_must_be_non_negative_integer", errorKey(100, "damaged", -1, null))
        assertEquals("damaged_rejected_quantity_exceeds_expected", errorKey(10, "damaged", 11, null))
        assertEquals("damaged_rejected_quantity_exceeds_expected", errorKey(10, "quality_rejection", 11, null))
        assertEquals("quantity_must_be_greater_than_zero", errorKey(100, "over_shipment", 0, null))
        assertEquals("quantity_must_be_greater_than_zero", errorKey(100, "wrong_part", 0, "X"))
        assertEquals("wrong_part_number_required", errorKey(100, "wrong_part", 5, "  "))
        assertEquals("quantity_mismatch_requires_valid_received_qty", errorKey(100, "qty_mismatch", null, null))
    }

    @Test
    fun `valid inputs pass`() {
        MismatchRules.validateMismatchInputs(100, "not_found", null, null)
        MismatchRules.validateMismatchInputs(100, "damaged", 40, null)
        MismatchRules.validateMismatchInputs(100, "qty_mismatch", 0, null)
        MismatchRules.validateMismatchInputs(100, "over_shipment", 25, null)
        MismatchRules.validateMismatchInputs(100, "wrong_part", 100, "ABC-1")
    }

    @Test
    fun `unknown reason throws unhandled_mismatch_reason`() {
        val e = assertThrows(LocalizedException::class.java) {
            MismatchRules.computeReceivedQty(100, "bogus", null)
        }
        assertEquals("unhandled_mismatch_reason", e.code)
    }
}
```

Note: web validates `Number.isInteger(qty)` — Android inputs are already `Int?`, so the non-integer case cannot occur; negative is the reachable half of that check.

- [ ] **Step 2: Run test to verify it fails**

```bash
./gradlew :app:testDebugUnitTest --tests "*MismatchRulesTest"
```

- [ ] **Step 3: Write MismatchRules**

`apps/android/app/src/main/java/com/docpal/warehousepda/domain/MismatchRules.kt`:

```kotlin
package com.docpal.warehousepda.domain

/**
 * Pure port of apps/web/db/mismatch.ts computeReceivedQty + validateMismatchInputs.
 * Reasons are stored as strings (matching the seed/schema): not_found, damaged,
 * qty_mismatch, wrong_part, over_shipment, quality_rejection.
 */
object MismatchRules {

    const val NOT_FOUND = "not_found"
    const val DAMAGED = "damaged"
    const val QTY_MISMATCH = "qty_mismatch"
    const val WRONG_PART = "wrong_part"
    const val OVER_SHIPMENT = "over_shipment"
    const val QUALITY_REJECTION = "quality_rejection"

    val ALL_REASONS = listOf(NOT_FOUND, DAMAGED, QTY_MISMATCH, WRONG_PART, OVER_SHIPMENT, QUALITY_REJECTION)

    fun computeReceivedQty(expectedQty: Int, reason: String, mismatchQty: Int?): Int = when (reason) {
        NOT_FOUND -> 0
        DAMAGED, QUALITY_REJECTION -> maxOf(0, expectedQty - (mismatchQty ?: 0))
        QTY_MISMATCH -> mismatchQty ?: 0
        OVER_SHIPMENT -> expectedQty
        WRONG_PART -> 0
        else -> throw LocalizedException("unhandled_mismatch_reason", mapOf("reason" to reason))
    }

    /** Throws LocalizedException with the web's i18n keys, in the web's check order. */
    fun validateMismatchInputs(
        expectedQty: Int,
        reason: String?,
        mismatchQty: Int?,
        wrongPartNo: String?,
    ) {
        if (reason == null) throw LocalizedException("mismatch_reason_required")
        if (reason == NOT_FOUND && mismatchQty != null) {
            throw LocalizedException("not_found_mismatch_cannot_include_qty")
        }
        val qty = mismatchQty ?: 0
        if (qty < 0) throw LocalizedException("quantity_must_be_non_negative_integer")
        if ((reason == DAMAGED || reason == QUALITY_REJECTION) && qty > expectedQty) {
            throw LocalizedException("damaged_rejected_quantity_exceeds_expected")
        }
        if ((reason == OVER_SHIPMENT || reason == WRONG_PART) && qty <= 0) {
            throw LocalizedException("quantity_must_be_greater_than_zero")
        }
        if (reason == WRONG_PART && wrongPartNo.isNullOrBlank()) {
            throw LocalizedException("wrong_part_number_required")
        }
        if (reason == QTY_MISMATCH && mismatchQty == null) {
            throw LocalizedException("quantity_mismatch_requires_valid_received_qty")
        }
        if (computeReceivedQty(expectedQty, reason, mismatchQty) < 0) {
            throw LocalizedException("computed_received_quantity_cannot_be_negative")
        }
    }
}
```

(The two-argument `LocalizedException` constructor comes from Task 1's extension; error display maps `code` to `R.string.error_<code>` and substitutes `params` — Task 14's `ErrorText` helper handles substitution.)

- [ ] **Step 4: Run test — verify PASS**

```bash
./gradlew :app:testDebugUnitTest --tests "*MismatchRulesTest"
```

- [ ] **Step 5: Commit**

```bash
git add apps/android && git commit -m "android phase1: mismatch rules (computeReceivedQty + validation)"
```

---

## Task 5: MismatchRepository — report / edit / confirm / cancel

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/MismatchRepository.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/ReceivingDao.kt` (add mutation queries)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/AppContainer.kt` (provide repository)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/MismatchRepositoryTest.kt`

Source of truth: `apps/web/db/mismatch.ts` (`reportReceivingItemMismatch` line 155, `editReceivingItemMismatch` line 228, `confirmReceivingItemMismatch` line 297, `cancelReceivingItemMismatch` line 329, `assertCanApplyMismatchQty` line 81).

Semantics to preserve exactly:
- Report: item must exist → no active confirmed mismatch (`confirmed_mismatch_already_exists`) → no active pending mismatch (`pending_mismatch_already_exists`) → validate → compute effective → `assertCanApplyMismatchQty` (effective < picked + putAway + allocated → `mismatch_qty_below_consumed_stock`) → insert mismatch (status pending, `mismatch_qty` null for not_found, `wrong_part_no` only for wrong_part, note trimmed-or-null, `previous_received_qty` = current) → set item `received_qty` = effective → tryMarkClear + tryMarkInHand on the parent order → transition log with `entity_type='receiving_item_mismatch'`, **`entity_id` = the invoice item id** (not the mismatch id), metadata JSON `{reason, mismatchQty, wrongPartNo, effectiveReceivedQty, note}`.
- Edit: pending only (`only_pending_mismatch_can_be_edited`), reporter only (`only_reporter_can_edit_mismatch`), same validation + assert, updates mismatch + item received_qty, tryMark both, log from_state pending → to_state pending.
- Confirm: pending only (`only_pending_mismatch_can_be_confirmed`), NOT reporter (`reporter_cannot_confirm_own_mismatch`); changes status + confirmed_by/at only; log metadata `{mismatchId}`.
- Cancel: pending only (`only_pending_mismatch_can_be_cancelled`), NOT reporter (`reporter_cannot_cancel_own_mismatch`); first `assertCanApplyMismatchQty(previousReceivedQty)` → status cancelled + cancelled_by/at → item received_qty reverted to snapshot → tryMark both → log metadata `{mismatchId, revertedToQty}`.
- "Active" = `status != 'cancelled'`, latest by `reported_at DESC`.

- [ ] **Step 1: Write the failing test**

`apps/android/app/src/test/java/com/docpal/warehousepda/domain/MismatchRepositoryTest.kt` — seeded in-memory DB (same setup as `ReceivingRepositoryTest`). Pick a seeded pending receiving order with an item (grep `seed.sql`), and a second seeded user id for the four-eyes cases (any `users` row whose id ≠ reporter):

```kotlin
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MismatchRepositoryTest {

    private lateinit var db: AppDatabase
    private lateinit var repo: MismatchRepository
    private lateinit var receivingRepo: ReceivingRepository

    @Before fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
        receivingRepo = ReceivingRepository(db)
        repo = MismatchRepository(db, receivingRepo)
    }
    @After fun tearDown() = db.close()

    @Test fun `report applies effective received qty and logs against item id`() = runBlocking {
        val item = firstSeededPendingItem()          // helper: query via dao in offMainThread
        repo.reportMismatch(item.id, ACTOR_A, "damaged", 40, null, "box crushed")
        val after = itemById(item.id)
        assertEquals(item.qty - 40, after.receivedQty)
        val mismatch = activeMismatch(item.id)!!
        assertEquals("pending", mismatch.status)
        assertEquals(item.receivedQty, mismatch.previousReceivedQty)
        assertEquals(item.qty - 40, mismatch.effectiveReceivedQty)
        val log = latestLog("receiving_item_mismatch", item.id)!!
        assertEquals("pending", log.toState)
        assertEquals(ACTOR_A, log.actorId)
    }

    @Test fun `report rejects second pending mismatch`() = runBlocking {
        val item = firstSeededPendingItem()
        repo.reportMismatch(item.id, ACTOR_A, "damaged", 1, null, "")
        val e = assertThrows(LocalizedException::class.java) {
            runBlocking { repo.reportMismatch(item.id, ACTOR_A, "damaged", 2, null, "") }
        }
        assertEquals("pending_mismatch_already_exists", e.code)
    }

    @Test fun `four eyes - reporter cannot confirm or cancel own mismatch`() = runBlocking {
        val item = firstSeededPendingItem()
        repo.reportMismatch(item.id, ACTOR_A, "qty_mismatch", 5, null, "")
        val m = activeMismatch(item.id)!!
        assertEquals("reporter_cannot_confirm_own_mismatch",
            assertThrows(LocalizedException::class.java) { runBlocking { repo.confirmMismatch(m.id, ACTOR_A) } }.code)
        assertEquals("reporter_cannot_cancel_own_mismatch",
            assertThrows(LocalizedException::class.java) { runBlocking { repo.cancelMismatch(m.id, ACTOR_A) } }.code)
    }

    @Test fun `cancel reverts received qty to snapshot`() = runBlocking {
        val item = firstSeededPendingItem()
        repo.reportMismatch(item.id, ACTOR_A, "not_found", null, null, "missing")
        assertEquals(0, itemById(item.id).receivedQty)
        val m = activeMismatch(item.id)!!
        repo.cancelMismatch(m.id, ACTOR_B)
        assertEquals(item.receivedQty, itemById(item.id).receivedQty)
        assertNull(activeMismatch(item.id))
    }

    @Test fun `confirm blocks further reports`() = runBlocking {
        val item = firstSeededPendingItem()
        repo.reportMismatch(item.id, ACTOR_A, "damaged", 1, null, "")
        val m = activeMismatch(item.id)!!
        repo.confirmMismatch(m.id, ACTOR_B)
        assertEquals("confirmed_mismatch_already_exists",
            assertThrows(LocalizedException::class.java) {
                runBlocking { repo.reportMismatch(item.id, ACTOR_B, "damaged", 1, null, "") }
            }.code)
    }

    @Test fun `edit by non reporter rejected; edit recomputes effective qty`() = runBlocking {
        val item = firstSeededPendingItem()
        repo.reportMismatch(item.id, ACTOR_A, "damaged", 10, null, "")
        val m = activeMismatch(item.id)!!
        assertEquals("only_reporter_can_edit_mismatch",
            assertThrows(LocalizedException::class.java) {
                runBlocking { repo.editMismatch(m.id, ACTOR_B, "damaged", 20, null, "") }
            }.code)
        repo.editMismatch(m.id, ACTOR_A, "qty_mismatch", 7, null, "recounted")
        assertEquals(7, itemById(item.id).receivedQty)
        assertEquals("qty_mismatch", activeMismatch(item.id)!!.reason)
    }

    @Test fun `mismatch that would drop below consumed stock is rejected`() = runBlocking {
        // Construct: take a seeded in_hand item with picked/putAway/allocated > 0 (find in seed.sql
        // or set up via execSQL), then report qty_mismatch below the consumed amount.
        // Expect key mismatch_qty_below_consumed_stock.
    }

    // helpers: firstSeededPendingItem(), itemById(), activeMismatch(), latestLog() —
    // implement with db.receivingDao() queries inside offMainThread { }.
}
```

`ACTOR_A`/`ACTOR_B`: two distinct seeded user ids from `seed.sql` (`INSERT INTO users`). Fill the last test with a concrete seeded item: pick an in_hand order item that has allocations (cross-reference `seed.sql` allocations → picking_items → part → invoice items) or insert rows via `execSQL`.

- [ ] **Step 2: Run test to verify it fails**

```bash
./gradlew :app:testDebugUnitTest --tests "*MismatchRepositoryTest"
```

- [ ] **Step 3: Add mutation queries to ReceivingDao**

```kotlin
@Query("SELECT * FROM receiving_invoice_items WHERE id = :id")
fun itemById(id: String): ReceivingInvoiceItemEntity?

@Query(
    """
    SELECT * FROM receiving_item_mismatches
    WHERE receiving_invoice_item_id = :itemId AND status != 'cancelled'
    ORDER BY reported_at DESC LIMIT 1
    """
)
fun activeMismatchForItem(itemId: String): ReceivingItemMismatchEntity?

@Query("SELECT * FROM receiving_item_mismatches WHERE id = :id")
fun mismatchById(id: String): ReceivingItemMismatchEntity?

@Query("SELECT receiving_order_id FROM receiving_invoices WHERE id = :invoiceId")
fun orderIdOfInvoice(invoiceId: String): String?

@Query("UPDATE receiving_invoice_items SET received_qty = :qty WHERE id = :itemId")
fun updateItemReceivedQty(itemId: String, qty: Int)

@Query(
    """
    UPDATE receiving_item_mismatches
    SET reason = :reason, mismatch_qty = :mismatchQty, wrong_part_no = :wrongPartNo,
        note = :note, effective_received_qty = :effectiveReceivedQty
    WHERE id = :id
    """
)
fun updateMismatchFields(
    id: String, reason: String, mismatchQty: Int?, wrongPartNo: String?,
    note: String?, effectiveReceivedQty: Int,
)

@Query(
    """
    UPDATE receiving_item_mismatches
    SET status = :status, confirmed_by = :confirmedBy, confirmed_at = :confirmedAt
    WHERE id = :id
    """
)
fun markMismatchConfirmed(id: String, status: String, confirmedBy: String, confirmedAt: Long)

@Query(
    """
    UPDATE receiving_item_mismatches
    SET status = :status, cancelled_by = :cancelledBy, cancelled_at = :cancelledAt
    WHERE id = :id
    """
)
fun markMismatchCancelled(id: String, status: String, cancelledBy: String, cancelledAt: Long)

@Insert
fun insertMismatch(mismatch: ReceivingItemMismatchEntity)
```

- [ ] **Step 4: Write MismatchRepository**

`apps/android/app/src/main/java/com/docpal/warehousepda/domain/MismatchRepository.kt`:

```kotlin
package com.docpal.warehousepda.domain

import com.docpal.warehousepda.data.ReceivingRepository
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.data.db.ReceivingItemMismatchEntity
import com.docpal.warehousepda.data.db.TransitionLogEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.UUID

/** Port of apps/web/db/mismatch.ts mutations. All writes run in a Room transaction. */
class MismatchRepository(
    private val db: AppDatabase,
    private val receivingRepository: ReceivingRepository,
) {

    private val dao get() = db.receivingDao()

    suspend fun reportMismatch(
        itemId: String, actorId: String, reason: String,
        mismatchQty: Int?, wrongPartNo: String?, note: String,
    ) = withContext(Dispatchers.IO) {
        val trimmedWrongPart = wrongPartNo?.trim()?.ifEmpty { null }
        val trimmedNote = note.trim().ifEmpty { null }
        db.runInTransaction {
            val item = dao.itemById(itemId) ?: throw LocalizedException("receiving_invoice_item_not_found")
            val existing = dao.activeMismatchForItem(itemId)
            if (existing?.status == "confirmed") throw LocalizedException("confirmed_mismatch_already_exists")
            if (existing != null) throw LocalizedException("pending_mismatch_already_exists")
            MismatchRules.validateMismatchInputs(item.qty, reason, mismatchQty, trimmedWrongPart)
            val effective = MismatchRules.computeReceivedQty(item.qty, reason, mismatchQty)
            assertCanApplyMismatchQty(itemId, effective)
            val now = System.currentTimeMillis()
            dao.insertMismatch(
                ReceivingItemMismatchEntity(
                    id = UUID.randomUUID().toString(),
                    receivingInvoiceItemId = itemId,
                    reason = reason,
                    mismatchQty = if (reason != MismatchRules.NOT_FOUND) mismatchQty else null,
                    wrongPartNo = if (reason == MismatchRules.WRONG_PART) trimmedWrongPart else null,
                    note = trimmedNote,
                    status = "pending",
                    effectiveReceivedQty = effective,
                    previousReceivedQty = item.receivedQty,
                    reportedBy = actorId,
                    reportedAt = now,
                    confirmedBy = null, confirmedAt = null,
                    cancelledBy = null, cancelledAt = null,
                )
            )
            dao.updateItemReceivedQty(itemId, effective)
            markOrderTransitions(item.receivingInvoiceId, actorId)
            logTransition(itemId, null, "pending", actorId, now, JSONObject().apply {
                put("reason", reason)
                put("mismatchQty", mismatchQty ?: JSONObject.NULL)
                put("wrongPartNo", trimmedWrongPart ?: JSONObject.NULL)
                put("effectiveReceivedQty", effective)
                put("note", trimmedNote ?: JSONObject.NULL)
            }.toString())
        }
    }

    suspend fun editMismatch(
        mismatchId: String, actorId: String, reason: String,
        mismatchQty: Int?, wrongPartNo: String?, note: String,
    ) = withContext(Dispatchers.IO) {
        val trimmedWrongPart = wrongPartNo?.trim()?.ifEmpty { null }
        val trimmedNote = note.trim().ifEmpty { null }
        db.runInTransaction {
            val mismatch = dao.mismatchById(mismatchId)
                ?: throw LocalizedException("receiving_item_mismatch_not_found")
            if (mismatch.status != "pending") throw LocalizedException("only_pending_mismatch_can_be_edited")
            if (mismatch.reportedBy != actorId) throw LocalizedException("only_reporter_can_edit_mismatch")
            val item = dao.itemById(mismatch.receivingInvoiceItemId)
                ?: throw LocalizedException("receiving_invoice_item_not_found")
            MismatchRules.validateMismatchInputs(item.qty, reason, mismatchQty, trimmedWrongPart)
            val effective = MismatchRules.computeReceivedQty(item.qty, reason, mismatchQty)
            assertCanApplyMismatchQty(item.id, effective)
            val now = System.currentTimeMillis()
            dao.updateMismatchFields(
                mismatchId, reason,
                if (reason != MismatchRules.NOT_FOUND) mismatchQty else null,
                if (reason == MismatchRules.WRONG_PART) trimmedWrongPart else null,
                trimmedNote, effective,
            )
            dao.updateItemReceivedQty(item.id, effective)
            markOrderTransitions(item.receivingInvoiceId, actorId)
            logTransition(item.id, "pending", "pending", actorId, now, JSONObject().apply {
                put("reason", reason)
                put("mismatchQty", mismatchQty ?: JSONObject.NULL)
                put("wrongPartNo", trimmedWrongPart ?: JSONObject.NULL)
                put("effectiveReceivedQty", effective)
                put("note", trimmedNote ?: JSONObject.NULL)
            }.toString())
        }
    }

    suspend fun confirmMismatch(mismatchId: String, actorId: String) = withContext(Dispatchers.IO) {
        db.runInTransaction {
            val mismatch = dao.mismatchById(mismatchId)
                ?: throw LocalizedException("receiving_item_mismatch_not_found")
            if (mismatch.status != "pending") throw LocalizedException("only_pending_mismatch_can_be_confirmed")
            if (mismatch.reportedBy == actorId) throw LocalizedException("reporter_cannot_confirm_own_mismatch")
            val now = System.currentTimeMillis()
            dao.markMismatchConfirmed(mismatchId, "confirmed", actorId, now)
            logTransition(mismatch.receivingInvoiceItemId, "pending", "confirmed", actorId, now,
                JSONObject().put("mismatchId", mismatchId).toString())
        }
    }

    suspend fun cancelMismatch(mismatchId: String, actorId: String) = withContext(Dispatchers.IO) {
        db.runInTransaction {
            val mismatch = dao.mismatchById(mismatchId)
                ?: throw LocalizedException("receiving_item_mismatch_not_found")
            if (mismatch.status != "pending") throw LocalizedException("only_pending_mismatch_can_be_cancelled")
            if (mismatch.reportedBy == actorId) throw LocalizedException("reporter_cannot_cancel_own_mismatch")
            assertCanApplyMismatchQty(mismatch.receivingInvoiceItemId, mismatch.previousReceivedQty)
            val item = dao.itemById(mismatch.receivingInvoiceItemId)
                ?: throw LocalizedException("receiving_invoice_item_not_found")
            val now = System.currentTimeMillis()
            dao.markMismatchCancelled(mismatchId, "cancelled", actorId, now)
            dao.updateItemReceivedQty(item.id, mismatch.previousReceivedQty)
            markOrderTransitions(item.receivingInvoiceId, actorId)
            logTransition(item.id, "pending", "cancelled", actorId, now, JSONObject().apply {
                put("mismatchId", mismatchId)
                put("revertedToQty", mismatch.previousReceivedQty)
            }.toString())
        }
    }

    /** effective < picked + putAway + allocated → reject (web assertCanApplyMismatchQty). */
    private fun assertCanApplyMismatchQty(itemId: String, effectiveReceivedQty: Int) {
        val item = dao.itemById(itemId) ?: throw LocalizedException("receiving_invoice_item_not_found")
        val invoiceOrderId = dao.orderIdOfInvoice(item.receivingInvoiceId) ?: return
        val allocated = receivingRepository.availableQtyByItem(invoiceOrderId)[itemId]?.let { available ->
            item.receivedQty - item.pickedQty - item.putAwayQty - available
        } ?: 0
        // The above derives allocated+unboxed from the distributor output:
        // available = received - picked - putAway - (allocated + unboxed).
        val consumed = item.pickedQty + item.putAwayQty + allocated
        if (effectiveReceivedQty < consumed) throw LocalizedException("mismatch_qty_below_consumed_stock")
    }

    private fun markOrderTransitions(invoiceId: String, actorId: String) {
        val orderId = dao.orderIdOfInvoice(invoiceId) ?: return
        receivingRepository.tryMarkClear(orderId, actorId)
        receivingRepository.tryMarkInHand(orderId, actorId)
    }

    private fun logTransition(
        itemId: String, from: String?, to: String, actorId: String, now: Long, metadata: String?,
    ) {
        dao.insertTransitionLog(
            TransitionLogEntity(
                id = UUID.randomUUID().toString(),
                entityType = "receiving_item_mismatch",
                entityId = itemId,           // web logs against the invoice item id, not the mismatch id
                fromState = from, toState = to,
                actorId = actorId, metadata = metadata, createdAt = now,
            )
        )
    }
}
```

Note on `assertCanApplyMismatchQty`: the web computes `allocated` from the CTE only (not unboxed scans). Deriving it as `received - picked - putAway - available` includes unboxed put-away scans in the subtraction, which is stricter than the web when unboxed scans exist. Phase 1 has no put-away UI, so `put_away_scans` stays empty and the two are identical; add a comment in the code: `// includes unboxed scans; equivalent to web while put_away_scans is empty (no put-away UI until Phase 3)`.

Wire into `AppContainer`: `val mismatchRepository by lazy { MismatchRepository(db, receivingRepository) }`.

- [ ] **Step 5: Run test — verify PASS**

```bash
./gradlew :app:testDebugUnitTest --tests "*MismatchRepositoryTest"
```

- [ ] **Step 6: Commit**

```bash
git add apps/android && git commit -m "android phase1: mismatch report/edit/confirm/cancel with four-eyes"
```

---

## Task 6: Allocator + confirm arrival

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/Allocator.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/ReceivingDao.kt` (allocation queries; or create `data/db/PickingDao.kt` — see below)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/ReceivingRepository.kt` (`confirmArrived`)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/AppContainer.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/AllocatorTest.kt`

Source of truth: `apps/web/db/allocate.ts` (whole file) + `apps/web/db/receiving.ts` `confirmReceivingOrderArrived` (line 143).

Web allocation behavior:
- `parseDateCodeRule`: trim, optional leading op `>=|<=|>|<` (default `eq`), empty value → undefined rule.
- `dateCodeMatches`: no rule → true; **null lot date matches any rule**; else string comparison.
- Per picking item (own transaction): `needed = qty - pickedQty - allocatedQty`; skip if ≤ 0.
- Phase A: located `inventory_lots` (`available_qty > 0`, `shelf_code` or `box_id` non-null, part match), Kotlin-filter by rule, sort by `dateCode` with nulls last **lexicographic**, `take = min(needed, lot.availableQty)`, insert allocation (lot link) + `lot.allocated_qty += take` + maintain `lot.available_qty = total_qty - allocated_qty` (Phase 0 design decision: available_qty is app-maintained) + `picking_item.allocated_qty += take`.
- Phase B (if needed > 0): receiving orders `in_hand` containing the part, `available = physical - (allocated + unboxed put-away scans)` per (order, part), FIFO by `delivery_date ASC NULLS LAST` → insert allocation with `receiving_order_id`, `remark = JSON array of distinct non-null invoice-item box_ids or null` + `picking_item.allocated_qty += take`. No date-code filter in Phase B.
- Silent partial allocation; zero transition logs; allocations never deleted here.
- `allocatePendingPickingOrders`: all `picking_orders` with status `pending`, in any order.

`confirmReceivingOrderArrived`: order must exist (`receiving_order_not_found`) and be `pending` (`receiving_order_already_status` with `{status}` param) → in one transaction: status `in_hand` + `arrived_at`/`arrived_by`/`updated_at` = now; per item `received_qty = activeMismatch.effectiveReceivedQty else qty`, **skip writes when ≤ 0**; one transition log pending→in_hand. Then **after** the transaction: `allocatePendingPickingOrders` (idempotent, best-effort — the web does not guard the call; keep identical).

- [ ] **Step 1: Write the failing test**

`apps/android/app/src/test/java/com/docpal/warehousepda/domain/AllocatorTest.kt` — pure tests for the rule parser/matcher plus seeded-DB tests for allocation and confirm arrival:

```kotlin
class AllocatorTest {

    @Test fun `parseDateCodeRule`() {
        assertNull(Allocator.parseDateCodeRule(null))
        assertNull(Allocator.parseDateCodeRule("   "))
        assertNull(Allocator.parseDateCodeRule(">="))          // empty value
        assertEquals(Allocator.DateCodeRule("eq", "2406"), Allocator.parseDateCodeRule("2406"))
        assertEquals(Allocator.DateCodeRule("eq", "2406"), Allocator.parseDateCodeRule(" 2406 "))
        assertEquals(Allocator.DateCodeRule(">=", "2406"), Allocator.parseDateCodeRule(">=2406"))
        assertEquals(Allocator.DateCodeRule("<=", "2406"), Allocator.parseDateCodeRule("<=2406"))
        assertEquals(Allocator.DateCodeRule(">", "2406"), Allocator.parseDateCodeRule(">2406"))
        assertEquals(Allocator.DateCodeRule("<", "2406"), Allocator.parseDateCodeRule("<2406"))
    }

    @Test fun `dateCodeMatches semantics`() {
        val ge = Allocator.parseDateCodeRule(">=2406")
        assertTrue(Allocator.dateCodeMatches(null, ge))     // null lot date matches any rule
        assertTrue(Allocator.dateCodeMatches(null, null))   // no rule matches everything
        assertTrue(Allocator.dateCodeMatches("2407", ge))
        assertFalse(Allocator.dateCodeMatches("2405", ge))
        assertTrue(Allocator.dateCodeMatches("2406", Allocator.parseDateCodeRule("2406")))
        assertFalse(Allocator.dateCodeMatches("2406", Allocator.parseDateCodeRule("<2406")))
    }
}
```

Plus a seeded-DB section (`AllocatorDbTest` in the same file or a sibling file, same setup as `ReceivingRepositoryTest`):

```kotlin
@Test fun `confirm arrival moves pending order to in_hand with expected received qty`() = runBlocking {
    // pick a seeded pending order; capture item ids + qty before
    repo.confirmArrived(orderId, ACTOR)
    val after = orderById(orderId)
    assertEquals("in_hand", after.status)
    assertNotNull(after.arrivedAt)
    assertEquals(ACTOR, after.arrivedBy)
    // each item received_qty == qty (no mismatches), log pending->in_hand exists
}

@Test fun `confirm arrival twice rejected with already_status`() = runBlocking {
    repo.confirmArrived(orderId, ACTOR)
    val e = assertThrows(LocalizedException::class.java) { runBlocking { repo.confirmArrived(orderId, ACTOR) } }
    assertEquals("receiving_order_already_status", e.code)
}

@Test fun `confirm arrival respects active mismatch effective qty and skips zero writes`() = runBlocking {
    // report not_found on one item first (MismatchRepository), confirm, assert that
    // item.received_qty stayed 0 and sibling items got qty.
}

@Test fun `allocation after confirm arrival fills pending picking order from receiving area`() = runBlocking {
    // seed-based scenario: a pending picking order whose part exists in the confirmed
    // receiving order. After confirmArrived, assert an allocation row with
    // receiving_order_id = orderId and qty = min(needed, available), and
    // picking_items.allocated_qty increased by the same amount.
}

@Test fun `allocation prefers located lots and respects date code rule`() = runBlocking {
    // insert a located inventory lot (shelf_code set) for the same part via execSQL,
    // run allocator.allocatePickingOrder(orderId), assert lot allocation created and
    // lot.allocated_qty/available_qty updated.
}

@Test fun `allocation is silent-partial and idempotent`() = runBlocking {
    // needed > available → allocation capped; running again adds nothing new.
}
```

Build each scenario from real seed rows (grep `seed.sql` for a pending picking order and its part, then a pending receiving order containing that part). If the seed lacks a scenario, insert rows with `db.openHelper.writableDatabase.execSQL(...)` in `offMainThread { }` — use fixed UUID-like strings and epoch-ms timestamps, mirroring seed style.

- [ ] **Step 2: Run test to verify it fails**

```bash
./gradlew :app:testDebugUnitTest --tests "*Allocator*"
```

- [ ] **Step 3: Add allocation queries**

Create `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/PickingDao.kt` (picking-side reads/writes; receiving-order availability query included):

```kotlin
package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query

@Dao
interface PickingDao {

    @Query("SELECT * FROM picking_orders WHERE status = 'pending'")
    fun pendingPickingOrders(): List<PickingOrderEntity>

    @Query("SELECT * FROM picking_orders WHERE id = :id")
    fun pickingOrderById(id: String): PickingOrderEntity?

    @Query("SELECT * FROM picking_items WHERE picking_order_id = :orderId")
    fun itemsOfPickingOrder(orderId: String): List<PickingItemEntity>

    @Query("SELECT * FROM picking_items WHERE id = :id")
    fun pickingItemById(id: String): PickingItemEntity?

    @Query(
        """
        SELECT * FROM inventory_lots
        WHERE part_id = :partId AND available_qty > 0
          AND (shelf_code IS NOT NULL OR box_id IS NOT NULL)
        """
    )
    fun locatedLotsForPart(partId: String): List<InventoryLotEntity>

    @Query("UPDATE inventory_lots SET allocated_qty = allocated_qty + :qty, available_qty = total_qty - (allocated_qty + :qty) WHERE id = :lotId")
    fun increaseLotAllocated(lotId: String, qty: Int)

    @Query("UPDATE picking_items SET allocated_qty = allocated_qty + :qty WHERE id = :itemId")
    fun increaseItemAllocated(itemId: String, qty: Int)

    @Query("UPDATE picking_items SET allocated_qty = allocated_qty - :qty WHERE id = :itemId")
    fun decreaseItemAllocated(itemId: String, qty: Int)

    /** Receiving-side availability per (order) for a part — web allocate.ts Phase 2 query. */
    @Query(
        """
        SELECT ro.id AS receiving_order_id, ro.delivery_date,
               COALESCE(SUM(rii.received_qty - rii.picked_qty - rii.put_away_qty), 0) AS physical_qty,
               COALESCE((
                 SELECT SUM(a.qty) FROM allocations a
                 JOIN picking_items pi ON pi.id = a.picking_item_id
                 WHERE a.receiving_order_id = ro.id AND pi.part_id = :partId
               ), 0) AS allocated_qty,
               COALESCE((
                 SELECT SUM(pas.qty) FROM put_away_scans pas
                 JOIN receiving_invoice_items rii2 ON rii2.id = pas.receiving_invoice_item_id
                 JOIN receiving_invoices ri2 ON ri2.id = rii2.receiving_invoice_id
                 WHERE ri2.receiving_order_id = ro.id AND rii2.part_id = :partId
                   AND pas.shelf_box_id IS NULL
               ), 0) AS unboxed_qty
        FROM receiving_orders ro
        JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
        JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        WHERE rii.part_id = :partId AND ro.status = 'in_hand'
        GROUP BY ro.id, ro.delivery_date
        HAVING physical_qty - allocated_qty - unboxed_qty > 0
        ORDER BY (ro.delivery_date IS NULL), ro.delivery_date
        """
    )
    fun receivingAvailabilityForPart(partId: String): List<ReceivingAvailabilityRow>

    @Query(
        """
        SELECT DISTINCT rii.box_id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = :orderId AND rii.part_id = :partId AND rii.box_id IS NOT NULL
        """
    )
    fun boxIdsForOrderPart(orderId: String, partId: String): List<String>

    @Insert
    fun insertAllocation(allocation: AllocationEntity)
}

data class ReceivingAvailabilityRow(
    @ColumnInfo(name = "receiving_order_id") val receivingOrderId: String,
    @ColumnInfo(name = "delivery_date") val deliveryDate: Long?,
    @ColumnInfo(name = "physical_qty") val physicalQty: Int,
    @ColumnInfo(name = "allocated_qty") val allocatedQty: Int,
    @ColumnInfo(name = "unboxed_qty") val unboxedQty: Int,
)
```

Register `abstract fun pickingDao(): PickingDao` in `AppDatabase`.

- [ ] **Step 4: Write Allocator**

`apps/android/app/src/main/java/com/docpal/warehousepda/domain/Allocator.kt`:

```kotlin
package com.docpal.warehousepda.domain

import com.docpal.warehousepda.data.db.AllocationEntity
import com.docpal.warehousepda.data.db.AppDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.util.UUID

/** Port of apps/web/db/allocate.ts. */
class Allocator(private val db: AppDatabase) {

    private val dao get() = db.pickingDao()

    data class DateCodeRule(val op: String, val value: String)

    companion object {
        fun parseDateCodeRule(input: String?): DateCodeRule? {
            if (input == null) return null
            val trimmed = input.trim()
            if (trimmed.isEmpty()) return null
            var op = "eq"
            var rest = trimmed
            for (candidate in listOf(">=", "<=", ">", "<")) {
                if (rest.startsWith(candidate)) {
                    op = candidate
                    rest = rest.removePrefix(candidate)
                    break
                }
            }
            val value = rest.trim()
            if (value.isEmpty()) return null
            return DateCodeRule(op, value)
        }

        fun dateCodeMatches(lotDate: String?, rule: DateCodeRule?): Boolean {
            if (rule == null) return true
            if (lotDate == null) return true   // null lot date matches any rule (sorts last)
            return when (rule.op) {
                "eq" -> lotDate == rule.value
                ">=" -> lotDate >= rule.value
                "<=" -> lotDate <= rule.value
                ">" -> lotDate > rule.value
                "<" -> lotDate < rule.value
                else -> false
            }
        }
    }

    suspend fun allocatePendingPickingOrders() = withContext(Dispatchers.IO) {
        for (order in dao.pendingPickingOrders()) {
            allocatePickingOrderInternal(order.id)
        }
    }

    suspend fun allocatePickingOrder(pickingOrderId: String) = withContext(Dispatchers.IO) {
        allocatePickingOrderInternal(pickingOrderId)
    }

    private fun allocatePickingOrderInternal(pickingOrderId: String) {
        for (item in dao.itemsOfPickingOrder(pickingOrderId)) {
            val neededAtStart = item.qty - item.pickedQty - item.allocatedQty
            if (neededAtStart <= 0) continue
            db.runInTransaction {
                var needed = neededAtStart
                val rule = parseDateCodeRule(item.requiredDateCode)

                // Phase A: located lots
                val matching = dao.locatedLotsForPart(item.partId)
                    .filter { dateCodeMatches(it.dateCode, rule) }
                    .sortedWith(compareBy({ it.dateCode == null }, { it.dateCode ?: "" }))
                for (lot in matching) {
                    if (needed <= 0) break
                    val take = minOf(needed, lot.availableQty)
                    dao.insertAllocation(
                        AllocationEntity(
                            id = UUID.randomUUID().toString(),
                            pickingItemId = item.id, inventoryLotId = lot.id,
                            receivingOrderId = null, qty = take, remark = null,
                        )
                    )
                    dao.increaseLotAllocated(lot.id, take)
                    dao.increaseItemAllocated(item.id, take)
                    needed -= take
                }

                // Phase B: receiving-area stock, FIFO by delivery date
                if (needed > 0) {
                    for (row in dao.receivingAvailabilityForPart(item.partId)) {
                        if (needed <= 0) break
                        val available = row.physicalQty - row.allocatedQty - row.unboxedQty
                        if (available <= 0) continue
                        val take = minOf(needed, available)
                        val boxIds = dao.boxIdsForOrderPart(row.receivingOrderId, item.partId)
                        val remark = if (boxIds.isEmpty()) null else JSONArray(boxIds).toString()
                        dao.insertAllocation(
                            AllocationEntity(
                                id = UUID.randomUUID().toString(),
                                pickingItemId = item.id, inventoryLotId = null,
                                receivingOrderId = row.receivingOrderId, qty = take, remark = remark,
                            )
                        )
                        dao.increaseItemAllocated(item.id, take)
                        needed -= take
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 5: Add confirmArrived to ReceivingRepository**

Add to `ReceivingDao`:

```kotlin
@Query(
    """
    UPDATE receiving_orders
    SET status = 'in_hand', arrived_at = :now, arrived_by = :actorId, updated_at = :now
    WHERE id = :orderId
    """
)
fun markOrderArrived(orderId: String, actorId: String, now: Long)
```

Add to `ReceivingRepository` (constructor gains `allocator: Allocator` — AppContainer wires it; mismatch repository is unaffected):

```kotlin
/** Port of db/receiving.ts confirmReceivingOrderArrived. Allocation runs AFTER the transaction, best-effort. */
suspend fun confirmArrived(orderId: String, actorId: String) = withContext(Dispatchers.IO) {
    val now = System.currentTimeMillis()
    db.runInTransaction {
        val order = dao.orderById(orderId) ?: throw LocalizedException("receiving_order_not_found")
        if (order.status != "pending") {
            throw LocalizedException("receiving_order_already_status", mapOf("status" to order.status))
        }
        dao.markOrderArrived(orderId, actorId, now)
        val invoices = dao.invoicesOfOrder(orderId)
        val items = if (invoices.isEmpty()) emptyList() else dao.itemsOfInvoices(invoices.map { it.id })
        val mismatches = if (items.isEmpty()) emptyList() else dao.activeMismatches(items.map { it.id })
        val mismatchByItem = HashMap<String, ReceivingItemMismatchEntity>()
        for (m in mismatches) mismatchByItem.putIfAbsent(m.receivingInvoiceItemId, m)
        for (item in items) {
            val qtyToReceive = mismatchByItem[item.id]?.effectiveReceivedQty ?: item.qty
            if (qtyToReceive <= 0) continue          // web skips writes when <= 0
            dao.updateItemReceivedQty(item.id, qtyToReceive)
        }
        dao.insertTransitionLog(
            TransitionLogEntity(
                id = UUID.randomUUID().toString(),
                entityType = "receiving_order", entityId = orderId,
                fromState = order.status, toState = "in_hand",
                actorId = actorId, metadata = null, createdAt = now,
            )
        )
    }
    allocator.allocatePendingPickingOrders()
}
```

(The two-argument `LocalizedException` constructor comes from Task 1's extension.) `ReceivingRepository` methods `tryMarkClear`/`tryMarkInHand` already exist from Task 3; `confirmArrived` does not call them (the web doesn't either).

- [ ] **Step 6: Run tests — verify PASS**

```bash
./gradlew :app:testDebugUnitTest --tests "*Allocator*"
./gradlew :app:testDebugUnitTest
```

Full suite green (constructor change to ReceivingRepository may require updating Task 3/5 test setup and AppContainer — mechanical).

- [ ] **Step 7: Commit**

```bash
git add apps/android && git commit -m "android phase1: allocator + confirm arrival"
```

---

## Task 7: ScanPrimitives + QrParser

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/scan/ScanPrimitives.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/scan/QrParser.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/ScanDao.kt` (supplier templates — used here; candidate queries arrive in Task 9)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/AppDatabase.kt` (register ScanDao)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/scan/ScanPrimitivesTest.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/scan/QrParserTest.kt`

Sources of truth: `apps/web/composables/useMockOcr.ts` (`normalize`, `normalizeCode`, `parseManual`), `apps/web/utils/parseOcrScan.ts` (`decodeKoaQty` line 561, `parseQrCapture` line 600, `collapseSpaces` line 86). Fixture reference: `apps/web/tests/useLabelScan.test.ts`.

- [ ] **Step 1: Write the failing tests**

`ScanPrimitivesTest.kt`:

```kotlin
package com.docpal.warehousepda.domain.scan

import com.docpal.warehousepda.domain.LocalizedException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class ScanPrimitivesTest {

    @Test fun `normalize trims, uppercases, collapses whitespace, keeps dashes`() {
        assertEquals("KOA-103", ScanPrimitives.normalize("  koa-103  "))
        assertEquals("A B", ScanPrimitives.normalize("a\t b\n c".replace(" c", "")))
        assertEquals("IC-LM358DR", ScanPrimitives.normalize("ic-lm358dr"))
    }

    @Test fun `normalizeCode applies OCR digit substitutions`() {
        assertEquals("2406", ScanPrimitives.normalizeCode("24O6"))
        assertEquals("1125", ScanPrimitives.normalizeCode("ILZS"))
        assertEquals("L240603".replace("L", "1"), ScanPrimitives.normalizeCode("L2406O3"))
    }

    @Test fun `collapseSpaces removes all whitespace`() {
        assertEquals("ABCD", ScanPrimitives.collapseSpaces(" A B\nC\tD "))
    }

    @Test fun `parseManual normalizes fields and nulls empties`() {
        val p = ScanPrimitives.parseManual(
            ScanPrimitives.OcrInput(partNo = " koa-103 ", dateCode = "24O6", lotCode = "", coo = "my", cow = "", qty = "400")
        )
        assertEquals("KOA-103", p.partNo)
        assertEquals("2406", p.dateCode)
        assertNull(p.lotCode)
        assertEquals("MY", p.coo)
        assertNull(p.cow)
        assertEquals(400, p.qty)
    }

    @Test fun `parseManual rejects non-positive or fractional qty`() {
        for (bad in listOf("0", "-5", "1.5", "abc", "")) {
            val e = assertThrows(LocalizedException::class.java) {
                ScanPrimitives.parseManual(ScanPrimitives.OcrInput("X", "", "", "", "", bad))
            }
            assertEquals("qty_must_be_positive_integer", e.code)
        }
    }
}
```

`QrParserTest.kt` (cases mirrored from `apps/web/tests/useLabelScan.test.ts` — open that file and port every `decodeKoaQty`/`parseQrCapture` case verbatim; the list below is the minimum):

```kotlin
package com.docpal.warehousepda.domain.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QrParserTest {

    @Test fun `decodeKoaQty`() {
        assertEquals(5000, QrParser.decodeKoaQty("53"))     // prefix 5, 3 zeros
        assertEquals(5, QrParser.decodeKoaQty("50"))
        assertNull(QrParser.decodeKoaQty("5"))              // too short
        assertNull(QrParser.decodeKoaQty("5a3"))            // non-digit
        assertNull(QrParser.decodeKoaQty("03"))             // result 0 -> invalid
    }

    private val koaTemplate = QrParser.SupplierQrcodeTemplate(
        code = "KOA",
        // verbatim from seed.sql suppliers row (KOA is the only seeded template)
        qrcodeTemplate = "^:(?<itemId>[^:]+)::(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<ignore2>[^:]+):(?<fullName>.+)$",
        qrcodeQtyEncoding = "koa_zeros",
    )

    private val koaSample = ":RK73H1ETTP1000F::24:X:9827002:602:KOA+RK73H1ETTP1000F::::"

    @Test fun `parseQrCapture matches KOA template and decodes qty`() {
        val result = QrParser.parseQrCapture(
            qrValue = koaSample,
            supplierTemplates = listOf(koaTemplate),
            targets = emptyList(),
            contextSupplierCode = "KOA",
        )!!
        assertTrue(result.matched)
        assertEquals("RK73H1ETTP1000F", result.parsed.itemId)
        assertEquals(20000, result.parsed.qty)          // "24" -> 2 * 10^4
        assertEquals("9827002", result.parsed.lotCode)
        assertEquals(listOf(20000), result.options.qtys)
    }

    @Test fun `targets gate uses collapseSpaces + uppercase exact match`() {
        val hit = QrParser.parseQrCapture(koaSample, listOf(koaTemplate),
            targets = listOf(" rk73h1ettp1000f "), contextSupplierCode = null)
        assertTrue(hit != null && hit.matched)
        val miss = QrParser.parseQrCapture(koaSample, listOf(koaTemplate),
            targets = listOf("unrelated-part"), contextSupplierCode = null)
        assertNull(miss)   // no template match -> caller falls back to parseAndIdentify
    }

    @Test fun `context supplier template is tried first`() {
        val other = koaTemplate.copy(code = "ZZZ")
        // both templates match the sample; context code decides which one wins —
        // with ZZZ context, the ZZZ copy must be the one that returns (same decode here,
        // so assert via a qty-encoding difference).
        val zzzPlain = other.copy(qrcodeQtyEncoding = null)
        val result = QrParser.parseQrCapture(koaSample, listOf(koaTemplate, zzzPlain),
            targets = emptyList(), contextSupplierCode = "ZZZ")!!
        assertEquals(24, result.parsed.qty)   // plain parseInt, not koa_zeros decode
    }

    @Test fun `invalid template regex is skipped`() {
        val broken = koaTemplate.copy(qrcodeTemplate = "(?<itemId>[unclosed")
        assertNull(QrParser.parseQrCapture(koaSample, listOf(broken), emptyList(), null))
        // a valid template after the broken one still matches:
        val result = QrParser.parseQrCapture(koaSample, listOf(broken, koaTemplate), emptyList(), null)
        assertEquals("RK73H1ETTP1000F", result!!.parsed.itemId)
    }

    @Test fun `named group regex handles unnamed groups by position`() {
        val regex = NamedGroupRegex.compile("^(\\d+):(?<itemId>[^:]+):(?<qty>\\d+)$")!!
        val groups = regex.matchGroups("42:ABC:7")!!
        assertEquals("ABC", groups["itemId"])
        assertEquals("7", groups["qty"])
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
./gradlew :app:testDebugUnitTest --tests "*ScanPrimitivesTest" --tests "*QrParserTest"
```

- [ ] **Step 3: Write ScanPrimitives**

`apps/android/app/src/main/java/com/docpal/warehousepda/domain/scan/ScanPrimitives.kt`:

```kotlin
package com.docpal.warehousepda.domain.scan

import com.docpal.warehousepda.domain.LocalizedException

/** Port of apps/web/composables/useMockOcr.ts. */
object ScanPrimitives {

    data class OcrInput(
        val partNo: String,
        val dateCode: String,
        val lotCode: String,
        val coo: String,
        val cow: String,
        val qty: String,
    )

    data class OcrParsedFields(
        val partNo: String,
        val dateCode: String?,
        val lotCode: String?,
        val coo: String?,
        val cow: String?,
        val qty: Int,
    )

    /** trim, uppercase, collapse whitespace; keeps dashes/letters (part numbers). */
    fun normalize(value: String): String = value.trim().uppercase().replace(Regex("\\s+"), " ")

    /** normalize + OCR digit substitutions; only for date/lot codes, never part numbers. */
    fun normalizeCode(value: String): String = normalize(value)
        .replace('O', '0')
        .replace('I', '1')
        .replace('L', '1')
        .replace('Z', '2')
        .replace('S', '5')

    /** Remove ALL whitespace (QR matching path). */
    fun collapseSpaces(value: String): String = value.replace(Regex("\\s+"), "")

    fun parseManual(input: OcrInput): OcrParsedFields {
        val qty = input.qty.trim().toIntOrNull()
        if (qty == null || qty <= 0) throw LocalizedException("qty_must_be_positive_integer")
        return OcrParsedFields(
            partNo = normalize(input.partNo),
            dateCode = if (input.dateCode.isEmpty()) null else normalizeCode(input.dateCode),
            lotCode = if (input.lotCode.isEmpty()) null else normalizeCode(input.lotCode),
            coo = if (input.coo.isEmpty()) null else normalize(input.coo),
            cow = if (input.cow.isEmpty()) null else normalize(input.cow),
            qty = qty,
        )
    }
}
```

(`"1.5".toIntOrNull()` is null → rejected, matching the web's `Number.isInteger` gate.)

- [ ] **Step 4: Write ScanDao + QrParser**

`apps/android/app/src/main/java/com/docpal/warehousepda/data/db/ScanDao.kt`:

```kotlin
package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Query

@Dao
interface ScanDao {

    @Query("SELECT code, qrcode_template, qrcode_qty_encoding FROM suppliers WHERE qrcode_template IS NOT NULL")
    fun supplierQrTemplates(): List<SupplierQrTemplateRow>
}

data class SupplierQrTemplateRow(
    val code: String,
    @ColumnInfo(name = "qrcode_template") val qrcodeTemplate: String,
    @ColumnInfo(name = "qrcode_qty_encoding") val qrcodeQtyEncoding: String?,
)
```

Register `abstract fun scanDao(): ScanDao` in `AppDatabase`.

`apps/android/app/src/main/java/com/docpal/warehousepda/domain/scan/QrParser.kt`:

```kotlin
package com.docpal.warehousepda.domain.scan

import java.util.regex.Pattern

/** Port of decodeKoaQty + parseQrCapture from apps/web/utils/parseOcrScan.ts. */
object QrParser {

    private const val QTY_ENCODING_KOA_ZEROS = "koa_zeros"

    data class SupplierQrcodeTemplate(
        val code: String,
        val qrcodeTemplate: String,
        val qrcodeQtyEncoding: String?,
    )

    fun decodeKoaQty(encoded: String): Int? {
        if (!encoded.all { it.isDigit() }) return null
        if (encoded.length < 2) return null
        val zeroCount = encoded.last().digitToInt()
        val prefix = encoded.dropLast(1).toLongOrNull() ?: return null
        var result = prefix
        repeat(zeroCount) { result *= 10 }
        if (result <= 0 || result > Int.MAX_VALUE) return null
        return result.toInt()
    }

    /**
     * @param targets empty list = no gate (matches any itemId)
     * @return matched result, or null when no template matched (caller falls back to OcrLabelParser.parseAndIdentify)
     */
    fun parseQrCapture(
        qrValue: String,
        supplierTemplates: List<SupplierQrcodeTemplate>,
        targets: List<String>,
        contextSupplierCode: String?,
    ): OcrLabelParser.OcrParseResult? {
        val normalizedQr = qrValue.trim()
        val ordered = if (contextSupplierCode != null) {
            supplierTemplates.sortedByDescending { it.code == contextSupplierCode }
        } else supplierTemplates

        for (supplier in ordered) {
            val regex = NamedGroupRegex.compile(supplier.qrcodeTemplate) ?: continue
            val groups = regex.matchGroups(normalizedQr) ?: continue
            val itemId = groups["itemId"] ?: continue
            val normalizedItemId = ScanPrimitives.collapseSpaces(itemId.uppercase())
            val itemMatch = targets.isEmpty() || targets.any {
                ScanPrimitives.collapseSpaces(it.uppercase()) == normalizedItemId
            }
            if (!itemMatch) continue

            val qtyGroup = groups["qty"]
            val qty: Int? = when {
                qtyGroup == null -> null
                supplier.qrcodeQtyEncoding == QTY_ENCODING_KOA_ZEROS -> decodeKoaQty(qtyGroup)
                else -> qtyGroup.toIntOrNull()?.takeIf { it > 0 }
            }

            return OcrLabelParser.OcrParseResult(
                matched = true,
                parsed = OcrLabelParser.ParsedFields(
                    itemId = normalizedItemId,
                    qty = qty,
                    coo = groups["coo"],
                    dateCode = groups["dateCode"],
                    lotCode = groups["lotCode"],
                    cow = groups["cow"],
                ),
                options = OcrLabelParser.CandidateOptions(
                    itemIds = listOf(normalizedItemId),
                    qtys = listOfNotNull(qty),
                    coos = listOfNotNull(groups["coo"]),
                    dateCodes = listOfNotNull(groups["dateCode"]),
                    lotCodes = listOfNotNull(groups["lotCode"]),
                    cows = listOfNotNull(groups["cow"]),
                ),
                raw = OcrLabelParser.RawOcrCapture(text = qrValue, barcodes = emptyList()),
            )
        }
        return null
    }
}

/**
 * Named-group regex shim. `Matcher.group(String)` requires API 26 but minSdk is 24,
 * so `(?<name>...)` groups are resolved by position instead: names are recorded in
 * order of appearance and the pattern is rewritten to plain capturing groups.
 * Invalid patterns return null (web skips invalid template regexes).
 */
class NamedGroupRegex private constructor(
    private val pattern: Pattern,
    private val names: List<String?>,   // null = unnamed capturing group
) {
    fun matchGroups(value: String): Map<String, String>? {
        val matcher = pattern.matcher(value)
        if (!matcher.find()) return null
        val result = HashMap<String, String>()
        names.forEachIndexed { index, name ->
            if (name != null) result[name] = matcher.group(index + 1)
        }
        return result
    }

    companion object {
        /**
         * Rewrites `(?<name>` openers to plain `(` and records every capturing group
         * in order (null = unnamed). Non-capturing/lookaround openers (?:, ?=, ?!, ?<=, ?<!)
         * are left alone and not counted. Seeded templates have no escaped `\(` or
         * char-class parens; the seeded KOA template is all-named anyway.
         */
        fun compile(template: String): NamedGroupRegex? {
            val names = ArrayList<String?>()
            val rewritten = StringBuilder()
            var i = 0
            while (i < template.length) {
                val c = template[i]
                if (c == '\\' && i + 1 < template.length) {
                    rewritten.append(template, i, i + 2)
                    i += 2
                    continue
                }
                if (c == '(') {
                    if (template.startsWith("(?<", i)) {
                        val close = template.indexOf('>', i + 3)
                        if (close > 0 && !template.startsWith("(?<=", i) && !template.startsWith("(?<!", i)) {
                            names.add(template.substring(i + 3, close))
                            rewritten.append('(')
                            i = close + 1
                            continue
                        }
                    } else if (!template.startsWith("(?:", i) && !template.startsWith("(?=", i)
                        && !template.startsWith("(?!", i)
                    ) {
                        names.add(null)   // unnamed capturing group — counts toward indexes
                    }
                }
                rewritten.append(c)
                i++
            }
            return try {
                NamedGroupRegex(Pattern.compile(rewritten.toString()), names)
            } catch (e: Exception) {
                null
            }
        }
    }
}
```

(The seeded KOA template — `^:(?<itemId>[^:]+)::(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<ignore2>[^:]+):(?<fullName>.+)$` — is all-named; unnamed-group counting above keeps the shim correct for any future template.)

- [ ] **Step 5: Run tests — verify PASS**

```bash
./gradlew :app:testDebugUnitTest --tests "*ScanPrimitivesTest" --tests "*QrParserTest"
```

- [ ] **Step 6: Commit**

```bash
git add apps/android && git commit -m "android phase1: scan primitives + QR template parser"
```

---

## Task 8: OcrLabelParser — port of parseAndIdentify

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/scan/OcrLabelParser.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/scan/OcrLabelParserTest.kt`

Source of truth: `apps/web/utils/parseOcrScan.ts` (entire file, 665 lines) + fixtures `apps/web/tests/parseOcrScan.test.ts`. This is a 1:1 port task like Phase 0's scanner copy: translate function-by-function, do not redesign.

Porting map:

| JS (parseOcrScan.ts) | Kotlin (OcrLabelParser.kt) |
|---|---|
| `interface OcrBarcode/RawOcrCapture/ParsedFields/CandidateOptions/OcrParseResult` | `data class`es with identical field names; `string \| null` → `String?`; optional `qty?: number` → `Int?` |
| `COUNTRY_NAME_TO_CODE`, `OCR_SUBSTITUTIONS` | top-level `val` maps, same contents |
| `normalizeText` | delegate to `ScanPrimitives.normalize` (identical impl) |
| `collapseSpaces` | delegate to `ScanPrimitives.collapseSpaces` |
| `RegExp` | `java.util.regex.Pattern`; `regex.exec` loop → `matcher.find()` loop; `new RegExp(src, 'g')` → global find loop; JS `(?=...)`/`(?<=...)` lookarounds and `(?<name>...)` groups are supported by JVM regex |
| `generateVariants` recursion | same recursion; cap: JS stops at string end — identical |
| `Number.isInteger(n)` | `n % 1 == 0` guard or parse via `toIntOrNull` as appropriate |
| `parseAndIdentify(raw, targets?)` | `fun parseAndIdentify(raw: RawOcrCapture, targets: List<String> = emptyList()): OcrParseResult` |
| `scoreTargetMatch` (100/95/80/50 with OCR substitutions) | identical scoring |

Functions to port (all of them): `generateVariants`, `extractWithRegex`, `looksLikePartNumber`, `stripSupplierPrefixes`, `parseBarcodeSegments`, `extractPartNoCandidates`, `extractQtyCandidates`, `extractDateCodeCandidates`, `isPartNumberToken`, `extractLotCodeCandidates`, `extractCooCandidates`, `extractCowCandidates`, `scoreTargetMatch`, `findBestItemMatches`, `parseAndIdentify`. (`decodeKoaQty`/`parseQrCapture` already live in QrParser — do not duplicate.)

- [ ] **Step 1: Write the failing test**

`OcrLabelParserTest.kt`: port `apps/web/tests/parseOcrScan.test.ts` case-by-case. Open the web test file and translate every `it(...)`/`test(...)` into a JUnit `@Test` with identical inputs and expected values (strings/numbers copied verbatim). Name tests after the web descriptions. Also port the fixture labels in the test file. Expect roughly the same number of tests as the web file has cases. Do not invent new cases; do not drop cases.

- [ ] **Step 2: Run test to verify it fails**

```bash
./gradlew :app:testDebugUnitTest --tests "*OcrLabelParserTest"
```

- [ ] **Step 3: Write OcrLabelParser**

Port per the map above. Keep private helper functions private; expose only the same public surface as the web file (`extractPartNoCandidates`, `extractQtyCandidates`, `extractDateCodeCandidates`, `extractLotCodeCandidates`, `extractCooCandidates`, `extractCowCandidates`, `scoreTargetMatch`, `findBestItemMatches`, `parseAndIdentify`, plus the data classes).

Regex translation gotchas to handle explicitly:
- JS regex literals like `/QTY[:.]?\s*(\d+)/gi` → `Pattern.compile("QTY[:.]?\\s*(\\d+)", Pattern.CASE_INSENSITIVE)`.
- `String.matchAll` / global exec loops → `while (matcher.find())`.
- Character class `\d` is identical; `\s` identical; JS `\b` identical.
- If any web regex uses JS-only syntax (e.g. named groups referenced in replacement strings), adapt with `matcher.group("name")`.

- [ ] **Step 4: Run test — verify PASS**

```bash
./gradlew :app:testDebugUnitTest --tests "*OcrLabelParserTest"
```

If a case fails, first check the regex translation, then the candidate ordering (web arrays are confidence-ordered — preserve insertion order).

- [ ] **Step 5: Commit**

```bash
git add apps/android && git commit -m "android phase1: OCR label parser (parseAndIdentify port) with web fixtures"
```

---

## Task 9: Scan candidate queries + ScanMatcher (matchReceiving)

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/ScanDao.kt` (candidate queries)
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/scan/ScanMatcher.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/AppContainer.kt` (provide ScanRepository)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/scan/ScanMatcherTest.kt`

Sources of truth: `apps/web/db/ocrPicking.ts` (`findReceivingCandidates` line 17, `findPickingCandidates` line 67), `apps/web/composables/useScanMatchers.ts` (`matchReceiving` line 119), fixtures `apps/web/tests/scanMatchers.test.ts`.

Web `matchReceiving` semantics (only task `receiving` is in Phase 1 scope):
1. actor required (`operator_not_signed_in` — the Android port takes actorId as a parameter; null → error result).
2. `receivingOrderId` required (`missing_receiving_order_id`).
3. `parseManual(parsed)` — qty validation bubbles as error result.
4. Receiving candidates: order must be `in_hand`, exact normalized partNo match, `available >= qty`, ordered by (normalized) date_code then lot_code. **available uses AllocationDistributor** (the web inlines the CTE; we compute via the distributor in the repository and filter in Kotlin — normalization of part/date/lot also happens in Kotlin per locked decision 2).
5. No receiving candidates → `none`. First candidate; `qty > available` → `none`.
6. Picking candidates: `status != 'finished'`, remaining = `qty - picked_qty - unboxed packages` > 0 and `>= scan qty`, order linked to this receiving order via allocations (`EXISTS`); pinned `pickingItemId` filters. None → `none`.
7. One picking candidate → `single`; more → `multiple`. Receiving flow always uses `confirmSingleMatch = true` (the UI always opens the review dialog — Task 15).
8. Apply (Task 10's repository): re-validates (`invalid_quantity_to_apply`, `quantity_not_available_receiving`, `quantity_exceeds_picking_need`) then `applyOcrPick`.

- [ ] **Step 1: Write the failing test**

`ScanMatcherTest.kt`: two layers.

Layer 1 — pure matcher tests ported from `apps/web/tests/scanMatchers.test.ts` (receiving cases only; skip picking/put-away/measuring/goods-verify cases — those are later phases). Open the web file and port each receiving case with identical fixture data; the matcher must be callable with in-memory candidate lists (constructor-injected provider lambdas) so these tests need no DB.

Layer 2 — seeded-DB repository tests (`ScanRepositorySeededTest` in the same file):

```kotlin
@Test fun `findReceivingCandidates returns in_hand items with available >= qty, FIFO ordered`() = runBlocking {
    // seeded in_hand order + part with stock (from seed.sql)
    val candidates = repo.findReceivingCandidates(orderId, "PARTNO", qty = 10)
    assertTrue(candidates.isNotEmpty())
    assertTrue(candidates.all { it.availableQty >= 10 })
    // date/lot ordering matches web ORDER BY date_code, lot_code (normalized)
}

@Test fun `findReceivingCandidates empty for pending order or unknown part`() = runBlocking { ... }

@Test fun `findPickingCandidates excludes finished and orders not linked to this receiving order`() = runBlocking { ... }

@Test fun `matchReceiving end to end - single match`() = runBlocking {
    val result = matcher.matchReceiving(
        ScanMatcher.ReceivingContext(receivingOrderId = orderId, pickingItemId = null),
        ScanPrimitives.OcrInput(partNo = "part", dateCode = "", lotCode = "", coo = "", cow = "", qty = "10"),
        actorId = ACTOR,
    )
    assertTrue(result is ScanMatcher.MatchResult.Single)
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./gradlew :app:testDebugUnitTest --tests "*ScanMatcher*"
```

- [ ] **Step 3: Add candidate queries to ScanDao**

```kotlin
/** Raw receiving candidate rows; normalization + available-qty filtering happen in Kotlin. */
@Query(
    """
    SELECT rii.id AS receiving_invoice_item_id, p.id AS part_id, p.part_no,
           ri.invoice_no, rii.date_code, rii.lot_code, rii.coo, rii.cow,
           rii.received_qty, rii.picked_qty, rii.put_away_qty
    FROM receiving_orders ro
    JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    JOIN parts p ON p.id = rii.part_id
    WHERE ro.id = :receivingOrderId AND ro.status = 'in_hand'
    """
)
fun receivingCandidateRows(receivingOrderId: String): List<ReceivingCandidateRow>

/** Raw picking candidate rows; remaining-qty math mirrored from the web (unboxed packages subquery). */
@Query(
    """
    SELECT DISTINCT
      po.id AS picking_order_id, po.ref_no AS picking_order_ref_no,
      pi.id AS picking_item_id, pi.part_id, po.ship_to,
      pi.qty AS required_qty, pi.picked_qty,
      COALESCE((
        SELECT SUM(pp.qty) FROM picking_packages pp
        WHERE pp.picking_item_id = pi.id AND pp.shipping_box_id IS NULL
      ), 0) AS scanned_not_boxed_qty
    FROM picking_items pi
    JOIN picking_orders po ON po.id = pi.picking_order_id
    WHERE pi.part_id = :partId AND po.status != 'finished'
      AND EXISTS (
        SELECT 1 FROM picking_items pi2
        JOIN allocations a ON a.picking_item_id = pi2.id
        WHERE pi2.picking_order_id = po.id AND a.receiving_order_id = :receivingOrderId
      )
    ORDER BY po.ref_no
    """
)
fun pickingCandidateRows(receivingOrderId: String, partId: String): List<PickingCandidateRow>
```

Row data classes (`ReceivingCandidateRow`, `PickingCandidateRow`) with `@ColumnInfo` snake_case mappings, in the same file.

- [ ] **Step 4: Write ScanMatcher + ScanRepository**

`apps/android/app/src/main/java/com/docpal/warehousepda/domain/scan/ScanMatcher.kt`:

```kotlin
package com.docpal.warehousepda.domain.scan

import com.docpal.warehousepda.domain.LocalizedException

/** Port of useScanMatchers.matchReceiving (receiving task only; other tasks arrive in later phases). */
class ScanMatcher(
    private val receivingCandidates: suspend (receivingOrderId: String, partNo: String, qty: Int) -> List<ReceivingCandidate>,
    private val pickingCandidates: suspend (receivingOrderId: String, partId: String, qty: Int) -> List<PickingCandidate>,
) {

    data class ReceivingCandidate(
        val receivingInvoiceItemId: String,
        val partId: String,
        val partNo: String,
        val dateCode: String?,
        val lotCode: String?,
        val coo: String?,
        val cow: String?,
        val availableQty: Int,
    )

    data class PickingCandidate(
        val pickingOrderId: String,
        val pickingOrderRefNo: String,
        val pickingItemId: String,
        val partId: String,
        val shipTo: String?,
        val requiredQty: Int,
        val pickedQty: Int,
        val remainingQty: Int,
    )

    data class ReceivingContext(
        val receivingOrderId: String?,
        val pickingItemId: String?,   // pinned item filter
    )

    data class MatchedRecord(val receiving: ReceivingCandidate, val picking: PickingCandidate)

    sealed class MatchResult {
        data class Single(val record: MatchedRecord) : MatchResult()
        data class Multiple(val records: List<MatchedRecord>) : MatchResult()
        object None : MatchResult()
        data class Error(val key: String) : MatchResult()
    }

    suspend fun matchReceiving(
        ctx: ReceivingContext,
        parsed: ScanPrimitives.OcrInput,
        actorId: String?,
    ): MatchResult {
        try {
            if (actorId == null) return MatchResult.Error("operator_not_signed_in")
            val receivingOrderId = ctx.receivingOrderId ?: return MatchResult.Error("missing_receiving_order_id")
            val p = ScanPrimitives.parseManual(parsed)

            val receivingList = receivingCandidates(receivingOrderId, p.partNo, p.qty)
            if (receivingList.isEmpty()) return MatchResult.None
            val receiving = receivingList.first()
            if (p.qty > receiving.availableQty) return MatchResult.None

            var pickingList = pickingCandidates(receivingOrderId, receiving.partId, p.qty)
                .filter { it.remainingQty >= p.qty }
            ctx.pickingItemId?.let { pinned ->
                pickingList = pickingList.filter { it.pickingItemId == pinned }
            }
            if (pickingList.isEmpty()) return MatchResult.None

            val records = pickingList.map { MatchedRecord(receiving, it) }
            return if (records.size == 1) MatchResult.Single(records.first()) else MatchResult.Multiple(records)
        } catch (e: LocalizedException) {
            return MatchResult.Error(e.code)
        } catch (e: Exception) {
            return MatchResult.Error("unknown_match_failed")
        }
    }
}
```

`apps/android/app/src/main/java/com/docpal/warehousepda/data/ScanRepository.kt` (implements the two provider lambdas for AppContainer):

```kotlin
package com.docpal.warehousepda.data

import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.AllocationDistributor
import com.docpal.warehousepda.domain.scan.ScanMatcher
import com.docpal.warehousepda.domain.scan.ScanPrimitives
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Candidate queries for scan matching (port of db/ocrPicking.ts find functions). */
class ScanRepository(private val db: AppDatabase) {

    private val scanDao get() = db.scanDao()
    private val receivingDao get() = db.receivingDao()

    suspend fun findReceivingCandidates(
        receivingOrderId: String, normalizedPartNo: String, qty: Int,
    ): List<ScanMatcher.ReceivingCandidate> = withContext(Dispatchers.IO) {
        val rows = scanDao.receivingCandidateRows(receivingOrderId)
        val order = receivingDao.orderById(receivingOrderId) ?: return@withContext emptyList()
        val totals = receivingDao.orderAllocationTotals()
            .associate { (it.receivingOrderId to it.partId) to it.totalQty }
        val unboxed = receivingDao.unboxedPutAwayScanTotals().associate { it.itemId to it.qty }
        val distributorItems = rows.map {
            AllocationDistributor.InvoiceItemRow(
                id = it.receivingInvoiceItemId, partId = it.partId,
                receivingOrderId = receivingOrderId,
                grossQty = it.receivedQty - it.pickedQty - it.putAwayQty,
                deliveryDate = order.deliveryDate, invoiceNo = it.invoiceNo,
                dateCode = it.dateCode,
            )
        }
        val availability = AllocationDistributor.distribute(distributorItems, totals, unboxed)
        rows.mapNotNull { row ->
            if (ScanPrimitives.normalize(row.partNo) != normalizedPartNo) return@mapNotNull null
            val available = availability[row.receivingInvoiceItemId]?.availableQty ?: return@mapNotNull null
            if (available < qty) return@mapNotNull null
            ScanMatcher.ReceivingCandidate(
                receivingInvoiceItemId = row.receivingInvoiceItemId,
                partId = row.partId, partNo = row.partNo,
                dateCode = row.dateCode?.let { ScanPrimitives.normalizeCode(it) },
                lotCode = row.lotCode?.let { ScanPrimitives.normalizeCode(it) },
                coo = row.coo?.let { ScanPrimitives.normalize(it) },
                cow = row.cow?.let { ScanPrimitives.normalize(it) },
                availableQty = available,
            )
        }.sortedWith(compareBy({ it.dateCode == null }, { it.dateCode ?: "" }, { it.lotCode == null }, { it.lotCode ?: "" }))
    }

    suspend fun findPickingCandidates(
        receivingOrderId: String, partId: String, qty: Int,
    ): List<ScanMatcher.PickingCandidate> = withContext(Dispatchers.IO) {
        scanDao.pickingCandidateRows(receivingOrderId, partId).mapNotNull { row ->
            val remaining = row.requiredQty - row.pickedQty - row.scannedNotBoxedQty
            if (remaining <= 0) return@mapNotNull null
            ScanMatcher.PickingCandidate(
                pickingOrderId = row.pickingOrderId,
                pickingOrderRefNo = row.pickingOrderRefNo,
                pickingItemId = row.pickingItemId,
                partId = row.partId, shipTo = row.shipTo,
                requiredQty = row.requiredQty, pickedQty = row.pickedQty,
                remainingQty = remaining,
            )
        }
    }
}
```

Candidate ordering note: web `findReceivingCandidates` normalizes date/lot codes in SQL then `ORDER BY date_code, lot_code` (Postgres ASC defaults to NULLS LAST). The port sorts normalized values with nulls last via the `(it == null)` keys above.

AppContainer wiring:

```kotlin
val scanRepository by lazy { ScanRepository(db) }
val scanMatcher by lazy {
    ScanMatcher(
        receivingCandidates = scanRepository::findReceivingCandidates,
        pickingCandidates = scanRepository::findPickingCandidates,
    )
}
```

- [ ] **Step 5: Run tests — verify PASS**

```bash
./gradlew :app:testDebugUnitTest --tests "*ScanMatcher*"
```

- [ ] **Step 6: Commit**

```bash
git add apps/android && git commit -m "android phase1: scan candidates + matchReceiving"
```

---

## Task 10: PickingRepository — applyOcrPick, scan-to-package, box operations

**Files:**
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/data/db/PickingDao.kt` (queries below)
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/PickingRepository.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/AppContainer.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/PickingRepositoryTest.kt`

Sources of truth: `apps/web/db/ocrPicking.ts` (`applyOcrPick` line 253), `apps/web/db/picking.ts` (`scanAllocationToPackage` line 132, `removeScannedPackage` line 294, `createShippingBoxForPickingOrder` line 552, `addPackageToBox` line 654, `addAllUnboxedPackagesToBox` line 715, `removePackageFromBox` line 748, `maybeAutoFinishPickingOrder` line 795, `refreshPickingItemPickedQty` line 632), `apps/web/utils/ids.ts` (box id generation).

This is the largest domain task. Port function-by-function with identical error keys and write order. Key behaviors:

**applyOcrPick(receivingOrderId, pickingItemId, qty, dateCode, lotCode, coo, cow, actorId)** — one transaction:
1. qty positive int (`qty_must_be_positive_integer`), actorId non-empty (`actor_required`).
2. receiving order exists (`receiving_order_not_found`) and `in_hand` (`receiving_order_not_in_hand`).
3. picking item exists (`picking_item_not_found`); part must appear in the receiving order (`receiving_picking_part_mismatch`).
4. `remaining = item.qty - pickedQty - unboxed packages`; qty > remaining → `quantity_exceeds_picking_need`.
5. Existing coarse allocations (receiving_order_id + picking_item_id, qty > 0, ordered by id): total them.
6. Order+part availability: `physical - reservedByOthers - unboxed` (reservedByOthers = allocations of OTHER picking items for this order+part); qty > available → `quantity_not_available_receiving`.
7. If `qty > existingTotal`: `left = qty - existingTotal`; `unallocatedDemand = item.qty - pickedQty - allocatedQty - scannedNotBoxed`; left > demand → `quantity_exceeds_unallocated_picking_need`; else insert coarse allocation + `picking_items.allocated_qty += left`.
8. FIFO split of `qty` across the order's invoice items for the part (order: delivery_date NULLS LAST, invoice_no, date_code NULLS LAST; available per item via distributor EXCLUDING this picking item's allocation — web `allocationsCte(pickingItemId)`); leftover → `quantity_not_available_receiving`.
9. Consume coarse allocations FIFO by id: partial → decrement, full → delete.
10. Create one receiving-area lot (`shelf_code`/`box_id` null, `total_qty = allocated_qty = qty`) + one `inventory_lot_sources` row per portion + one lot allocation; call `scanAllocationToPackage(lotAllocationId, qty, actorId)` inside the same transaction.

**scanAllocationToPackage(allocationId, qty, actorId)** — allocation exists (`allocation_not_found`), `0 < qty <= allocation.qty` (`invalid_scan_quantity`); order status `issue` → `picking_order_has_open_issue`; `pickedQty + scannedNotBoxed + qty > item.qty` → `scan_quantity_exceeds_required`; lot path only (`allocation_has_no_source` otherwise): `lot.allocatedQty < qty` → `insufficient_allocated_quantity`, `lot.totalQty < qty` → `insufficient_lot_quantity`; decrement lot total+allocated; receiving-area lot: walk sources by id, each `apply = min(remaining, source.qty)` → `receiving_invoice_items.picked_qty += apply`, source qty -= apply (sum < qty → `insufficient_source_quantity`), then `tryMarkClear` per affected receiving order; allocation qty -= qty (never deleted); `picking_items.allocated_qty -= qty`; insert `picking_packages` (source_type `inventory_lot`, source_id = lot id, lot's date/lot/coo/cow, shipping_box_id null); transition log `picking_item` picking→scanned with metadata `{allocationId, qty, packageId}`. Note: `picked_qty` on picking_items is NOT incremented here — only when boxed (refreshPickingItemPickedQty counts boxed packages).

**removeScannedPackage(packageId, actorId)** — actor required; pkg exists (`package_not_found`); `shippingBoxId` set → `package_already_in_box`; order `issue` → `picking_order_has_open_issue`; reverse of scan: lot total+allocated += qty; receiving-area lot: restore first source fully (web loop restores `remaining` into the first source row and decrements that item's picked_qty — port the loop as written); allocation (lot+item) qty += qty or re-insert; `picking_items.allocated_qty += qty`; delete package; log scanned→removed `{packageId, qty}`; `refreshPickingItemPickedQty`; `tryMarkInHand` on the receiving order (via source → invoice).

**createShippingBoxForPickingOrder(pickingOrderId, actorId)** — order exists (`picking_order_not_found`), not finished (`picking_order_already_finished`), not issue (`picking_order_has_open_issue`); box id = `BOX-HK1-{ISOweek}{2-digit-year}{6-digit seq}` — port `getLocationBoxIdPrefix`/`generateLocationBoxId` from `apps/web/utils/ids.ts` (ISO week: `java.time.LocalDate.now().get(IsoFields.WEEK_OF_WEEK_BASED_YEAR)`; existing ids query `WHERE id LIKE 'BOX-HK1-wwee%'`); insert box (status open) + log (shipping_box, null→open, metadata `{pickingOrderId}`).

**addPackageToBox(packageId, boxId, actorId, skipAutoFinish=false)** — validations in web order (`package_not_found`, `package_already_in_box`, `box_not_found`, `box_is_not_open`, `shipping_box_not_associated`, order issue/finished, `package_does_not_belong_to_picking_order`); set shipping_box_id; `refreshPickingItemPickedQty` (picked_qty = sum of BOXED packages); log scanned→boxed `{packageId, shippingBoxId, qty}`; unless skipAutoFinish → `maybeAutoFinishPickingOrder`.

**addAllUnboxedPackagesToBox(boxId, actorId)** — box validations; for each unboxed package of the box's picking order call addPackageToBox(skipAutoFinish=true); then one `maybeAutoFinishPickingOrder`; return count.

**removePackageFromBox(packageId, actorId)** — pkg in box (`package_not_in_box`); box open (`box_is_not_open`); order not issue; set shipping_box_id null + verified false; refresh; log boxed→scanned `{packageId, shippingBoxId, qty}`.

**maybeAutoFinishPickingOrder(pickingOrderId, actorId)** — order exists, not finished, has items; all items `picked_qty >= qty` → status finished + updated_at; insert `measuring_tasks` (pending); `shipping_boxes.measuring_task_id = task.id` for the order's boxes; log picking→finished metadata `{auto: true}`.

- [ ] **Step 1: Write the failing test**

`PickingRepositoryTest.kt` — seeded DB (same setup as before). Scenarios (build from real seed rows; a seeded in_hand receiving order with a linked pending/picking picking order exists — verify via seed.sql before writing expectations):

```kotlin
@Test fun `applyOcrPick creates package, lot, sources and consumes allocation`() = runBlocking {
    // arrange: seeded receiving order in_hand, part P, picking item I with a coarse allocation
    repo.applyOcrPick(orderId, itemId, qty = 10, dateCode = "2406", lotCode = "L1", coo = "MY", cow = null, actorId = ACTOR)
    // assert: one unboxed package (qty 10, source_type inventory_lot, date/lot/coo set)
    // assert: lot total_qty = 0, allocated_qty = 0 after scan (created with 10, consumed 10)
    // assert: invoice item picked_qty increased by 10 (via sources)
    // assert: picking item allocated_qty decreased appropriately; picked_qty still 0 (not boxed)
    // assert: transition log picking->scanned exists with metadata containing packageId
}

@Test fun `applyOcrPick rejects qty above remaining and above availability`() = runBlocking {
    // qty > remaining -> quantity_exceeds_picking_need
    // qty within remaining but beyond receiving availability -> quantity_not_available_receiving
}

@Test fun `applyOcrPick rejects wrong part and non in_hand order`() = runBlocking {
    // keys: receiving_picking_part_mismatch, receiving_order_not_in_hand
}

@Test fun `applyOcrPick tops up coarse allocation when scan exceeds existing`() = runBlocking {
    // existing allocation qty 5, scan 10 -> new coarse allocation 5 inserted,
    // both consumed, single package of 10 created.
}

@Test fun `addPackageToBox increments picked qty; remove reverts`() = runBlocking {
    // after applyOcrPick: create box, addPackageToBox -> picked_qty == 10, log scanned->boxed
    // removePackageFromBox -> picked_qty == 0, log boxed->scanned
}

@Test fun `addAllUnboxedPackagesToBox boxes everything and auto-finishes order`() = runBlocking {
    // picking order whose every item becomes fully boxed -> status finished,
    // measuring_tasks row created, shipping_boxes.measuring_task_id set, log {auto:true}
}

@Test fun `removeScannedPackage reverses scan and restores allocation`() = runBlocking {
    // after applyOcrPick: removeScannedPackage -> package gone, invoice item picked_qty back,
    // allocation qty restored, item allocated_qty restored, log scanned->removed
}

@Test fun `createShippingBox generates sequential BOX-HK1 ids`() = runBlocking {
    // first box ends with 000001, second 000002 (same ISO week)
}

@Test fun `validation errors match web keys`() = runBlocking {
    // box_is_not_open, package_already_in_box, package_does_not_belong_to_picking_order,
    // picking_order_has_open_issue, scan_quantity_exceeds_required
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./gradlew :app:testDebugUnitTest --tests "*PickingRepositoryTest"
```

- [ ] **Step 3: Add queries to PickingDao**

```kotlin
@Query("SELECT * FROM allocations WHERE id = :id")
fun allocationById(id: String): AllocationEntity?

@Query(
    """
    SELECT * FROM allocations
    WHERE receiving_order_id = :orderId AND picking_item_id = :itemId AND qty > 0
    ORDER BY id
    """
)
fun coarseAllocations(orderId: String, itemId: String): List<AllocationEntity>

@Query("SELECT * FROM allocations WHERE inventory_lot_id = :lotId AND picking_item_id = :itemId LIMIT 1")
fun allocationByLotAndItem(lotId: String, itemId: String): AllocationEntity?

@Query("UPDATE allocations SET qty = qty - :qty WHERE id = :id")
fun decreaseAllocationQty(id: String, qty: Int)

@Query("UPDATE allocations SET qty = qty + :qty WHERE id = :id")
fun increaseAllocationQty(id: String, qty: Int)

@Query("DELETE FROM allocations WHERE id = :id")
fun deleteAllocation(id: String)

@Query(
    """
    SELECT COALESCE(SUM(qty), 0) FROM picking_packages
    WHERE picking_item_id = :itemId AND shipping_box_id IS NULL
    """
)
fun unboxedPackageQty(itemId: String): Int

@Query(
    """
    SELECT COALESCE(SUM(qty), 0) FROM picking_packages
    WHERE picking_item_id = :itemId AND shipping_box_id IS NOT NULL
    """
)
fun boxedPackageQty(itemId: String): Int

@Query(
    """
    SELECT 1 FROM receiving_orders ro
    JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    WHERE ro.id = :orderId AND rii.part_id = :partId LIMIT 1
    """
)
fun partInReceivingOrder(orderId: String, partId: String): Long?

/** physical / reserved-by-others / unboxed for an order+part (web applyOcrPick availability query). */
@Query(
    """
    SELECT
      COALESCE(SUM(rii.received_qty - rii.picked_qty - rii.put_away_qty), 0) AS physical_qty,
      COALESCE((
        SELECT SUM(a.qty) FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE a.receiving_order_id = :orderId AND pi.part_id = :partId
          AND a.picking_item_id != :pickingItemId
      ), 0) AS reserved_by_others,
      COALESCE((
        SELECT SUM(pas.qty) FROM put_away_scans pas
        JOIN receiving_invoice_items rii2 ON rii2.id = pas.receiving_invoice_item_id
        JOIN receiving_invoices ri2 ON ri2.id = rii2.receiving_invoice_id
        WHERE ri2.receiving_order_id = :orderId AND rii2.part_id = :partId
          AND pas.shelf_box_id IS NULL
      ), 0) AS unboxed_qty
    FROM receiving_orders ro
    JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    WHERE ro.id = :orderId AND rii.part_id = :partId
    """
)
fun receivingAvailabilityForScan(orderId: String, partId: String, pickingItemId: String): ScanAvailabilityRow

/** FIFO invoice items for the split (web invoiceItems query in applyOcrPick). */
@Query(
    """
    SELECT rii.id AS item_id, ri.invoice_no, rii.received_qty, rii.picked_qty, rii.put_away_qty, rii.date_code
    FROM receiving_orders ro
    JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    WHERE ro.id = :orderId AND rii.part_id = :partId
    ORDER BY (ro.delivery_date IS NULL), ro.delivery_date, ri.invoice_no, (rii.date_code IS NULL), rii.date_code
    """
)
fun fifoInvoiceItemsForScan(orderId: String, partId: String): List<FifoItemRow>

@Query("SELECT * FROM inventory_lots WHERE id = :id")
fun lotById(id: String): InventoryLotEntity?

@Query("SELECT * FROM inventory_lot_sources WHERE inventory_lot_id = :lotId ORDER BY id")
fun lotSources(lotId: String): List<InventoryLotSourceEntity>

@Query("UPDATE inventory_lots SET total_qty = total_qty - :qty, allocated_qty = allocated_qty - :qty WHERE id = :id")
fun decreaseLotQtys(id: String, qty: Int)

@Query("UPDATE inventory_lots SET total_qty = total_qty + :qty, allocated_qty = allocated_qty + :qty WHERE id = :id")
fun increaseLotQtys(id: String, qty: Int)

@Query("UPDATE inventory_lot_sources SET qty = qty - :qty WHERE id = :id")
fun decreaseLotSourceQty(id: String, qty: Int)

@Query("UPDATE inventory_lot_sources SET qty = qty + :qty WHERE id = :id")
fun increaseLotSourceQty(id: String, qty: Int)

@Query("UPDATE receiving_invoice_items SET picked_qty = picked_qty + :qty WHERE id = :id")
fun increaseItemPickedQty(id: String, qty: Int)

@Query("UPDATE receiving_invoice_items SET picked_qty = picked_qty - :qty WHERE id = :id")
fun decreaseItemPickedQty(id: String, qty: Int)

@Query("UPDATE picking_items SET picked_qty = :qty WHERE id = :id")
fun setItemPickedQty(id: String, qty: Int)

@Query("SELECT receiving_order_id FROM receiving_invoices ri JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id WHERE rii.id = :itemId")
fun orderIdOfInvoiceItem(itemId: String): String?

@Query("SELECT * FROM picking_packages WHERE id = :id")
fun packageById(id: String): PickingPackageEntity?

@Query("SELECT * FROM picking_packages WHERE picking_order_id = :orderId AND shipping_box_id IS NULL")
fun unboxedPackagesOfOrder(orderId: String): List<PickingPackageEntity>

@Query("UPDATE picking_packages SET shipping_box_id = :boxId WHERE id = :id")
fun assignPackageToBox(id: String, boxId: String)

@Query("UPDATE picking_packages SET shipping_box_id = NULL, verified = 0 WHERE id = :id")
fun unassignPackageFromBox(id: String)

@Query("DELETE FROM picking_packages WHERE id = :id")
fun deletePackage(id: String)

@Query("SELECT * FROM shipping_boxes WHERE id = :id")
fun boxById(id: String): ShippingBoxEntity?

@Query("SELECT id FROM shipping_boxes WHERE id LIKE :prefix || '%'")
fun boxIdsWithPrefix(prefix: String): List<String>

@Query("UPDATE picking_orders SET status = :status, updated_at = :now WHERE id = :id")
fun updatePickingOrderStatus(id: String, status: String, now: Long)

@Query("UPDATE shipping_boxes SET measuring_task_id = :taskId WHERE picking_order_id = :orderId")
fun assignBoxesToMeasuringTask(orderId: String, taskId: String)

@Insert fun insertLot(lot: InventoryLotEntity)
@Insert fun insertLotSource(source: InventoryLotSourceEntity)
@Insert fun insertPackage(pkg: PickingPackageEntity)
@Insert fun insertBox(box: ShippingBoxEntity)
@Insert fun insertMeasuringTask(task: MeasuringTaskEntity)
@Insert fun insertLog(log: TransitionLogEntity)
```

Row data classes `ScanAvailabilityRow(physicalQty, reservedByOthers, unboxedQty)` and `FifoItemRow(itemId, invoiceNo, receivedQty, pickedQty, putAwayQty, dateCode)` with `@ColumnInfo` mappings, same file.

- [ ] **Step 4: Write PickingRepository**

`apps/android/app/src/main/java/com/docpal/warehousepda/domain/PickingRepository.kt`. Constructor: `(db: AppDatabase, receivingRepository: ReceivingRepository)` with `private val pickingDao get() = db.pickingDao()` and `private val receivingDao get() = db.receivingDao()`. All public functions `suspend`, wrapped in `withContext(Dispatchers.IO)`, mutations inside `db.runInTransaction { }`. Port the functions per the behavior spec above. Full code for the two trickiest:

```kotlin
suspend fun applyOcrPick(
    receivingOrderId: String,
    pickingItemId: String,
    qty: Int,
    dateCode: String?,
    lotCode: String?,
    coo: String?,
    cow: String?,
    actorId: String,
) = withContext(Dispatchers.IO) {
    if (qty <= 0) throw LocalizedException("qty_must_be_positive_integer")
    if (actorId.isEmpty()) throw LocalizedException("actor_required")
    db.runInTransaction {
        val ro = receivingDao.orderById(receivingOrderId)
            ?: throw LocalizedException("receiving_order_not_found")
        if (ro.status != "in_hand") throw LocalizedException("receiving_order_not_in_hand")
        val item = pickingDao.pickingItemById(pickingItemId)
            ?: throw LocalizedException("picking_item_not_found")
        if (pickingDao.partInReceivingOrder(receivingOrderId, item.partId) == null) {
            throw LocalizedException("receiving_picking_part_mismatch")
        }
        val scannedNotBoxed = pickingDao.unboxedPackageQty(pickingItemId)
        val remaining = item.qty - item.pickedQty - scannedNotBoxed
        if (qty > remaining) throw LocalizedException("quantity_exceeds_picking_need")

        val existing = pickingDao.coarseAllocations(receivingOrderId, pickingItemId)
        val existingTotal = existing.sumOf { it.qty }

        val availability = pickingDao.receivingAvailabilityForScan(receivingOrderId, item.partId, pickingItemId)
        val availableForScan = availability.physicalQty - availability.reservedByOthers - availability.unboxedQty
        if (qty > availableForScan) throw LocalizedException("quantity_not_available_receiving")

        val left = maxOf(0, qty - existingTotal)
        if (left > 0) {
            val unallocatedDemand = item.qty - item.pickedQty - item.allocatedQty - scannedNotBoxed
            if (left > unallocatedDemand) throw LocalizedException("quantity_exceeds_unallocated_picking_need")
            pickingDao.insertAllocation(
                AllocationEntity(
                    id = UUID.randomUUID().toString(),
                    pickingItemId = pickingItemId, inventoryLotId = null,
                    receivingOrderId = receivingOrderId, qty = left, remark = null,
                )
            )
            pickingDao.increaseItemAllocated(pickingItemId, left)
        }

        // FIFO split across invoice items, excluding this picking item's own allocation
        // (web allocationsCte(pickingItemId)): recompute distributor without this item's totals.
        val fifoRows = pickingDao.fifoInvoiceItemsForScan(receivingOrderId, item.partId)
        val totalsExcludingSelf = receivingDao.orderAllocationTotals()
            .filter { it.receivingOrderId == receivingOrderId && it.partId == item.partId }
            .associate { (it.receivingOrderId to it.partId) to it.totalQty }
            .toMutableMap()
        val selfKey = receivingOrderId to item.partId
        val selfCoarse = pickingDao.coarseAllocations(receivingOrderId, pickingItemId).sumOf { it.qty }
        totalsExcludingSelf[selfKey] = (totalsExcludingSelf[selfKey] ?: 0) - selfCoarse
        val unboxed = receivingDao.unboxedPutAwayScanTotals().associate { it.itemId to it.qty }
        val distributorItems = fifoRows.map {
            AllocationDistributor.InvoiceItemRow(
                id = it.itemId, partId = item.partId, receivingOrderId = receivingOrderId,
                grossQty = it.receivedQty - it.pickedQty - it.putAwayQty,
                deliveryDate = ro.deliveryDate, invoiceNo = it.invoiceNo, dateCode = it.dateCode,
            )
        }
        val availabilityByItem = AllocationDistributor.distribute(distributorItems, totalsExcludingSelf, unboxed)

        val portions = ArrayList<Pair<String, Int>>()
        var remainingScan = qty
        for (row in fifoRows) {
            if (remainingScan <= 0) break
            val available = availabilityByItem[row.itemId]?.availableQty ?: 0
            if (available <= 0) continue
            val use = minOf(remainingScan, available)
            portions.add(row.itemId to use)
            remainingScan -= use
        }
        if (remainingScan > 0) throw LocalizedException("quantity_not_available_receiving")

        // Consume coarse allocations FIFO by id.
        var toConsume = qty
        val reloaded = pickingDao.coarseAllocations(receivingOrderId, pickingItemId)
        var index = 0
        while (toConsume > 0) {
            val allocation = reloaded.getOrNull(index) ?: throw LocalizedException("allocation_not_found")
            val take = minOf(toConsume, allocation.qty)
            if (take < allocation.qty) pickingDao.decreaseAllocationQty(allocation.id, take)
            else pickingDao.deleteAllocation(allocation.id)
            toConsume -= take
            index++
        }

        // One receiving-area lot + sources + lot allocation, then scan into one package.
        val lotId = UUID.randomUUID().toString()
        pickingDao.insertLot(
            InventoryLotEntity(
                id = lotId, partId = item.partId, dateCode = dateCode, lotCode = lotCode,
                coo = coo, cow = cow, shelfCode = null, boxId = null,
                totalQty = qty, allocatedQty = qty, availableQty = 0,
            )
        )
        for ((itemId, portionQty) in portions) {
            pickingDao.insertLotSource(
                InventoryLotSourceEntity(
                    id = UUID.randomUUID().toString(),
                    inventoryLotId = lotId, receivingInvoiceItemId = itemId, qty = portionQty,
                )
            )
        }
        val lotAllocationId = UUID.randomUUID().toString()
        pickingDao.insertAllocation(
            AllocationEntity(
                id = lotAllocationId, pickingItemId = pickingItemId,
                inventoryLotId = lotId, receivingOrderId = null, qty = qty, remark = null,
            )
        )
        scanAllocationToPackageInternal(lotAllocationId, qty, actorId)
    }
}

/** Web scanAllocationToPackage; tx-internal (also called standalone via public wrapper). */
internal fun scanAllocationToPackageInternal(allocationId: String, qty: Int, actorId: String): String {
    val allocation = pickingDao.allocationById(allocationId) ?: throw LocalizedException("allocation_not_found")
    if (qty <= 0 || qty > allocation.qty) throw LocalizedException("invalid_scan_quantity")
    val item = pickingDao.pickingItemById(allocation.pickingItemId)
        ?: throw LocalizedException("picking_item_not_found")
    val order = pickingDao.pickingOrderById(item.pickingOrderId)
    if (order?.status == "issue") throw LocalizedException("picking_order_has_open_issue")
    val scannedNotBoxed = pickingDao.unboxedPackageQty(item.id)
    if (item.pickedQty + scannedNotBoxed + qty > item.qty) {
        throw LocalizedException("scan_quantity_exceeds_required")
    }
    val lotId = allocation.inventoryLotId ?: throw LocalizedException("allocation_has_no_source")
    val lot = pickingDao.lotById(lotId) ?: throw LocalizedException("inventory_lot_not_found")
    if (lot.allocatedQty < qty) throw LocalizedException("insufficient_allocated_quantity")
    if (lot.totalQty < qty) throw LocalizedException("insufficient_lot_quantity")
    pickingDao.decreaseLotQtys(lot.id, qty)

    if (lot.shelfCode == null && lot.boxId == null) {
        val sources = pickingDao.lotSources(lot.id)
        val totalSourceQty = sources.sumOf { it.qty }
        if (totalSourceQty < qty) throw LocalizedException("insufficient_source_quantity")
        var remaining = qty
        val affectedItemIds = ArrayList<String>()
        for (source in sources) {
            if (remaining <= 0) break
            val apply = minOf(remaining, source.qty)
            pickingDao.increaseItemPickedQty(source.receivingInvoiceItemId, apply)
            pickingDao.decreaseLotSourceQty(source.id, apply)
            affectedItemIds.add(source.receivingInvoiceItemId)
            remaining -= apply
        }
        val affectedOrderIds = affectedItemIds.mapNotNull { pickingDao.orderIdOfInvoiceItem(it) }.distinct()
        for (orderId in affectedOrderIds) receivingRepository.tryMarkClear(orderId, actorId)
    }

    pickingDao.decreaseAllocationQty(allocationId, qty)
    pickingDao.decreaseItemAllocated(item.id, qty)

    val packageId = UUID.randomUUID().toString()
    pickingDao.insertPackage(
        PickingPackageEntity(
            id = packageId, pickingItemId = item.id, pickingOrderId = item.pickingOrderId,
            sourceType = "inventory_lot", sourceId = lot.id, qty = qty,
            shippingBoxId = null, dateCode = lot.dateCode, lotCode = lot.lotCode,
            coo = lot.coo, cow = lot.cow, verified = false,
            createdAt = System.currentTimeMillis(),
        )
    )
    pickingDao.insertLog(
        TransitionLogEntity(
            id = UUID.randomUUID().toString(),
            entityType = "picking_item", entityId = item.id,
            fromState = "picking", toState = "scanned", actorId = actorId,
            metadata = JSONObject().apply {
                put("allocationId", allocationId); put("qty", qty); put("packageId", packageId)
            }.toString(),
            createdAt = System.currentTimeMillis(),
        )
    )
    return packageId
}
```

FIFO-split correctness note (verify in code review): the web splits over `allocationsCte(pickingItemId)` — the distributor with this picking item's allocation excluded. The code above subtracts `selfCoarse` from the order+part total, which is equivalent because the only allocations for (order, part) attributable to this picking item are its coarse allocations (its lot allocations have `receiving_order_id = NULL` and never enter the totals). Also note the web's per-item `available` uses `reserved_by_others` from the CTE which already excludes self — same result.

Port the remaining public functions per the behavior spec: `removeScannedPackage`, `createShippingBoxForPickingOrder` (with the `ids.ts` port: `generateLocationBoxId(prefix = "BOX", locationCode = "HK1", existingIds)` — ISO week via `IsoFields.WEEK_OF_WEEK_BASED_YEAR`, year `% 100`, regex `^BOX-HK1-\d{4}(\d{6})$`... careful: web regex is `^{prefix}([0-9]{6})$` where prefix includes week+year; port exactly), `addPackageToBox`, `addAllUnboxedPackagesToBox`, `removePackageFromBox`, `maybeAutoFinishPickingOrder`, `refreshPickingItemPickedQty` (private: `picked_qty = boxedPackageQty(itemId)`), plus public wrappers `scanAllocationToPackage(allocationId, qty, actorId)` (own transaction) and `materializeReceivingAllocation` (port of `apps/web/db/picking.ts` line 54 — needed by Task 15's manual materialize flow... if Task 15 does not use it, still port it: the web receiving picking tab's Scan button path relies on it for pinned scans; include it).

Wire into `AppContainer`: `val pickingRepository by lazy { PickingRepository(db, receivingRepository) }`.

- [ ] **Step 5: Run tests — verify PASS**

```bash
./gradlew :app:testDebugUnitTest --tests "*PickingRepositoryTest"
./gradlew :app:testDebugUnitTest
```

- [ ] **Step 6: Commit**

```bash
git add apps/android && git commit -m "android phase1: applyOcrPick, scan-to-package, box operations"
```

---

## Task 11: Scanner integration — launcher wrapper, CAMERA permission, hardware wedge

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/receiving/ScanLaunchers.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/domain/scan/HardwareKeyBuffer.kt`
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/domain/scan/HardwareKeyBufferTest.kt`

Phase 0 copied the scanner pipeline (`scanner/RectangleCameraActivity.java`, `RectanglePickerActivity.java`, `RectangleResultJson.java`) and declared the CAMERA permission, but nothing requests it at runtime or launches the activities. The web uses two scan inputs: camera scan (native rectangle detection + ML Kit OCR/barcodes) and the hardware scanner wedge (Bluetooth HID keyboard). Both are needed for the receiving picking tab.

- [ ] **Step 1: Write the failing HardwareKeyBuffer test**

`HardwareKeyBufferTest.kt` — port of the wedge logic in `apps/web/composables/useHardwareScanner.ts`, driven by a fake clock:

```kotlin
package com.docpal.warehousepda.domain.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HardwareKeyBufferTest {

    private class FakeClock(var now: Long = 0) : HardwareKeyBuffer.Clock {
        override fun nowMillis() = now
    }

    @Test fun `printable keys accumulate; Enter flushes`() {
        val clock = FakeClock()
        val flushed = ArrayList<String>()
        val buffer = HardwareKeyBuffer(clock, idleTimeoutMs = 300, onFlush = flushed::add)
        assertEquals(HardwareKeyBuffer.Consume.CONSUMED, buffer.onKey("A"))
        assertEquals(HardwareKeyBuffer.Consume.CONSUMED, buffer.onKey("1"))
        assertEquals(HardwareKeyBuffer.Consume.CONSUMED, buffer.onKey("Enter"))
        assertEquals(listOf("A1"), flushed)
        assertEquals("", buffer.pending)
    }

    @Test fun `Enter with empty buffer is ignored (not consumed)`() {
        val buffer = HardwareKeyBuffer(FakeClock(), 300) {}
        assertEquals(HardwareKeyBuffer.Consume.IGNORED, buffer.onKey("Enter"))
    }

    @Test fun `non-printable keys are ignored`() {
        val buffer = HardwareKeyBuffer(FakeClock(), 300) {}
        for (key in listOf("Shift", "F1", "Control", "ArrowLeft")) {
            assertEquals(HardwareKeyBuffer.Consume.IGNORED, buffer.onKey(key))
        }
        assertEquals("", buffer.pending)
    }

    @Test fun `idle timeout clears the buffer`() {
        val clock = FakeClock()
        val buffer = HardwareKeyBuffer(clock, 300) {}
        buffer.onKey("A")
        clock.now += 299
        buffer.onKey("B")          // still within idle window
        assertEquals("AB", buffer.pending)
        clock.now += 301
        buffer.onKey("C")          // previous content expired
        assertEquals("C", buffer.pending)
    }

    @Test fun `disabled buffer ignores everything`() {
        val buffer = HardwareKeyBuffer(FakeClock(), 300) {}
        buffer.enabled = false
        assertEquals(HardwareKeyBuffer.Consume.IGNORED, buffer.onKey("A"))
        assertEquals(HardwareKeyBuffer.Consume.IGNORED, buffer.onKey("Enter"))
        assertEquals("", buffer.pending)
    }
}
```

(Web also skips `event.repeat`, `isComposing`, and input-element targets — on Android the repeat/composing cases do not arrive via `onKey` as used here; input-focus skipping is handled at the call site in Task 15 by disabling the buffer while a text field has focus or a dialog is open.)

- [ ] **Step 2: Run test to verify it fails**

```bash
./gradlew :app:testDebugUnitTest --tests "*HardwareKeyBufferTest"
```

- [ ] **Step 3: Write HardwareKeyBuffer**

`apps/android/app/src/main/java/com/docpal/warehousepda/domain/scan/HardwareKeyBuffer.kt`:

```kotlin
package com.docpal.warehousepda.domain.scan

/**
 * Hardware scanner wedge buffering — port of useHardwareScanner.ts.
 * Scanners type the code as keystrokes and finish with Enter; a 300 ms idle
 * gap clears partial input. Returns CONSUMED so the caller can eat the key
 * event (web preventDefault).
 */
class HardwareKeyBuffer(
    private val clock: Clock,
    private val idleTimeoutMs: Long = 300,
    private val onFlush: (String) -> Unit,
) {
    interface Clock { fun nowMillis(): Long }

    enum class Consume { CONSUMED, IGNORED }

    var enabled: Boolean = true
    var pending: String = ""
        private set

    private var lastKeyAt: Long = 0

    fun onKey(key: String): Consume {
        if (!enabled) return Consume.IGNORED
        if (key == "Enter") {
            if (pending.isEmpty()) return Consume.IGNORED
            val value = pending
            pending = ""
            onFlush(value)
            return Consume.CONSUMED
        }
        if (key.length != 1) return Consume.IGNORED   // printable single chars only
        val now = clock.nowMillis()
        if (pending.isNotEmpty() && now - lastKeyAt > idleTimeoutMs) pending = ""
        lastKeyAt = now
        pending += key
        return Consume.CONSUMED
    }
}
```

- [ ] **Step 4: Run test — verify PASS**

```bash
./gradlew :app:testDebugUnitTest --tests "*HardwareKeyBufferTest"
```

- [ ] **Step 5: Write ScanLaunchers**

`apps/android/app/src/main/java/com/docpal/warehousepda/ui/receiving/ScanLaunchers.kt`:

Result contract (verified against the Phase 0 scanner sources): launch `RectangleCameraActivity` with extra `RectangleCameraActivity.EXTRA_MODE = RectangleCameraActivity.MODE_LABEL_SCAN`. On `RESULT_OK` the data Intent carries: `imagePath: String`, `width: Int`, `height: Int`, `rectanglesJson: String?`, `selectedRect: String?`, `text: String` (raw OCR text), `barcodes: String` (JSON array of `{"value": String, "format": String}` — format is the ML Kit numeric format as a string).

```kotlin
package com.docpal.warehousepda.ui.receiving

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.docpal.warehousepda.scanner.RectangleCameraActivity
import org.json.JSONArray

/** Parsed result of a camera label scan (see contract note above). */
data class CameraScanResult(
    val rawText: String,
    val barcodes: List<OcrBarcodeValue>,
    val imagePath: String?,
)

data class OcrBarcodeValue(val value: String, val format: String)

internal fun parseScanResult(data: Intent?): CameraScanResult? {
    if (data == null) return null
    val text = data.getStringExtra("text") ?: ""
    val imagePath = data.getStringExtra("imagePath")
    val barcodesJson = data.getStringExtra("barcodes") ?: "[]"
    val barcodes = ArrayList<OcrBarcodeValue>()
    val array = JSONArray(barcodesJson)
    for (i in 0 until array.length()) {
        val obj = array.getJSONObject(i)
        barcodes.add(OcrBarcodeValue(obj.optString("value"), obj.optString("format")))
    }
    return CameraScanResult(rawText = text, barcodes = barcodes, imagePath = imagePath)
}

/**
 * Camera-scan entry point: requests CAMERA at runtime if needed, then launches
 * RectangleCameraActivity in label-scan mode. Cancelled/failed scans are ignored.
 * Returns a `launch` function — call it from the scan FAB.
 */
@Composable
fun rememberCameraScanLauncher(onResult: (CameraScanResult) -> Unit): () -> Unit {
    val context = LocalContext.current

    val scanLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            parseScanResult(result.data)?.let(onResult)
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            scanLauncher.launch(
                Intent(context, RectangleCameraActivity::class.java)
                    .putExtra(RectangleCameraActivity.EXTRA_MODE, RectangleCameraActivity.MODE_LABEL_SCAN)
            )
        }
    }

    return remember {
        {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED
            ) {
                scanLauncher.launch(
                    Intent(context, RectangleCameraActivity::class.java)
                        .putExtra(RectangleCameraActivity.EXTRA_MODE, RectangleCameraActivity.MODE_LABEL_SCAN)
                )
            } else {
                permissionLauncher.launch(Manifest.permission.CAMERA)
            }
        }
    }
}
```

- [ ] **Step 6: Run tests + assemble check**

```bash
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

Expected: all tests PASS; debug APK builds (proves the launcher compiles against the real scanner classes).

- [ ] **Step 7: Commit**

```bash
git add apps/android && git commit -m "android phase1: camera scan launcher + hardware key buffer"
```

---

## Task 12: i18n — receiving, scan, status, and error strings in 3 locales

**Files:**
- Modify: `apps/android/app/src/main/res/values/strings.xml` (en-US)
- Modify: `apps/android/app/src/main/res/values-zh-rCN/strings.xml` (zh-CN)
- Modify: `apps/android/app/src/main/res/values-zh-rHK/strings.xml` (zh-HK)
- Modify: `apps/android/app/src/test/java/com/docpal/warehousepda/...` (extend the Phase 0 key-parity test if it exists; otherwise create `StringsParityTest.kt`)

Source of truth: `apps/web/i18n/locales/{en-US,zh-CN,zh-HK}.ts`. Values must match the web files verbatim (modulo `{param}` placeholders, which Android formats keep as `%1$s`/`%1$d` — map `{count}`→`%1$d`, `{n}`→`%1$d`, `{qty}`→`%1$d`, `{part}`→`%1$s`, `{no}`→`%1$s`, `{id}`→`%1$s`, `{status}`→`%1$s`, `{name}`→`%1$s`, `{message}`→`%1$s`).

- [ ] **Step 1: Write the failing parity test**

`StringsParityTest.kt` (Robolectric, `@Config(sdk = [34])`, `includeAndroidResources` already enabled): load `R.string` fields via reflection; for each locale (`en-US` default, `zh-rCN`, `zh-rHK`) assert the same set of string resource names resolves (no missing translations). Pattern: iterate all `R.string` fields; for each name, `getString` under each locale configuration must return a non-empty value and must not throw. If a Phase 0 parity test already exists, extend it instead of duplicating.

- [ ] **Step 2: Run test — verify current state**

```bash
./gradlew :app:testDebugUnitTest --tests "*StringsParityTest"
```

Expected: PASS on existing keys (baseline) — the test guards the additions below.

- [ ] **Step 3: Add receiving/scan/modal strings to all three locales**

Add the following keys to each locale's `strings.xml` with values from the corresponding web locale file. Android name convention: web dotted key `receiving.detail.confirmArrived` → `receiving_detail_confirm_arrived`; `labelScanReviewModal.titleManual` → `scan_review_title_manual`; `reportIssueModal.reasons.damaged` → `issue_reason_damaged`; `status.receiving.in_hand` → `status_receiving_in_hand`; `logStates.scanned` → `log_state_scanned`; `errors.<key>` → `error_<key>`; `common.<key>` → `common_<key>`; `actions.<key>` → `action_<key>`.

**receiving** (web `receiving.*`, values from `receiving` section of each locale file): `receiving_title`, `receiving_remaining` (%1$d), `receiving_detail_title`, `receiving_detail_supplier`, `receiving_detail_delivery_date`, `receiving_detail_remaining_items`, `receiving_detail_tab_receiving`, `receiving_detail_tab_picking`, `receiving_detail_confirm_arrived`, and the full `receiving_items_tab_*` set: `title`, `part`, `po_line`, `expected`, `reserved`, `picked`, `put_away`, `available`, `date_lot_coo_cow`, `confirm_mismatch`, `cancel_mismatch`, `box_id`, `mismatch_status_pending`, `mismatch_status_confirmed`, `mismatch_status_cancelled`, `edit_issue`, `report_issue`, `mismatch_not_found`, `mismatch_damaged` (%1$d), `mismatch_quality_rejection` (%1$d), `mismatch_qty_mismatch` (%1$d), `mismatch_over_shipment` (%1$d), `mismatch_wrong_part` (%1$s), `mismatch_reported`; and the full `receiving_picking_tab_*` set: `title`, `picking_order`, `status`, `required_scanned_boxed`, `allocated_lots`, `receiving_area`, `boxes`, `packages`, `select_box`, `create_box`, `creating`, `add_to_box`, `adding`, `remove_from_box`, `removing`, `remove_scanned`, `removing_scanned`, `scan`, `add_all`, `add_all_confirm` (%1$d), `hide_logs`, `show_logs`, `no_logs`.

**labelScanReviewModal** (web `labelScanReviewModal.*`): `scan_review_title_manual`, `scan_review_title_review`, `scan_review_close`, `scan_review_no_image`, `scan_review_captured_label_alt`, `scan_review_ocr_raw_text`, `scan_review_barcodes`, `scan_review_barcode_placeholder`, `scan_review_edit_subtitle`, `scan_review_part_no`, `scan_review_date_code`, `scan_review_lot_code`, `scan_review_coo`, `scan_review_cow`, `scan_review_qty`, `scan_review_placeholder_part_no`, `scan_review_placeholder_date_code`, `scan_review_placeholder_lot_code`, `scan_review_placeholder_coo`, `scan_review_placeholder_cow`, `scan_review_placeholder_qty`, `scan_review_match_single`, `scan_review_match_multiple`, `scan_review_match_n` (%1$d), `scan_review_match_none`, `scan_review_error`, `scan_review_apply`, `scan_review_applying`, `scan_review_retake`, `scan_review_cancel`, `scan_review_find_match`, `scan_review_matching`, `scan_review_match_failed`, `scan_review_apply_failed`.

**reportIssueModal** (web `reportIssueModal.*`): `issue_title_edit`, `issue_title_report`, `issue_close`, `issue_reason`, `issue_wrong_part_number`, `issue_note`, `issue_placeholder_scan_or_type`, `issue_placeholder_note`, `issue_reason_not_found`, `issue_reason_damaged`, `issue_reason_qty_mismatch`, `issue_reason_wrong_part`, `issue_reason_over_shipment`, `issue_reason_quality_rejection`, `issue_qty_placeholder_damaged`, `issue_qty_placeholder_actual_received`, `issue_qty_label_damaged`, `issue_qty_label_qty_mismatch`, `issue_qty_label_wrong_part`, `issue_qty_label_over_shipment`, `issue_qty_label_quality_rejection`, `issue_cancel`, `issue_confirm`, `issue_saving`.

**status** (web `status.*`): `status_receiving_pending`, `status_receiving_in_hand`, `status_receiving_clear`, `status_picking_pending`, `status_picking_picking`, `status_picking_finished`, `status_picking_issue`, `status_box_open`, `status_box_closed`, `status_box_verified`, `status_measuring_pending`, `status_measuring_completed`.

**logStates** (web `logStates.*`): `log_state_pending`, `log_state_in_hand`, `log_state_clear`, `log_state_picking`, `log_state_finished`, `log_state_issue`, `log_state_open`, `log_state_closed`, `log_state_verified`, `log_state_unverified`, `log_state_scanned`, `log_state_boxed`, `log_state_mismatch_reported`, `log_state_cancelled`, `log_state_completed`, `log_state_none`, `log_state_not_found`, `log_state_damaged`, `log_state_qty_mismatch`, `log_state_wrong_part`, `log_state_over_shipment`, `log_state_quality_rejection`.

**common additions** (web `common.*`, only those used by receiving screens): `common_loading`, `common_error_prefix` (%1$s), `common_no_data`, `common_search_by_ref_or_supplier`, `common_all`, `common_pending`, `common_no_supplier`, `common_no_date`, `common_item`, `common_items`, `common_invoice_title` (%1$s), `common_unboxed`, `common_locked`, `common_create_open_box_first`, `common_reported_by` (%1$s), `common_no_picking_orders_linked`, `common_no_receiving_orders`, `common_scan_success`, `common_actor_system`.

**actions additions**: `action_scan`, `action_cancel`, `action_close`, `action_confirming`, `action_put_away_remaining`, `action_view_picking_order`.

**errors**: add `error_<key>` for every i18n error key thrown by Phase 1 domain code — the complete list: `qty_must_be_positive_integer`, `operator_not_signed_in`, `missing_receiving_order_id`, `unknown_match_failed`, `invalid_quantity_to_apply`, `receiving_order_not_found`, `receiving_order_not_in_hand`, `receiving_order_already_status` (%1$s — web value contains `{status}`), `receiving_picking_part_mismatch`, `picking_item_not_found`, `quantity_exceeds_picking_need`, `quantity_not_available_receiving`, `quantity_exceeds_unallocated_picking_need`, `allocation_not_found`, `invalid_scan_quantity`, `picking_order_has_open_issue`, `scan_quantity_exceeds_required`, `insufficient_allocated_quantity`, `insufficient_lot_quantity`, `insufficient_source_quantity`, `allocation_has_no_source`, `inventory_lot_not_found`, `package_not_found`, `package_already_in_box`, `unknown_package_source_type`, `box_not_found`, `box_is_not_open`, `shipping_box_not_associated`, `package_does_not_belong_to_picking_order`, `picking_order_already_finished`, `package_not_in_box`, `actor_required`, `receiving_invoice_item_not_found`, `confirmed_mismatch_already_exists`, `pending_mismatch_already_exists`, `mismatch_qty_below_consumed_stock`, `receiving_item_mismatch_not_found`, `only_pending_mismatch_can_be_edited`, `only_reporter_can_edit_mismatch`, `only_pending_mismatch_can_be_confirmed`, `reporter_cannot_confirm_own_mismatch`, `only_pending_mismatch_can_be_cancelled`, `reporter_cannot_cancel_own_mismatch`, `mismatch_reason_required`, `not_found_mismatch_cannot_include_qty`, `quantity_must_be_non_negative_integer`, `damaged_rejected_quantity_exceeds_expected`, `quantity_must_be_greater_than_zero`, `wrong_part_number_required`, `quantity_mismatch_requires_valid_received_qty`, `computed_received_quantity_cannot_be_negative`, `unhandled_mismatch_reason`, `invalid_picking_item_id`.

For any key missing from a web locale's `errors` section, fall back to the en-US value and note it in the commit message.

- [ ] **Step 4: Run parity test + full suite**

```bash
./gradlew :app:testDebugUnitTest
```

Expected: PASS — parity across all three locales, full suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/android && git commit -m "android phase1: receiving/scan/status/error strings in 3 locales"
```

---

## Task 13: Receiving list screen + navigation wiring

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/components/StatusBadge.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/components/EmptyState.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/receiving/ReceivingListViewModel.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/receiving/ReceivingListScreen.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/navigation/AppNav.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/home/HomeScreen.kt` (receiving card navigates)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/AppContainer.kt` (factory entries)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/ui/receiving/ReceivingListViewModelTest.kt`

Web reference: `apps/web/pages/receiving/index.vue`. Behavior:
- Filter chips: All / Pending / In hand / Clear; **default filter `in_hand`**.
- Rows show: refNo, status badge, supplier name (fallback `common_no_supplier`), delivery date formatted as ISO date (epoch ms → `yyyy-MM-dd`, device timezone), "{count} remaining" badge (`receiving_remaining`, only for in_hand with remaining > 0), picking-count badge when `pendingPickingOrders > 0`.
- Client-side search over refNo + supplierName (case-insensitive contains; placeholder `common_search_by_ref_or_supplier`).
- Empty state `common_no_receiving_orders`; loading spinner while first load.
- Reload on resume: list reloads when the screen regains focus (Lifecycle `ON_RESUME`), matching the web's visibilitychange reload.
- Tap row → navigate to detail.

Status badge mapping (`useStatusBadge` port in `StatusBadge.kt`): `pending|open` → pending style (amber), `in_hand|picking` → in-hand style (blue), `finished|completed|verified|closed|clear|done` → finished style (green), `issue|danger` → danger style (red). Labels via `status_*` strings by family.

- [ ] **Step 1: Write the failing ViewModel test**

`ReceivingListViewModelTest.kt` (fake repository — extract a `ReceivingListSource` interface with `suspend fun listOrders(filter: String): List<ReceivingOrderSummary>`; `ReceivingRepository` implements it):

```kotlin
@OptIn(ExperimentalCoroutinesApi::class)
class ReceivingListViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    private class FakeSource : ReceivingListSource {
        val orders = mutableListOf<ReceivingOrderSummary>()
        val requestedFilters = ArrayList<String>()
        override suspend fun listOrders(filter: String): List<ReceivingOrderSummary> {
            requestedFilters.add(filter)
            return orders.filter { filter == "all" || it.status == filter }
        }
    }

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    @Test fun `loads in_hand by default`() = runTest {
        val source = FakeSource()
        val vm = ReceivingListViewModel(source)
        advanceUntilIdle()
        assertEquals(listOf("in_hand"), source.requestedFilters)
    }

    @Test fun `filter change reloads`() = runTest {
        val source = FakeSource()
        val vm = ReceivingListViewModel(source)
        advanceUntilIdle()
        vm.setFilter("pending")
        advanceUntilIdle()
        assertEquals(listOf("in_hand", "pending"), source.requestedFilters)
    }

    @Test fun `search filters client side by ref and supplier`() = runTest {
        val source = FakeSource().apply {
            orders += ReceivingOrderSummary("1", "RO-001", "in_hand", null, "KOA", 2, 0)
            orders += ReceivingOrderSummary("2", "RO-002", "in_hand", null, "Diotec", 1, 0)
        }
        val vm = ReceivingListViewModel(source)
        advanceUntilIdle()
        vm.setSearch("koa")
        assertEquals(listOf("RO-001"), vm.uiState.value.visibleOrders.map { it.refNo })
        vm.setSearch("002")
        assertEquals(listOf("RO-002"), vm.uiState.value.visibleOrders.map { it.refNo })
    }

    @Test fun `reload re-queries with current filter`() = runTest {
        val source = FakeSource()
        val vm = ReceivingListViewModel(source)
        advanceUntilIdle()
        vm.setFilter("all"); advanceUntilIdle()
        vm.reload(); advanceUntilIdle()
        assertEquals(listOf("in_hand", "all", "all"), source.requestedFilters)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./gradlew :app:testDebugUnitTest --tests "*ReceivingListViewModelTest"
```

- [ ] **Step 3: Write StatusBadge + ViewModel + Screen**

`StatusBadge.kt`: `@Composable fun StatusBadge(status: String, modifier: Modifier = Modifier)` rendering a small rounded label with the color mapping above; label resolved via a `statusLabelRes(family: String, status: String)` helper mapping to `R.string.status_*` (family = receiving | picking | box | measuring). `EmptyState.kt`: `@Composable fun EmptyState(message: String)` — centered muted text used for empty lists/logs.

`ReceivingListViewModel.kt`:

```kotlin
package com.docpal.warehousepda.ui.receiving

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.domain.model.ReceivingOrderSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

interface ReceivingListSource {
    suspend fun listOrders(filter: String): List<ReceivingOrderSummary>
}

data class ReceivingListUiState(
    val filter: String = "in_hand",
    val search: String = "",
    val loading: Boolean = true,
    val orders: List<ReceivingOrderSummary> = emptyList(),
) {
    val visibleOrders: List<ReceivingOrderSummary>
        get() {
            val q = search.trim().lowercase()
            if (q.isEmpty()) return orders
            return orders.filter {
                it.refNo.lowercase().contains(q) || (it.supplierName?.lowercase()?.contains(q) == true)
            }
        }
}

class ReceivingListViewModel(private val source: ReceivingListSource) : ViewModel() {

    private val _uiState = MutableStateFlow(ReceivingListUiState())
    val uiState: StateFlow<ReceivingListUiState> = _uiState.asStateFlow()

    init { reload() }

    fun setFilter(filter: String) {
        _uiState.update { it.copy(filter = filter) }
        reload()
    }

    fun setSearch(value: String) = _uiState.update { it.copy(search = value) }

    fun reload() {
        viewModelScope.launch {
            val filter = _uiState.value.filter
            _uiState.update { it.copy(loading = true) }
            val orders = source.listOrders(filter)
            _uiState.update { it.copy(loading = false, orders = orders) }
        }
    }
}
```

`ReceivingListScreen.kt`: Scaffold with TopAppBar (`receiving_title`), filter chips row (All/Pending/In hand/Clear — `common_all`, `status_receiving_pending`, `status_receiving_in_hand`, `status_receiving_clear`), search `OutlinedTextField`, `LazyColumn` of order cards. Reload on resume:

```kotlin
val lifecycleOwner = LocalLifecycleOwner.current
DisposableEffect(lifecycleOwner) {
    val observer = LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_RESUME) viewModel.reload()
    }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
}
```

Card layout per the web row: refNo + StatusBadge on the first line; supplier · date on the second; trailing badges. Delivery date formatting:

```kotlin
fun formatDate(epochMillis: Long?): String? = epochMillis?.let {
    java.time.Instant.ofEpochMilli(it).atZone(java.time.ZoneId.systemDefault()).toLocalDate().toString()
}
```

`AppNav.kt` additions:

```kotlin
object Routes {
    const val LOGIN = "login"
    const val HOME = "home"
    const val RECEIVING_LIST = "receiving"
    const val RECEIVING_DETAIL = "receiving/{orderId}"
    fun receivingDetail(orderId: String) = "receiving/$orderId"
}
```

Add `composable(Routes.RECEIVING_LIST) { ReceivingListScreen(onOrderClick = { navController.navigate(Routes.receivingDetail(it)) }) }` (detail route wired in Task 14/15 — add a placeholder composable now that shows the order id, replaced in Task 14).

`HomeScreen.kt`: add `route: String?` to `MenuCard`; receiving card gets `Routes.RECEIVING_LIST`; onClick navigates when route != null, else keeps the coming-soon Toast. `HomeScreen` needs an `onNavigate: (String) -> Unit` parameter wired from AppNav.

`AppContainer` factory: add `ReceivingListViewModel(receivingRepository as ReceivingListSource)` — make `ReceivingRepository : ReceivingListSource` (declare the interface in the ui package; repository opts in).

- [ ] **Step 4: Run tests + assemble**

```bash
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

- [ ] **Step 5: Commit**

```bash
git add apps/android && git commit -m "android phase1: receiving list screen + nav wiring"
```

---

## Task 14: Receiving detail — header, items tab, mismatch dialog

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/components/DetailRow.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/receiving/ReceivingDetailViewModel.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/receiving/ReceivingDetailScreen.kt`
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/receiving/ReportIssueDialog.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/navigation/AppNav.kt` (replace placeholder)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/AppContainer.kt`

Web references: `apps/web/pages/receiving/[id].vue`, `apps/web/components/receiving/` (items tab components), `apps/web/components/ReportIssueModal.vue`.

Screen behavior (items tab scope for this task):
- Header: refNo + status badge; DetailRows supplier (fallback `common_no_supplier`), delivery date, remaining items (only when `in_hand` && remaining > 0).
- "Confirm arrived" button only when status `pending`; calls `confirmArrived`, shows localized error on failure, reloads on success.
- "Put away remaining" link is Phase 3 — render nothing (no stub).
- Tabs: Receiving / Picking (`receiving_detail_tab_receiving` / `receiving_detail_tab_picking`); tab state in the ViewModel; Picking tab content arrives in Task 15 (render an empty container).
- Items tab: items grouped by invoice with a sticky-ish header `common_invoice_title` (invoiceNo). Per item: DetailRows part (`partNo`), expected (`qty`), box (`boxId`, only when non-null); an expandable section (chevron) with poLine (`po_no` / `po_line`), reserved (`allocatedQty`), picked, putAway, available (`receivedQty - pickedQty - putAwayQty - allocatedQty`), dateLotCooCow (joined `dateCode / lotCode / coo / cow`, skip nulls, `common_no_data` when all null).
- Mismatch UI per item:
  - locked when `pickedQty > 0 || putAwayQty > 0` → show `common_locked`, no actions.
  - active mismatch exists → mismatch badge (reason label via `receiving_items_tab_mismatch_*`: not_found → plain label; damaged/quality_rejection → label + qty; qty_mismatch → label + qty; over_shipment → +qty; wrong_part → wrongPartNo) + status label (`mismatch_status_*`); when status pending: if current user is the reporter → "Edit issue" button; else → "Confirm" + "Cancel" buttons (four-eyes).
  - no active mismatch → "Report issue" button.
- `ReportIssueDialog`: reason dropdown (6 reasons, `issue_reason_*` labels); qty field for all reasons except not_found (label via `issue_qty_label_<reason>`, placeholder damaged→`issue_qty_placeholder_damaged`, others→`issue_qty_placeholder_actual_received`); wrongPartNo field only for wrong_part; note field always. Confirm button validates via repository errors (display localized error text inline). Edit mode pre-fills from the active mismatch.
- After any mutation (confirm arrived / report / edit / confirm / cancel mismatch): reload detail.

`ReceivingDetailViewModel` state:

```kotlin
data class ReceivingDetailUiState(
    val loading: Boolean = true,
    val detail: ReceivingOrderDetail? = null,
    val errorKey: String? = null,
    val tab: Int = 0,
    val currentUserId: String? = null,
    val actionInProgress: Boolean = false,
)
```

VM functions: `reload()`, `setTab(Int)`, `confirmArrived()`, `reportMismatch(itemId, reason, qty, wrongPart, note)`, `editMismatch(mismatchId, ...)`, `confirmMismatch(mismatchId)`, `cancelMismatch(mismatchId)` — each sets `actionInProgress`, calls the repository, maps `LocalizedException.code` into `errorKey`, reloads. Constructor takes `orderId`, `ReceivingRepository`, `MismatchRepository`, `SessionRepository`.

- [ ] **Step 1: Write the failing ViewModel test**

`ReceivingDetailViewModelTest.kt` (fakes for the two repositories + session; `Dispatchers.setMain` pattern from Task 13):

```kotlin
@Test fun `loads detail on init`() = runTest { ... assertEquals(orderId, vm.uiState.value.detail?.id) ... }

@Test fun `confirmArrived calls repository and reloads`() = runTest {
    // fake repo records calls; after vm.confirmArrived() + advanceUntilIdle,
    // assert confirmArrived called with (orderId, actorId) and detail reloaded twice.
}

@Test fun `repository error surfaces as errorKey`() = runTest {
    // fake mismatch repo throws LocalizedException("pending_mismatch_already_exists")
    // assert uiState.errorKey == that key and actionInProgress == false
}

@Test fun `four eyes visibility - reporter sees edit, others see confirm-cancel`() = runTest {
    // detail with pending mismatch reportedBy == current user -> vm.canEditMismatch(m) == true, canReview == false
    // different user -> opposite
}
```

Include the `canEditMismatch`/`canReviewMismatch` helpers on the ViewModel (pure functions of mismatch + currentUserId) so the four-eyes rule is unit-tested without Compose.

- [ ] **Step 2: Run test to verify it fails**

```bash
./gradlew :app:testDebugUnitTest --tests "*ReceivingDetailViewModelTest"
```

- [ ] **Step 3: Write DetailRow + ViewModel + Screen + Dialog**

`DetailRow.kt`: `@Composable fun DetailRow(label: String, value: String?)` — label (caption, onSurfaceVariant) above/beside value per HomeScreen typography scale; null/empty value renders `common_no_data`.

Implement the screen per the behavior spec above, following `HomeScreen.kt` layout idioms (Scaffold + TopAppBar with back navigation via `navController.popBackStack()` wired from AppNav, Material 3 cards, `collectAsStateWithLifecycle`). `ReportIssueDialog` as an `AlertDialog`-based composable with `ExposedDropdownMenuBox` for reasons. Error text: map `errorKey` via a helper `errorMessageRes(key: String): Int?` returning `R.string.error_<key>` (resolve by name with `resources.getIdentifier("error_$key", "string", packageName)` and fall back to the raw key when missing — mirror whatever Phase 0 LoginScreen does for `invalid_username_or_password`; keep one shared helper, extracting it to `ui/components/ErrorText.kt` if LoginScreen has an inline version).

Wire `AppNav`: `composable(Routes.RECEIVING_DETAIL) { entry -> val orderId = entry.arguments!!.getString("orderId")!!; ReceivingDetailScreen(orderId = orderId, onBack = { navController.popBackStack() }) }`. `ReceivingDetailScreen` obtains its VM via `viewModel(factory = app.container.viewModelFactory)`; the factory needs the orderId — use a `ReceivingDetailViewModel.provideFactory(container, orderId)` companion factory (standard `ViewModelProvider.Factory` pattern) created in the screen, not the container.

- [ ] **Step 4: Run tests + assemble**

```bash
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

- [ ] **Step 5: Commit**

```bash
git add apps/android && git commit -m "android phase1: receiving detail items tab + mismatch dialog"
```

---

## Task 15: Picking tab + scan review dialog + scan wiring

**Files:**
- Create: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/receiving/LabelScanReviewDialog.kt`
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/receiving/ReceivingDetailViewModel.kt` (picking actions + scan state)
- Modify: `apps/android/app/src/main/java/com/docpal/warehousepda/ui/receiving/ReceivingDetailScreen.kt` (picking tab content, ScanFab, dialog wiring, hardware wedge)
- Create: `apps/android/app/src/test/java/com/docpal/warehousepda/ui/receiving/ReceivingDetailPickingTest.kt`

Web references: `apps/web/pages/receiving/[id].vue` (picking tab), `apps/web/components/LabelScanReviewModal.vue`, `apps/web/components/ScanFab.vue`, `apps/web/composables/useLabelScanReview.ts`.

Picking tab behavior:
- Rows grouped by picking order (from `detail.pickingRows`): order ref + status badge + "View picking order" is Phase 2 (render the ref as plain text, no link) + per-order box section.
- Per order: "Create box" button when order status ≠ finished (`receiving_picking_tab_create_box`, creating state). Boxes list (`boxesByOrder`): each box shows id + status badge + "Add all" button when box open AND unboxed packages exist for that order → confirm `AlertDialog` (`receiving_picking_tab_add_all_confirm` with count) → `addAllUnboxedPackagesToBox`.
- Per row (allocation): partNo, required/scanned/boxed (`requiredQty`/`scannedQty`/`boxedQty`), allocated lot info (shelfCode/boxId or `receiving_picking_tab_receiving_area` when null), date/lot/coo/cow when present, allocated qty.
- Packages (`packagesByItem` per picking item): unboxed → box selector (`select_box`, open boxes of that order only; `common_create_open_box_first` when none) + "Add to box" + "Remove scan"; boxed && box open → "Remove from box". All with confirm-free direct action except Add all.
- Per picking item: "Scan" button pins `pickingItemId` for the next scan (web `scan()` with pinned item).
- Picking logs: show/hide toggle per item (`show_logs`/`hide_logs`), entries from `transitionLogs`: `log_state_*` to-state label, actor name (fallback `common_actor_system`), timestamp formatted `yyyy-MM-dd HH:mm`.
- ScanFab: floating scan button visible only on the Picking tab; opens camera scan (Task 11 launcher) or manual entry (long-press is a web thing — Android: FAB opens camera; a secondary "Manual" text button next to FAB opens the review dialog in manual mode).
- Hardware wedge: while the detail screen is resumed and no dialog is open, key events feed `HardwareKeyBuffer` (300 ms); flush → same handling as a camera scan with `imagePath = null`. Wire at Activity level in `ReceivingDetailScreen` via `DisposableEffect` + `LocalView` key handling: use `view.setOnKeyListener`... preferred: `Modifier.onPreviewKeyEvent` on the root Scaffold — Enter and printable chars consumed per the buffer; skip when a TextField has focus (check via `LocalFocusManager`/dialog-open flag: disable buffer while `LabelScanReviewDialog` or `ReportIssueDialog` is shown).
- Scan result handling (shared by camera/hardware/manual): QR/barcode values first go through `QrParser.parseQrCapture` (templates from `ScanDao.supplierQrTemplates()`, context supplier = the order's supplier code — add a `supplierCodeOfOrder` query if needed; targets = the receiving order's part numbers), falling back to `OcrLabelParser.parseAndIdentify` when no template matches. Parsed fields pre-fill the review dialog (manual mode when the scan came from hardware wedge with no parse match... web: hardware scans open the review dialog in `manual` mode only when there is no image — match web: `mode = if (image) 'review' else 'manual'`).
- `LabelScanReviewDialog`: port of `LabelScanReviewModal.vue`:
  - modes: review (shows captured image via Coil-free `android.graphics.BitmapFactory` + `Image(bitmap)`, or `scan_review_no_image`) vs manual.
  - 6 editable fields (partNo/dateCode/lotCode/coo/cow/qty) with `CandidateChips` under each field when the parse result has >1 candidate for that field (chips set the field).
  - "Find match" (`scan_review_find_match`, matching state) → runs `ScanMatcher.matchReceiving` with the current `pickingItemId` pin.
  - Results: `scan_review_match_single` / `scan_review_match_multiple` (each rendered as "{pickingOrderRefNo} ({remainingQty} / {requiredQty})") / `scan_review_match_none`.
  - "Apply" on a chosen match → `applyOcrPick` via PickingRepository (VM) → on success: toast `common_scan_success`, close dialog, reload detail; on failure: inline error `scan_review_apply_failed` + localized error.
  - "Retake" only in review mode → relaunches camera; "Cancel" closes.
  - Multiple matches require selecting one before Apply is enabled.

VM additions: `pickingActions` — `createBox(orderId)`, `addAllToBox(boxId)`, `addPackageToBox(packageId, boxId)`, `removePackageFromBox(packageId)`, `removeScannedPackage(packageId)`, `scanPin: String?` + `pinScan(pickingItemId)`, `applyScan(match, fields)`. All reload on completion; errors → `errorKey`.

- [ ] **Step 1: Write the failing tests**

`ReceivingDetailPickingTest.kt` (fake PickingRepository + ScanMatcher; extend the Task 14 VM test doubles):

```kotlin
@Test fun `createBox delegates and reloads`() = runTest { ... }
@Test fun `addAllToBox requires confirm flag then delegates`() = runTest { ... }
@Test fun `applyScan calls applyOcrPick with match fields and reloads`() = runTest {
    // given a MatchedRecord(receiving, picking) and edited fields,
    // assert fake repo received (receivingOrderId, picking.pickingItemId, qty, dateCode, lotCode, coo, cow, actorId)
}
@Test fun `scan pin filters matcher context`() = runTest {
    // vm.pinScan("pi-1"); run findMatch; assert fake matcher saw pickingItemId == "pi-1"
}
@Test fun `hardware wedge disabled while dialog open`() = runTest {
    // vm.dialogOpen = true; vm.onHardwareScan("...") is ignored
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
./gradlew :app:testDebugUnitTest --tests "*ReceivingDetailPickingTest"
```

- [ ] **Step 3: Implement picking tab + dialog + wiring**

Implement per the behavior spec. Keep composables small: `PickingOrderSection`, `AllocationRow`, `PackageRow`, `PickingLogs`, `CandidateChips`, `LabelScanReviewDialog` in separate files under `ui/receiving/` if they exceed ~150 lines. Image loading: decode `imagePath` with `BitmapFactory.decodeFile` inside `remember { }` and show with `androidx.compose.foundation.Image` — no new dependencies.

Supplier code for QR context: add `ReceivingDao.supplierCodeOfOrder(orderId): String?` (`SELECT s.code FROM receiving_orders ro JOIN suppliers s ON s.id = ro.supplier_id WHERE ro.id = :orderId`) and expose through the repository.

- [ ] **Step 4: Run tests + assemble + lint check**

```bash
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

- [ ] **Step 5: Commit**

```bash
git add apps/android && git commit -m "android phase1: picking tab, scan review dialog, camera + wedge wiring"
```

---

## Task 16: Docs, full verification, Phase 2 handoff notes

**Files:**
- Modify: `apps/android/AGENTS.md` if present, else root `AGENTS.md` Android section (new screens, repository layer, scan pipeline entry points)
- Modify: `docs/app-docs/ai/feature-registry.md` + `docs/app-docs/ai/code-map.md` (if they track the Android app — check first; the web docs may not cover `apps/android` yet, in which case add a short Android section rather than duplicating web content)
- Modify: `docs/superpowers/plans/2026-07-12-native-android-phase-1.md` (append handoff notes section at the end)

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

Walk side by side with the web app (`pnpm dev`, login operator / DocPal2026!):
1. Login (all 3 locales via the menu switcher).
2. Receiving list: default in_hand filter, chips, search.
3. Pending order → confirm arrived → moves to in_hand; allocations appear on the picking tab if a matching pending picking order exists.
4. In_hand order → report mismatch (damaged) → received qty adjusts; second user confirm → confirmed; cancel path on another item.
5. Clear transition: consume an order fully via scans (picking tab scan flow with camera or manual entry) → order flips to clear.
6. Scan: camera scan of a label → review dialog → find match → apply → package appears; add to box; box operations; auto-finish creates measuring task (verify in DB via `adb shell run-as` or by the picking order status badge).
7. Hardware wedge scan (if a scanner is paired) — otherwise manual-entry fallback.

Record which steps were verified on device vs deferred (no device) in the handoff notes — honesty required.

- [ ] **Step 3: Update docs**

Update `AGENTS.md` Android section: repository layer (`data/` + `domain/` split, `runInTransaction` convention, `AllocationDistributor` note), new screens, scan entry points (`ScanLaunchers`, `HardwareKeyBuffer`), test conventions (`offMainThread`, seeded in-memory DB pattern). Update `docs/app-docs` AI files per the repo's documentation-system rules if they enumerate the Android app. Keep additions short; link rather than duplicate.

- [ ] **Step 4: Append Phase 2 handoff notes to this plan**

Append a `## Phase 2 handoff notes` section covering:
- What exists that Phase 2 reuses: PickingRepository (scanAllocationToPackage, box ops, maybeAutoFinish already ported), PickingDao queries, status/badge components, error-string tables, scan pipeline end to end.
- Known gaps: `materializeReceivingAllocation` usage points, put-away scans table untouched until Phase 3, `available_qty` maintenance rules (every inventory_lot write must keep `available_qty = total_qty - allocated_qty`), ViewModel factory-per-orderId pattern, wedge-vs-text-field focus handling.
- Deferred verifications from Step 2.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "android phase1: docs + handoff notes"
```

---

## Self-review checklist (completed during plan writing)

- [x] Spec coverage: Phase 1 row — list ✓ (Task 13), detail ✓ (Task 14/15), scan-to-receive ✓ (Tasks 7-11, 15), mismatches ✓ (Tasks 4-5, 14), allocation ✓ (Tasks 2, 6), clear ✓ (Tasks 3, 5, 10). Scanner exercised ✓ (Task 15). 
- [x] Web behavior sources identified for every ported function (table in header + per-task references).
- [x] SQLite dialect risks addressed (locked decisions 1-5: window functions, regex, NULLS LAST, DISTINCT ON, GREATEST/LEAST).
- [x] Error keys traced from web domain code to Task 12 string list.
- [x] Every task has failing-test-first steps, exact commands, and a commit step.
- [x] Type consistency: `AllocationDistributor.InvoiceItemRow` nullable sort fields used identically in Tasks 2, 3, 9, 10; entity class names verified against Phase 0 files; `LocalizedException(code, params)` extension scheduled in Task 1 and used consistently (`.code` accessor).

---

## Phase 2 handoff notes

Phase 1 verification (2026-07-12): `./gradlew :app:testDebugUnitTest` — 138 tests,
0 failures; `./gradlew :app:assembleDebug` and `:app:installDebug` — both
BUILD SUCCESSFUL on device `MFM5PRE526010002`. Device smoke walk recorded below.

### What Phase 2 reuses as-is

- `PickingRepository` (`domain/PickingRepository.kt`) already ports
  `scanAllocationToPackage`, `removeScannedPackage`, box ops
  (create/cancel box, pack/unpack package, add-all-unboxed) and
  `maybeAutoFinishPickingOrder` (auto-finish → measuring task). Phase 2 picking
  detail screens call these directly.
- `PickingDao` / `ScanDao` (`data/db/`) already carry the picking-tab and
  scan-candidate queries.
- UI primitives in `ui/components/`: `StatusBadge`, `DetailRow`, `ErrorText`
  (including the `errorMessage(key)` string table), `EmptyState`,
  `OnResumeEffect`.
- The end-to-end scan pipeline: `ScanLaunchers` (camera / manual / wedge) →
  `QrParser` (supplier QR templates) with `OcrLabelParser` fallback →
  `ScanMatcher` → `applyOcrPick` → `LabelScanReviewDialog`.
- Trilingual strings infrastructure (`res/values`, `values-zh-rHK`,
  `values-zh-rCN` + `LocaleManager`) guarded by `StringsParityTest` — add new
  user-facing strings to all three or the parity test fails.
- ViewModel patterns: injected `io` dispatcher, race-safe `loadJob` reload,
  `runAction` mutation serialization, `OnResumeEffect` refresh.

### Known gaps / landmines

- `removeScannedPackage` deliberately omits the `receiving_invoice_item` branch
  (unreachable in current flows — re-evaluate when put-away/returns arrive).
- `materializeReceivingAllocation` is ported but its usage points are Phase 2.
- The put-away scans table is untouched until Phase 3.
- Every `inventory_lot` write must keep `available_qty = total_qty - allocated_qty`.
- Follow the factory-per-orderId pattern (`ReceivingDetailViewModel.provideFactory`)
  for picking detail screens — do not introduce a shared singleton detail VM.
- Hardware wedge: disabled while dialogs are open; TextFields live in dialog
  windows so wedge keys never reach them; `BoxSelector` is `readOnly`.
- `seed.sql` is regenerated non-deterministically by the export script (new
  UUIDs every run) — tests must look ids up by business key, never hardcode
  UUIDs (`ReceivingRepositoryTest.partIdOf` is the pattern).
- `ScanFab` shows whenever the picking tab is loaded (the web additionally gates
  on `in_hand && remaining > 0`).
- Camera captures with an image try QR templates first before the OCR fallback
  (the web goes straight to OCR when an image is present) — deliberate per the
  Task 15 spec.
- Minor deferred review nits: `ErrorText` uses `getIdentifier` (not shrink-safe
  for release builds); duplicate `formatIsoDate` in `ReceivingListScreen` and
  `ReceivingDetailScreen`; redundant dispatcher hops in the label-scan parser
  factory; no double-tap guard on camera launch; `Calendar.getInstance()`
  default-locale in the ISO-week code (`PickingRepository`) — consider
  `Locale.US`.

### Step 2 device walkthrough — verified vs deferred

Device: `MFM5PRE526010002`, app installed via `:app:installDebug`, seeded DB.

| Walkthrough step | Result |
|------------------|--------|
| Login ×3 locales | Verified. Logged in as `operator` / `DocPal2026!` in zh-HK; home overflow menu switches locale live — English and zh-CN confirmed on the home screen, then restored to zh-HK. (Login itself performed once, in zh-HK; the locale switcher is the same component on the login screen.) |
| Receiving list: default in_hand filter, chips, search | Verified. Default `已收貨` (in_hand) chip selected, all four chips render and filter (pending chip shows EmptyState), order card with status badge + remaining/picking counts. Search field renders; text search itself not exercised (device IME duplicates `input text`, making scripted typing unreliable). |
| Pending order → confirm arrived | Deferred — seed data has no pending receiving order (only one in_hand order), so confirm-arrived could not be exercised on device. Covered by unit tests (`ReceivingRepositoryTest` / allocation tests). |
| Mismatch report + four-eyes confirm/cancel | Partially verified. `匯報問題` dialog opens from an item card (reason dropdown, remark field, cancel/confirm) and cancel dismisses it. Submit + four-eyes confirm/cancel deferred — four-eyes needs a second distinct user; covered by `MismatchRepository` unit tests. |
| Clear transition via scans | Deferred — needs a full scan-consume cycle (see camera/hardware rows below); covered by unit tests. |
| Camera scan → review dialog → find match → apply → box ops → auto-finish | Deferred — no printed supplier labels available and OCR/camera automation via adb is not practical. Picking tab itself verified (packages, line items with需求/已掃描/已裝箱, status badges, 掃描/顯示揀貨記錄 buttons, `ScanFab`, 手動輸入 entry point visible). |
| Hardware wedge | Deferred — no paired HID scanner on the device. |

Note: the web side-by-side comparison (`pnpm dev`) was not run — device-only
smoke, per task scope. One device quirk worth knowing for future adb walks: the
installed IME (Simeji) commits `adb shell input text` twice, so scripted text
entry needs a select-all/delete retry loop or typed-value verification via
screenshots.
